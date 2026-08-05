/**
 * Amp head + cabinet cluster for the chain stage.
 * Wraps the full photo-quality AmpScene (tolex, grille cloth, panel hardware)
 * in embed mode so the chain stage owns lighting/environment.
 */

import * as THREE from "three";
import { AmpScene, type Amp3dKnobSpec } from "../ampScene.js";
import type { Amp3dThemePreset } from "../ampTheme.js";
import type { ChainUnitDesc } from "../chainTypes.js";
import type { ChainUnit, ChainUnitFocusAnchor } from "./chainUnit.js";

export interface AmpRigBuildContext {
  renderer: THREE.WebGLRenderer;
}

export async function buildAmpRigUnit(
  desc: ChainUnitDesc,
  preset: Amp3dThemePreset,
  context: AmpRigBuildContext,
): Promise<ChainUnit> {
  const cabinetCount = Math.max(0, Math.min(2, desc.cabinetCount));
  const showHead = desc.showHead !== false && desc.kind !== "cab";

  const amp = await AmpScene.create(
    {
      knobs: showHead ? desc.knobs : [],
      // Brand badge stays fixed; node/model names use the panel display.
      logoText: "SOUNDSHED",
      displayText: desc.displayText || "NO MODEL LOADED",
      brandText: "Soundshed Guitar",
      bypassed: desc.bypassed,
      showCabinet: cabinetCount > 0,
      cabinetCount,
      showHead,
      embed: true,
      preset,
    },
    context.renderer,
  );

  const root = new THREE.Group();
  root.name = `AmpRig:${desc.nodeId}`;
  root.add(amp.root);

  const ampNodeId = showHead ? desc.nodeId : (desc.pairedNodeId || desc.nodeId);
  const cabNodeId = desc.pairedNodeId || desc.nodeId;

  amp.root.traverse((obj) => {
    const name = (obj.name || "").toLowerCase();
    const isCab = name.includes("cabinet") || name.includes("cab");
    obj.userData.chainNodeId = isCab && desc.pairedNodeId ? cabNodeId : ampNodeId;
    if (isCab) obj.userData.chainPickRole = "cab";
    else if (showHead) obj.userData.chainPickRole = "amp";
  });

  // Ensure power/knob targets carry node ids for chain picking.
  amp.knobHitTargets.forEach((mesh) => {
    mesh.userData.chainNodeId = ampNodeId;
    mesh.userData.knobKey = mesh.userData.knobKey || findKnobKey(mesh);
  });
  amp.powerHitTargets.forEach((mesh) => {
    mesh.userData.chainNodeId = ampNodeId;
    mesh.userData.bypassTarget = true;
  });

  const pickMeshes: THREE.Object3D[] = [];
  amp.root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) pickMeshes.push(obj);
  });

  let disposed = false;
  let highlighted = false;

  const unit: ChainUnit = {
    nodeId: desc.nodeId,
    pairedNodeId: desc.pairedNodeId,
    hostedNodeIds: Array.from(new Set([
      desc.nodeId,
      ...(desc.pairedNodeId ? [desc.pairedNodeId] : []),
    ])),
    root,
    setParams(params: Record<string, number>) {
      Object.entries(params).forEach(([key, value]) => {
        if (typeof value === "number" && Number.isFinite(value)) {
          amp.setKnobValue(key, value);
        }
      });
    },
    setKnobSpecs(next: Amp3dKnobSpec[]) {
      next.forEach((spec) => amp.setKnobValue(spec.key, spec.value));
    },
    setBypassed(bypassed: boolean) {
      amp.setBypassed(bypassed, false);
    },
    setHighlighted(active: boolean) {
      highlighted = active;
      root.position.y = active ? 0.012 : 0;
      // Soft selection rim via emissive on shared materials is avoided (shared
      // across multi-amp scenes). Lift + slight scale reads clearly.
      root.scale.setScalar(active ? 1.012 : 1);
    },
    setDisplayText(text: string) {
      amp.setDisplayText(text || "NO MODEL LOADED");
    },
    getFocusAnchor(focusNodeId?: string): ChainUnitFocusAnchor {
      root.updateMatrixWorld(true);
      const focusingCab = Boolean(
        !showHead
        || (focusNodeId
          && desc.pairedNodeId
          && focusNodeId === desc.pairedNodeId),
      );
      const mode = focusingCab ? "cab" : (showHead ? "head" : "all");
      const bounds = amp.getFocusBounds(mode);
      const position = new THREE.Vector3();
      const size = new THREE.Vector3();
      if (!bounds.isEmpty()) {
        bounds.getCenter(position);
        bounds.getSize(size);
      } else {
        root.getWorldPosition(position);
        position.y += focusingCab ? 0.35 : 0.55;
        size.set(0.6, 0.35, 0.35);
      }
      // Tight framing so head knobs stay usable; cabs get a slightly wider shot.
      const span = Math.max(size.x, size.y * (focusingCab ? 1 : 1.15), size.z);
      const fitDistance = Math.max(
        focusingCab ? 1.05 : 0.85,
        span * (focusingCab ? 1.45 : 1.25),
      );
      return { position, fitDistance, bounds: bounds.clone() };
    },
    getPickMeshes: () => pickMeshes,
    getKnobMeshes: () => amp.knobHitTargets,
    getBypassMeshes: () => amp.powerHitTargets,
    getKnobSpec(key: string) {
      return amp.getKnobSpec(key);
    },
    setKnobValue(key: string, value: number) {
      amp.setKnobValue(key, value);
    },
    update(elapsedSeconds: number) {
      amp.update(elapsedSeconds);
    },
    isAnimated() {
      return amp.isAnimated || amp.isPowerTransitioning;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      amp.dispose();
      root.clear();
    },
  };

  void highlighted;
  return unit;
}

function findKnobKey(obj: THREE.Object3D): string | undefined {
  let current: THREE.Object3D | null = obj;
  while (current) {
    if (typeof current.userData.knobKey === "string") {
      return current.userData.knobKey;
    }
    current = current.parent;
  }
  return undefined;
}
