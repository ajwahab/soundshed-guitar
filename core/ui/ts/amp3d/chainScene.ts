/**
 * Owns the Three.js scene graph for the full signal-chain stage.
 * Studio lighting / PMREM environment match the standalone Neural Amp look.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getAmp3dThemePreset, type Amp3dThemePreset } from "./ampTheme.js";
import type { ThemeName } from "../theme-switcher.js";
import {
  buildChainLayout,
  findAnchorForNode,
  findUnitForNode,
} from "./chainLayout.js";
import type { BuildChainLayoutOptions, ChainLayout } from "./chainTypes.js";
import { buildChainUnit } from "./unitRegistry.js";
import type { ChainUnit } from "./units/chainUnit.js";
import { createBackdropCanvas, createFloorFadeCanvas } from "./ampTextures.js";

export interface ChainSceneOptions {
  theme: ThemeName;
  layoutOptions: BuildChainLayoutOptions;
  renderer: THREE.WebGLRenderer;
}

function canvasTexture(
  source: HTMLCanvasElement,
  srgb = false,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class ChainScene {
  readonly root = new THREE.Group();
  readonly scene = new THREE.Scene();
  private units = new Map<string, ChainUnit>();
  private nodeToUnit = new Map<string, string>();
  private layout: ChainLayout;
  private preset: Amp3dThemePreset;
  private renderer: THREE.WebGLRenderer;
  private floor: THREE.Mesh | null = null;
  private lights: THREE.Light[] = [];
  private spotTarget: THREE.Object3D | null = null;
  private environmentTexture: THREE.Texture | null = null;
  private bgTexture: THREE.Texture | null = null;
  private disposed = false;
  private highlightedNodeId: string | null = null;

  private constructor(options: ChainSceneOptions, layout: ChainLayout) {
    this.layout = layout;
    this.preset = getAmp3dThemePreset(options.theme);
    this.renderer = options.renderer;
    this.scene.add(this.root);
  }

  static async create(options: ChainSceneOptions): Promise<ChainScene> {
    const layout = buildChainLayout(options.layoutOptions);
    const scene = new ChainScene(options, layout);
    scene.buildEnvironment();
    await scene.rebuildUnits();
    return scene;
  }

  getLayout(): ChainLayout {
    return this.layout;
  }

  getStructureSignature(): string {
    return this.layout.structureSignature;
  }

  getUnit(nodeId: string): ChainUnit | undefined {
    const primary = this.nodeToUnit.get(nodeId) ?? nodeId;
    return this.units.get(primary);
  }

  getAllUnits(): ChainUnit[] {
    return Array.from(this.units.values());
  }

  getPickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.units.forEach((unit) => {
      out.push(...unit.getPickMeshes(), ...unit.getKnobMeshes(), ...unit.getBypassMeshes());
    });
    return out;
  }

  async update(options: ChainSceneOptions): Promise<boolean> {
    this.renderer = options.renderer;
    const nextLayout = buildChainLayout(options.layoutOptions);
    const nextPreset = getAmp3dThemePreset(options.theme);
    const themeChanged = this.preset !== nextPreset;
    this.preset = nextPreset;
    const structureChanged = nextLayout.structureSignature !== this.layout.structureSignature || themeChanged;
    this.layout = nextLayout;
    if (structureChanged) {
      this.buildEnvironment();
      await this.rebuildUnits();
      return true;
    }
    this.syncLiveState();
    return false;
  }

  setHighlightedNode(nodeId: string | null): void {
    this.highlightedNodeId = nodeId;
    this.units.forEach((unit) => {
      const hosted = unit.hostedNodeIds ?? [
        unit.nodeId,
        ...(unit.pairedNodeId ? [unit.pairedNodeId] : []),
      ];
      const active = Boolean(nodeId && hosted.includes(nodeId));
      unit.setHighlighted(active, nodeId ?? undefined);
    });
  }

  setNodeParams(nodeId: string, params: Record<string, number>): void {
    this.getUnit(nodeId)?.setParams(params, nodeId);
  }

  setNodeBypassed(nodeId: string, bypassed: boolean): void {
    this.getUnit(nodeId)?.setBypassed(bypassed, nodeId);
  }

  setNodeDisplayText(nodeId: string, text: string): void {
    this.getUnit(nodeId)?.setDisplayText?.(text, nodeId);
  }

  updateUnits(elapsedSeconds: number): boolean {
    let animated = false;
    this.units.forEach((unit) => {
      unit.update?.(elapsedSeconds);
      if (unit.isAnimated?.()) animated = true;
    });
    return animated;
  }

  getFocusAnchorForNode(nodeId: string) {
    const unit = this.getUnit(nodeId);
    if (unit) return unit.getFocusAnchor(nodeId);
    const anchor = findAnchorForNode(this.layout, nodeId);
    if (!anchor) return null;
    return {
      position: new THREE.Vector3(anchor.x, 0.35, anchor.z),
      fitDistance: anchor.fitDistance,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.units.forEach((unit) => unit.dispose());
    this.units.clear();
    this.nodeToUnit.clear();
    this.disposeEnvironment();
    this.root.clear();
    this.scene.clear();
  }

  private syncLiveState(): void {
    this.layout.units.forEach((desc) => {
      const unit = this.units.get(desc.nodeId);
      if (!unit) return;
      if (desc.stack?.length) {
        desc.stack.forEach((slot) => {
          unit.setBypassed(slot.bypassed, slot.nodeId);
          unit.setParams(
            Object.fromEntries(slot.knobs.map((k) => [k.key, k.value])),
            slot.nodeId,
          );
          unit.setDisplayText?.(slot.displayText, slot.nodeId);
          unit.setKnobSpecs?.(slot.knobs, slot.nodeId);
        });
      } else {
        unit.setBypassed(desc.bypassed);
        unit.setParams(Object.fromEntries(desc.knobs.map((k) => [k.key, k.value])));
        unit.setDisplayText?.(desc.displayText);
        unit.setKnobSpecs?.(desc.knobs);
      }
    });
    this.setHighlightedNode(this.highlightedNodeId);
  }

  private async rebuildUnits(): Promise<void> {
    this.units.forEach((unit) => unit.dispose());
    this.units.clear();
    this.nodeToUnit.clear();
    this.root.clear();

    const anchorById = new Map(this.layout.anchors.map((a) => [a.nodeId, a]));
    const context = { renderer: this.renderer };
    for (const desc of this.layout.units) {
      const unit = await buildChainUnit(desc, this.preset, context);
      const anchor = anchorById.get(desc.nodeId);
      if (anchor) {
        // Stacks use local Y for slots; world anchor Y stays on the floor.
        unit.root.position.set(anchor.x, 0, anchor.z);
      }
      this.root.add(unit.root);
      this.units.set(desc.nodeId, unit);
      const hosted = desc.stack?.map((s) => s.nodeId) ?? [desc.nodeId];
      hosted.forEach((id) => this.nodeToUnit.set(id, desc.nodeId));
      if (desc.pairedNodeId) {
        this.nodeToUnit.set(desc.pairedNodeId, desc.nodeId);
      }
    }
    this.setHighlightedNode(this.highlightedNodeId);
  }

  private buildEnvironment(): void {
    this.disposeEnvironment();

    // Backdrop gradient (same canvas path as standalone amp view).
    const bgCanvas = createBackdropCanvas(
      `#${new THREE.Color(this.preset.backgroundTop).getHexString()}`,
      `#${new THREE.Color(this.preset.backgroundBottom).getHexString()}`,
    );
    this.bgTexture = canvasTexture(bgCanvas, true);
    this.scene.background = this.bgTexture;

    // Soft reflective floor with radial fade.
    const floorGeo = new THREE.PlaneGeometry(18, 18);
    const floorMat = new THREE.MeshStandardMaterial({
      color: this.preset.floorColor,
      roughness: 0.42,
      metalness: 0.05,
      transparent: true,
      alphaMap: canvasTexture(createFloorFadeCanvas()),
      depthWrite: false,
    });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.001;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    // PMREM room environment for photo-real metal/tolex response.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = new RoomEnvironment();
    this.environmentTexture = pmrem.fromScene(environment, 0.04).texture;
    this.scene.environment = this.environmentTexture;
    this.scene.environmentIntensity = this.preset.environmentIntensity;
    environment.dispose?.();
    pmrem.dispose();

    const ambient = new THREE.HemisphereLight(
      this.preset.ambientColor,
      0x101012,
      this.preset.ambientIntensity,
    );
    this.scene.add(ambient);
    this.lights.push(ambient);

    const key = new THREE.DirectionalLight(this.preset.key.color, this.preset.key.intensity);
    key.position.set(...this.preset.key.position);
    key.castShadow = false;
    this.scene.add(key);
    this.lights.push(key);

    const fill = new THREE.DirectionalLight(this.preset.fill.color, this.preset.fill.intensity);
    fill.position.set(...this.preset.fill.position);
    this.scene.add(fill);
    this.lights.push(fill);

    const rim = new THREE.DirectionalLight(this.preset.rim.color, this.preset.rim.intensity);
    rim.position.set(...this.preset.rim.position);
    this.scene.add(rim);
    this.lights.push(rim);

    const spot = new THREE.SpotLight(
      this.preset.spot.color,
      this.preset.spot.intensity,
      this.preset.spot.distance,
      this.preset.spot.angle,
      this.preset.spot.penumbra,
      this.preset.spot.decay,
    );
    spot.name = "ChainPanelSpot";
    spot.position.set(...this.preset.spot.position);
    this.spotTarget = new THREE.Object3D();
    this.spotTarget.position.set(...this.preset.spot.target);
    spot.target = this.spotTarget;
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.camera.near = 0.15;
    spot.shadow.camera.far = Math.max(4, this.preset.spot.distance);
    spot.shadow.bias = -0.00035;
    spot.shadow.normalBias = 0.018;
    spot.shadow.radius = 2.5;
    this.scene.add(spot);
    this.scene.add(this.spotTarget);
    this.lights.push(spot);

    // Center chain on origin for nicer framing.
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    this.root.position.set(-cx, 0, -cz);

    // Aim the practical at the chain centre so knobs still catch grazes.
    this.spotTarget.position.set(0, 0.45, 0);
    spot.position.set(1.1, 1.8, 2.2);
  }

  private disposeEnvironment(): void {
    if (this.floor) {
      this.floor.geometry.dispose();
      const mat = this.floor.material as THREE.MeshStandardMaterial;
      mat.alphaMap?.dispose();
      mat.dispose();
      this.scene.remove(this.floor);
      this.floor = null;
    }
    this.lights.forEach((light) => this.scene.remove(light));
    this.lights = [];
    if (this.spotTarget) {
      this.scene.remove(this.spotTarget);
      this.spotTarget = null;
    }
    if (this.bgTexture) {
      this.bgTexture.dispose();
      this.bgTexture = null;
    }
    if (this.environmentTexture) {
      this.environmentTexture.dispose();
      this.environmentTexture = null;
    }
    this.scene.background = null;
    this.scene.environment = null;
  }
}

export { findUnitForNode, findAnchorForNode };
