/**
 * Renderer, camera and pointer interaction for the Neural Amp 3D view.
 *
 * Rendering is on-demand: a frame is only drawn when something actually
 * changes (a knob moves, the theme changes, the panel resizes, the pointer
 * hovers a control). That keeps the view cheap enough to sit inside the effect
 * panel of a real-time audio app.
 */

import * as THREE from "three";

import { AmpScene, type Amp3dKnobSpec, type Amp3dSceneOptions } from "./ampScene.js";
import { dragToValue, formatKnobValue } from "./ampLayout.js";
import { isWebglSupported } from "./ampSupport.js";
import { getAmp3dThemePreset, type Amp3dThemePreset } from "./ampTheme.js";
import type { ThemeName } from "../theme-switcher.js";

export interface Amp3dViewOptions {
  knobs: Amp3dKnobSpec[];
  logoText: string;
  displayText: string;
  brandText: string;
  bypassed: boolean;
  showCabinet: boolean;
  theme: ThemeName;
  /** Called continuously while a knob is dragged. */
  onParamChange: (key: string, value: number) => void;
  /** Called once when a knob drag finishes. */
  onParamCommit?: (key: string, value: number) => void;
  onBypassToggle: () => void;
}

/** Signature of the properties that require a full scene rebuild when changed. */
function structureSignature(options: Amp3dViewOptions): string {
  return [
    options.theme,
    options.showCabinet ? "cab" : "head",
    options.logoText,
    options.brandText,
    options.knobs.map((knob) => `${knob.key}:${knob.label}:${knob.min}:${knob.max}`).join(","),
  ].join("|");
}

export function isWebglAvailable(): boolean {
  return isWebglSupported();
}

const MIN_ZOOM = 0.62;
const MAX_ZOOM = 1.35;
const MAX_AZIMUTH = 0.42;
const MIN_POLAR = -0.16;
const MAX_POLAR = 0.34;
/** Pointer travel (px) below which a press counts as a click, not an orbit. */
const CLICK_SLOP_PX = 4;

export class Amp3dView {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly status: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;

  private ampScene: AmpScene | null = null;
  private options: Amp3dViewOptions;
  private preset: Amp3dThemePreset;
  private signature: string;

  private frameHandle = 0;
  private disposed = false;
  private visible = true;

  private cameraTarget = new THREE.Vector3();
  private cameraDistance = 2;
  private azimuth = 0;
  private polar = 0.06;
  private zoom = 1;

  private activeKnob: { key: string; startValue: number; startY: number; pointerId: number } | null = null;
  private orbitPointer: { id: number; x: number; y: number; moved: number } | null = null;

  private constructor(container: HTMLElement, options: Amp3dViewOptions) {
    this.options = options;
    this.preset = getAmp3dThemePreset(options.theme);
    this.signature = structureSignature(options);

    this.element = document.createElement("div");
    this.element.className = "amp3d-view";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "amp3d-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute(
      "aria-label",
      "Interactive 3D amplifier. Drag a knob vertically to change its value, click the power switch to bypass.",
    );
    this.element.appendChild(this.canvas);

    this.overlay = document.createElement("div");
    this.overlay.className = "amp3d-readout";
    this.overlay.hidden = true;
    this.element.appendChild(this.overlay);

    // Screen-reader mirror of the current control values.
    this.status = document.createElement("div");
    this.status.className = "amp3d-sr-only";
    this.status.setAttribute("aria-live", "polite");
    this.element.appendChild(this.status);

    container.appendChild(this.element);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.preset.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.element);

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
  }

  static async create(container: HTMLElement, options: Amp3dViewOptions): Promise<Amp3dView> {
    const view = new Amp3dView(container, options);
    try {
      await view.buildScene();
    } catch (error) {
      view.dispose();
      throw error;
    }
    return view;
  }

  private async buildScene(): Promise<void> {
    const sceneOptions: Amp3dSceneOptions = {
      knobs: this.options.knobs.map((knob) => ({ ...knob })),
      logoText: this.options.logoText,
      displayText: this.options.displayText,
      brandText: this.options.brandText,
      bypassed: this.options.bypassed,
      showCabinet: this.options.showCabinet,
      preset: this.preset,
    };
    const next = await AmpScene.create(sceneOptions, this.renderer);
    if (this.disposed) {
      next.dispose();
      return;
    }
    this.ampScene?.dispose();
    this.ampScene = next;
    this.frameCamera();
    this.handleResize();
    this.updateStatusText();
    this.requestRender();
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  private frameCamera(): void {
    if (!this.ampScene) {
      return;
    }
    const bounds = this.ampScene.getFocusBounds();
    if (bounds.isEmpty()) {
      return;
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bounds.getSize(size);
    bounds.getCenter(center);

    this.cameraTarget.copy(center);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fitHeight = size.y / (2 * Math.tan(fov / 2));
    const fitWidth = size.x / (2 * Math.tan(fov / 2) * Math.max(0.5, this.camera.aspect));
    this.cameraDistance = Math.max(fitHeight, fitWidth) * 1.2 + size.z * 0.5;
  }

  private updateCamera(): void {
    const distance = this.cameraDistance * this.zoom;
    const x = Math.sin(this.azimuth) * Math.cos(this.polar) * distance;
    const y = Math.sin(this.polar) * distance;
    const z = Math.cos(this.azimuth) * Math.cos(this.polar) * distance;
    this.camera.position.set(
      this.cameraTarget.x + x,
      this.cameraTarget.y + y,
      this.cameraTarget.z + z,
    );
    this.camera.lookAt(this.cameraTarget);
  }

  private handleResize = (): void => {
    if (this.disposed) {
      return;
    }
    const width = Math.max(1, Math.round(this.element.clientWidth));
    const height = Math.max(1, Math.round(this.element.clientHeight));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.frameCamera();
    this.requestRender();
  };

  // ── Rendering ────────────────────────────────────────────────────────────

  requestRender(): void {
    if (this.disposed || this.frameHandle !== 0 || !this.visible) {
      return;
    }
    this.frameHandle = window.requestAnimationFrame(() => {
      this.frameHandle = 0;
      this.renderFrame();
    });
  }

  private renderFrame(): void {
    if (this.disposed || !this.ampScene) {
      return;
    }
    this.updateCamera();
    this.renderer.toneMappingExposure = this.preset.exposure;
    this.renderer.render(this.ampScene.scene, this.camera);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.requestRender();
    }
  }

  // ── Interaction ──────────────────────────────────────────────────────────

  private updatePointer(event: PointerEvent | WheelEvent | MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
  }

  private pickKnobKey(): string | null {
    if (!this.ampScene) {
      return null;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.ampScene.knobHitTargets, false);
    const key = hits[0]?.object?.userData?.knobKey;
    return typeof key === "string" ? key : null;
  }

  private pickPowerSwitch(): boolean {
    if (!this.ampScene) {
      return false;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.ampScene.powerHitTargets, false).length > 0;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.ampScene) {
      return;
    }
    this.updatePointer(event);

    const knobKey = this.pickKnobKey();
    if (knobKey) {
      const spec = this.ampScene.getKnobSpec(knobKey);
      if (!spec) {
        return;
      }
      event.preventDefault();
      this.capturePointer(event.pointerId);
      this.activeKnob = {
        key: knobKey,
        startValue: spec.value,
        startY: event.clientY,
        pointerId: event.pointerId,
      };
      this.showReadout(spec);
      return;
    }

    this.orbitPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 };
    this.capturePointer(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.ampScene) {
      return;
    }

    if (this.activeKnob && event.pointerId === this.activeKnob.pointerId) {
      const spec = this.ampScene.getKnobSpec(this.activeKnob.key);
      if (!spec) {
        return;
      }
      const value = dragToValue({
        startValue: this.activeKnob.startValue,
        deltaPixels: this.activeKnob.startY - event.clientY,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        fine: event.shiftKey,
      });
      if (value !== spec.value) {
        this.ampScene.setKnobValue(this.activeKnob.key, value);
        this.options.onParamChange(this.activeKnob.key, value);
        this.showReadout(spec);
        this.updateStatusText();
        this.requestRender();
      }
      return;
    }

    if (this.orbitPointer && event.pointerId === this.orbitPointer.id) {
      const dx = event.clientX - this.orbitPointer.x;
      const dy = event.clientY - this.orbitPointer.y;
      this.orbitPointer.moved += Math.abs(dx) + Math.abs(dy);
      this.orbitPointer.x = event.clientX;
      this.orbitPointer.y = event.clientY;
      this.azimuth = Math.max(-MAX_AZIMUTH, Math.min(MAX_AZIMUTH, this.azimuth + dx * 0.004));
      this.polar = Math.max(MIN_POLAR, Math.min(MAX_POLAR, this.polar + dy * 0.003));
      this.requestRender();
      return;
    }

    this.updatePointer(event);
    const hovering = Boolean(this.pickKnobKey()) || this.pickPowerSwitch();
    this.canvas.style.cursor = hovering ? "grab" : "default";
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.activeKnob && event.pointerId === this.activeKnob.pointerId) {
      const spec = this.ampScene?.getKnobSpec(this.activeKnob.key);
      if (spec) {
        this.options.onParamCommit?.(this.activeKnob.key, spec.value);
      }
      this.activeKnob = null;
      this.hideReadout();
      this.releasePointer(event.pointerId);
      return;
    }

    if (this.orbitPointer && event.pointerId === this.orbitPointer.id) {
      const wasClick = this.orbitPointer.moved <= CLICK_SLOP_PX;
      this.orbitPointer = null;
      this.releasePointer(event.pointerId);
      if (wasClick) {
        this.updatePointer(event);
        if (this.pickPowerSwitch()) {
          this.options.onBypassToggle();
        }
      }
    }
  };

  private capturePointer(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort; interaction still works without it.
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture is best-effort; ignore browsers that already released it.
    }
  }

  private handleWheel = (event: WheelEvent): void => {
    if (!this.ampScene) {
      return;
    }
    this.updatePointer(event);
    const knobKey = this.pickKnobKey();
    if (knobKey) {
      const spec = this.ampScene.getKnobSpec(knobKey);
      if (!spec) {
        return;
      }
      event.preventDefault();
      const increment = spec.step && spec.step > 0 ? spec.step : (spec.max - spec.min) / 50;
      const value = dragToValue({
        startValue: spec.value,
        deltaPixels: 0,
        min: spec.min,
        max: spec.max,
        step: spec.step,
      }) + (event.deltaY < 0 ? increment : -increment);
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      this.ampScene.setKnobValue(knobKey, clamped);
      this.options.onParamChange(knobKey, clamped);
      this.options.onParamCommit?.(knobKey, clamped);
      this.showReadout(spec);
      window.setTimeout(() => this.hideReadout(), 900);
      this.updateStatusText();
      this.requestRender();
      return;
    }

    event.preventDefault();
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * (event.deltaY > 0 ? 1.08 : 0.93)));
    this.requestRender();
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (!this.ampScene) {
      return;
    }
    this.updatePointer(event);
    const knobKey = this.pickKnobKey();
    if (!knobKey) {
      // Double-clicking the background resets the camera.
      this.azimuth = 0;
      this.polar = 0.06;
      this.zoom = 1;
      this.requestRender();
      return;
    }
    const spec = this.ampScene.getKnobSpec(knobKey);
    if (!spec || typeof spec.defaultValue !== "number") {
      return;
    }
    const value = Math.min(spec.max, Math.max(spec.min, spec.defaultValue));
    this.ampScene.setKnobValue(knobKey, value);
    this.options.onParamChange(knobKey, value);
    this.options.onParamCommit?.(knobKey, value);
    this.updateStatusText();
    this.requestRender();
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.element.classList.add("amp3d-context-lost");
    this.status.textContent = "3D view unavailable: the graphics context was lost.";
  };

  private showReadout(spec: Amp3dKnobSpec): void {
    const current = this.ampScene?.getKnobSpec(spec.key) ?? spec;
    this.overlay.hidden = false;
    this.overlay.textContent = `${current.label} ${formatKnobValue(current.value, current.unit)}`;
  }

  private hideReadout(): void {
    this.overlay.hidden = true;
  }

  private updateStatusText(): void {
    if (!this.ampScene) {
      return;
    }
    const summary = this.options.knobs
      .map((knob) => {
        const spec = this.ampScene?.getKnobSpec(knob.key) ?? knob;
        return `${spec.label} ${formatKnobValue(spec.value, spec.unit)}`;
      })
      .join(", ");
    this.status.textContent = `${this.options.bypassed ? "Bypassed" : "Active"}. ${summary}`;
  }

  // ── Updates ──────────────────────────────────────────────────────────────

  /**
   * Applies new state from the effect panel. Values, bypass state and the
   * display text update in place; anything that changes the physical layout
   * (theme, cabinet, knob set) rebuilds the scene.
   */
  async update(options: Amp3dViewOptions): Promise<void> {
    if (this.disposed) {
      return;
    }
    const nextSignature = structureSignature(options);
    const themeChanged = options.theme !== this.options.theme;
    this.options = options;
    this.preset = getAmp3dThemePreset(options.theme);

    if (nextSignature !== this.signature || themeChanged) {
      this.signature = nextSignature;
      await this.buildScene();
      return;
    }

    options.knobs.forEach((knob) => this.ampScene?.setKnobValue(knob.key, knob.value));
    this.ampScene?.setBypassed(options.bypassed);
    this.ampScene?.setDisplayText(options.displayText);
    this.updateStatusText();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.frameHandle !== 0) {
      window.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.ampScene?.dispose();
    this.ampScene = null;
    this.renderer.dispose();
    this.element.remove();
  }
}
