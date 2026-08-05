/**
 * Small junction marker for splitter / mixer nodes.
 */

import * as THREE from "three";
import type { Amp3dKnobSpec } from "../ampScene.js";
import type { Amp3dThemePreset } from "../ampTheme.js";
import type { ChainUnitDesc } from "../chainTypes.js";
import type { ChainUnit, ChainUnitFocusAnchor } from "./chainUnit.js";
import { createUnitMaterials, disposeMaterials, makeLabelTexture } from "./unitCommon.js";

export async function buildJunctionUnit(
  desc: ChainUnitDesc,
  preset: Amp3dThemePreset,
): Promise<ChainUnit> {
  const root = new THREE.Group();
  root.name = `Junction:${desc.nodeId}`;
  const geometries = new Set<THREE.BufferGeometry>();
  const textures: THREE.Texture[] = [];
  const materials = createUnitMaterials(preset, 0x6b7280);

  const geo = new THREE.BoxGeometry(0.12, 0.06, 0.12);
  geometries.add(geo);
  const body = new THREE.Mesh(geo, materials.metal);
  body.position.y = 0.38;
  body.castShadow = true;
  body.userData.chainNodeId = desc.nodeId;
  root.add(body);

  const labelTex = makeLabelTexture(desc.label || "J", { width: 128, height: 64 });
  textures.push(labelTex);
  materials.label.map = labelTex;
  const labelGeo = new THREE.PlaneGeometry(0.1, 0.03);
  geometries.add(labelGeo);
  const label = new THREE.Mesh(labelGeo, materials.label);
  label.position.set(0, 0.42, 0.062);
  label.userData.chainNodeId = desc.nodeId;
  root.add(label);

  let disposed = false;

  return {
    nodeId: desc.nodeId,
    root,
    setParams() {},
    setKnobSpecs(_knobs: Amp3dKnobSpec[]) {},
    setBypassed(bypassed: boolean) {
      materials.metal.opacity = bypassed ? 0.55 : 1;
      materials.metal.transparent = bypassed;
    },
    setHighlighted(active: boolean) {
      materials.metal.emissive = new THREE.Color(active ? 0x335577 : 0x000000);
      materials.metal.emissiveIntensity = active ? 0.25 : 0;
      root.position.y = active ? 0.02 : 0;
    },
    getFocusAnchor(): ChainUnitFocusAnchor {
      const position = new THREE.Vector3();
      body.getWorldPosition(position);
      return { position, fitDistance: 0.8 };
    },
    getPickMeshes: () => [body, label],
    getKnobMeshes: () => [],
    getBypassMeshes: () => [],
    getKnobSpec: () => undefined,
    setKnobValue() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      geometries.forEach((g) => g.dispose());
      textures.forEach((t) => t.dispose());
      disposeMaterials(materials);
      root.clear();
    },
  };
}
