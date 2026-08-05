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
const MIN_POLAR = -0.08;
const MAX_POLAR = 0.42;
/** Default orbit pitch: high enough to look down on the amp head slightly. */
const DEFAULT_POLAR = 0.2;
/** Pointer travel (px) below which a press counts as a click, not an orbit. */
const CLICK_SLOP_PX = 4;
/**
 * Idle animation (display marquee) is capped well below display refresh:
 * this view shares a machine with a real-time audio engine. 15 fps is enough
 * for a slow LCD scroll and halves GPU time vs a 30 fps continuous loop.
 */
const ANIMATION_FRAME_MS = 1000 / 15;
/** Power on/off light ramps need a smoother cadence than idle marquee. */
const POWER_TRANSITION_FRAME_MS = 1000 / 30;
/** Cap backing-store resolution; full retina 2× is wasteful for this panel. */
const MAX_PIXEL_RATIO = 1.5;
/** Slack added around the fitted bounds so the amp never touches the edges. */
const CAMERA_FIT_MARGIN = 1.2;
/**
 * Extra headroom above the model. The fit is computed from an axis-aligned box
 * at the focus centre, but the top of the head is nearer the camera than that
 * centre and the camera is tilted slightly down, so the top edge projects
 * higher than the box maths predicts and would otherwise clip.
 */
const CAMERA_TOP_HEADROOM = 0.02;
/**
 * Fraction of framed height used to drop the look-at point so the amp head sits
 * higher in the viewport (camera effectively aims a little lower).
 */
const CAMERA_LOOK_DOWN_BIAS = 0.08;
/**
 * How much of the dock's height the camera actually keeps clear. The dock is
 * translucent and is meant to sit over the base of the cabinet, so reserving
 * all of it would push the amp needlessly small on short windows.
 */
const BOTTOM_INSET_RESERVE = 0.6;
/** The floating control dock may never eat more than this much of the frame. */
const MAX_BOTTOM_INSET = 0.3;

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
    /** True when `frameHandle` is a `setTimeout` id (animation pacing), not rAF. */
    private frameHandleIsTimeout = false;
    private disposed = false;
    /** Host panel wants the view shown (independent of tab visibility). */
    private viewVisible = true;
    /** Document tab/window is visible. */
    private pageVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
    /** Scene content changed and needs at least one draw. */
    private dirty = true;
    /** Camera orbit/zoom/fit changed since the last `updateCamera()`. */
    private cameraDirty = true;
    /** Shadow map must be regenerated (scene rebuild / rare geometry change). */
    private shadowsDirty = true;
    private readonly startTime = (typeof performance !== "undefined" ? performance.now() : Date.now());
    private lastAnimationFrame = Number.NEGATIVE_INFINITY;
    private readonly reducedMotion: MediaQueryList | null =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    private readonly onVisibilityChange = (): void => {
      if (typeof document === "undefined") {
        return;
      }
      this.pageVisible = document.visibilityState !== "hidden";
      this.syncVisibility();
    };

  private cameraTarget = new THREE.Vector3();
  /** Centre of the framed content, before the bottom-dock offset is applied. */
  private focusCenter = new THREE.Vector3();
  /** Fraction of the viewport height hidden behind the floating control dock. */
  private bottomInset = 0;
  private cameraDistance = 2;
  private azimuth = 0;
  private polar = DEFAULT_POLAR;
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

        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        // MSAA is expensive; on HiDPI the extra samples are rarely visible after
        // downsampling, so only enable antialias when the backing store is 1×.
        this.renderer = new THREE.WebGLRenderer({
          canvas: this.canvas,
          antialias: pixelRatio <= 1,
          alpha: false,
          powerPreference: "low-power",
        });
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.shadowMap.enabled = true;
        // PCF soft is roughly 2–4× the shadow filter cost of basic PCF.
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        // Key light and static geometry rarely move; rebuild shadows on demand so
        // the powered-on marquee loop is a colour pass only.
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = true;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = this.preset.exposure;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.resizeObserver = new ResizeObserver(() => this.handleResize());
        this.resizeObserver.observe(this.element);
        // The floating control dock overlaps the render; when it reflows (controls
        // wrapping onto another row) the camera has to re-frame around it.
        const dock = container.closest(".amp3d-stage")?.querySelector(".amp3d-dock");
        if (dock instanceof HTMLElement) {
          this.resizeObserver.observe(dock);
        }

        this.canvas.addEventListener("pointerdown", this.handlePointerDown);
        this.canvas.addEventListener("pointermove", this.handlePointerMove);
        this.canvas.addEventListener("pointerup", this.handlePointerUp);
        this.canvas.addEventListener("pointercancel", this.handlePointerUp);
        this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
        this.canvas.addEventListener("dblclick", this.handleDoubleClick);
        this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
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
        this.shadowsDirty = true;
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

    // Grow the box upwards only, then re-centre: the extra space has to end up
    // above the head, not split evenly above and below it.
    const headroom = size.y * CAMERA_TOP_HEADROOM;
    size.y += headroom;
    center.y += headroom / 2;

    this.bottomInset = this.measureBottomInset();
    this.focusCenter.copy(center);

    const tanHalfFov = Math.tan(((this.camera.fov * Math.PI) / 180) / 2);
    // The dock covers the bottom of the frame, so the model has to fit in the
    // remaining band rather than in the full viewport height.
    const usableHeight = Math.max(0.5, 1 - this.bottomInset);
    const fitHeight = size.y / (2 * tanHalfFov * usableHeight);
    const fitWidth = size.x / (2 * tanHalfFov * Math.max(0.5, this.camera.aspect));
    this.cameraDistance = Math.max(fitHeight, fitWidth) * CAMERA_FIT_MARGIN + size.z * 0.5;
        this.cameraDirty = true;
      }

  /**
   * Height of the floating control dock as a fraction of the viewport, so the
   * camera can keep the amp clear of it. Returns 0 when there is no dock (the
   * view is embedded elsewhere, or the controls have not been rendered yet).
   */
  private measureBottomInset(): number {
    const viewportHeight = this.element.clientHeight;
    if (viewportHeight <= 0) {
      return 0;
    }
    const dock = this.element.closest(".amp3d-stage")?.querySelector(".amp3d-dock");
    if (!(dock instanceof HTMLElement)) {
      return 0;
    }
    // The dock is anchored a few pixels clear of the viewport edge; that gap is
    // part of the band the amp must avoid.
    const stageBottom = this.element.getBoundingClientRect().bottom;
    const covered = stageBottom - dock.getBoundingClientRect().top;
    if (!Number.isFinite(covered) || covered <= 0) {
      return 0;
    }
    return Math.min(MAX_BOTTOM_INSET, (covered / viewportHeight) * BOTTOM_INSET_RESERVE);
  }

  private updateCamera(): void {
    const distance = this.cameraDistance * this.zoom;
    // Push the framed content up out of the band the dock covers by aiming the
    // camera below its centre. Recomputed here (not in frameCamera) so zooming
    // keeps the same clearance. An extra look-down bias keeps the head high in
    // frame while the orbit pitch looks slightly down onto the control panel.
    const tanHalfFov = Math.tan(((this.camera.fov * Math.PI) / 180) / 2);
    const worldHeight = 2 * distance * tanHalfFov;
    const framedHeight = worldHeight * Math.max(0.5, 1 - this.bottomInset);
    this.cameraTarget.set(
      this.focusCenter.x,
      this.focusCenter.y
        - (worldHeight * this.bottomInset) / 2
        - framedHeight * CAMERA_LOOK_DOWN_BIAS,
      this.focusCenter.z,
    );
    const x = Math.sin(this.azimuth) * Math.cos(this.polar) * distance;
    // Drop the orbit pivot a little so the camera sits lower while still
    // pitching down onto the head (positive polar).
    const y = Math.sin(this.polar) * distance - framedHeight * 0.04;
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

    private isEffectivelyVisible(): boolean {
      return this.viewVisible && this.pageVisible;
    }

    /**
     * Marks the view dirty and ensures a draw is scheduled. Continuous powered-on
     * animation is paced with `setTimeout` so we do not wake on every display
     * refresh just to decide the marquee is not due yet.
     */
    requestRender(): void {
      if (this.disposed || !this.isEffectivelyVisible()) {
        this.dirty = true;
        return;
      }
      this.dirty = true;
      this.ensureFrame();
    }

    private clearFrameHandle(): void {
      if (this.frameHandle === 0) {
        return;
      }
      if (this.frameHandleIsTimeout) {
        window.clearTimeout(this.frameHandle);
      } else {
        window.cancelAnimationFrame(this.frameHandle);
      }
      this.frameHandle = 0;
      this.frameHandleIsTimeout = false;
    }

    private ensureFrame(): void {
      if (this.disposed || this.frameHandle !== 0 || !this.isEffectivelyVisible()) {
        return;
      }
      this.frameHandleIsTimeout = false;
      this.frameHandle = window.requestAnimationFrame((time) => {
        this.frameHandle = 0;
        this.renderFrame(time);
      });
    }

    private scheduleAnimation(delayMs: number): void {
      if (this.disposed || this.frameHandle !== 0 || !this.isEffectivelyVisible()) {
        return;
      }
      this.frameHandleIsTimeout = true;
      this.frameHandle = window.setTimeout(() => {
        this.frameHandle = 0;
        this.frameHandleIsTimeout = false;
        this.ensureFrame();
      }, Math.max(0, delayMs)) as unknown as number;
    }

    /**
       * True while the amp has motion worth drawing: a power ramp, idle marquee
       * (when enabled), on screen, and the user has not asked for reduced motion.
       */
      private shouldAnimate(): boolean {
        return !this.disposed
          && this.isEffectivelyVisible()
          && (this.ampScene?.isAnimated ?? false)
          && !(this.reducedMotion?.matches ?? false);
      }

      private animationFrameBudgetMs(): number {
        return this.ampScene?.isPowerTransitioning
          ? POWER_TRANSITION_FRAME_MS
          : ANIMATION_FRAME_MS;
      }

      private renderFrame(time?: number): void {
        if (this.disposed || !this.ampScene || !this.isEffectivelyVisible()) {
          return;
        }

        const now = time ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
        const animating = this.shouldAnimate();
        const frameBudget = this.animationFrameBudgetMs();
        const animationDue = animating && now - this.lastAnimationFrame >= frameBudget;

        if (animationDue) {
          this.lastAnimationFrame = now;
          this.ampScene.update((now - this.startTime) / 1000);
          this.dirty = true;
        } else if (this.dirty && !animating) {
          // Reduced motion / static: hold the resting pose (no time advance).
          this.ampScene.update((now - this.startTime) / 1000);
        } else if (this.dirty && animating) {
          // Interaction frame between animation ticks — still advance time so
          // power ramps and marquee stay in lockstep with the pointer.
          this.ampScene.update((now - this.startTime) / 1000);
          this.lastAnimationFrame = now;
        }

        if (this.dirty) {
          this.dirty = false;
          if (this.cameraDirty) {
            this.updateCamera();
            this.cameraDirty = false;
          }
          if (this.shadowsDirty) {
            this.renderer.shadowMap.needsUpdate = true;
          this.shadowsDirty = false;
        }
        this.renderer.toneMappingExposure = this.preset.exposure;
        this.renderer.render(this.ampScene.scene, this.camera);
      }

      if (animating) {
            const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now())
              - this.lastAnimationFrame;
            this.scheduleAnimation(this.animationFrameBudgetMs() - elapsed);
          } else if (this.dirty) {
            this.ensureFrame();
          }
        }

    private syncVisibility(): void {
      if (!this.isEffectivelyVisible()) {
        this.clearFrameHandle();
        return;
      }
      this.requestRender();
    }

    setVisible(visible: boolean): void {
      if (this.viewVisible === visible) {
        if (visible) {
          this.requestRender();
        }
        return;
      }
      this.viewVisible = visible;
      this.syncVisibility();
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
            this.cameraDirty = true;
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
          // Knobs cast; refresh the shadow map once the drag settles.
          this.shadowsDirty = true;
          this.requestRender();
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
            this.shadowsDirty = true;
            this.requestRender();
            return;
    }

    event.preventDefault();
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * (event.deltaY > 0 ? 1.08 : 0.93)));
        this.cameraDirty = true;
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
      this.polar = DEFAULT_POLAR;
      this.zoom = 1;
            this.cameraDirty = true;
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
        this.shadowsDirty = true;
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
   * Drives the grille glow from the node's smoothed output peak.
   * `level` is 0..1 (already averaged / normalised by the host UI).
   */
  setSignalLevel(level: number): void {
    if (this.disposed || !this.ampScene) {
      return;
    }
      if (this.ampScene.setSignalLevel(level)) {
        this.requestRender();
      }
    }

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
      const bypassBefore = this.options.bypassed;
      this.options = options;
      this.preset = getAmp3dThemePreset(options.theme);

      if (nextSignature !== this.signature || themeChanged) {
        this.signature = nextSignature;
        await this.buildScene();
        return;
      }

      options.knobs.forEach((knob) => this.ampScene?.setKnobValue(knob.key, knob.value));
          const immediatePower = this.reducedMotion?.matches ?? false;
          this.ampScene?.setBypassed(options.bypassed, immediatePower);
          // Power switch moves with bypass; refresh shadows when the lever settles
          // (immediate snap) or at the start of a timed ramp.
          if (bypassBefore !== options.bypassed) {
            this.shadowsDirty = true;
          }
          this.ampScene?.setDisplayText(options.displayText);
          this.updateStatusText();
          this.requestRender();
        }

    dispose(): void {
      if (this.disposed) {
        return;
      }
      this.disposed = true;
      this.clearFrameHandle();
      this.resizeObserver.disconnect();
      this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
      this.canvas.removeEventListener("pointermove", this.handlePointerMove);
      this.canvas.removeEventListener("pointerup", this.handlePointerUp);
      this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
      this.canvas.removeEventListener("wheel", this.handleWheel);
      this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
      this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
      }
      this.ampScene?.dispose();
      this.ampScene = null;
      this.renderer.dispose();
      this.element.remove();
    }
  }
