/**
 * Generic stomp pedal unit — used for Neural FX (fx_nam) with model chooser in dock.
 */

import * as THREE from "three";
import { valueToRotationRad } from "../ampLayout.js";
import type { Amp3dKnobSpec } from "../ampScene.js";
import type { Amp3dThemePreset } from "../ampTheme.js";
import type { ChainUnitDesc } from "../chainTypes.js";
import type { ChainUnit, ChainUnitFocusAnchor } from "./chainUnit.js";
import {
  addUnitContactShadow,
  applyHighlight,
  buildKnobRow,
  categoryAccent,
  createUnitMaterials,
  disposeMaterials,
  makeLabelTexture,
} from "./unitCommon.js";

export async function buildPedalUnit(
  desc: ChainUnitDesc,
  preset: Amp3dThemePreset,
): Promise<ChainUnit> {
  const root = new THREE.Group();
  root.name = `Pedal:${desc.nodeId}`;
  const geometries = new Set<THREE.BufferGeometry>();
  const textures: THREE.Texture[] = [];
    const extraMaterials: THREE.Material[] = [];
    const materials = createUnitMaterials(preset, categoryAccent(desc.category || "pedal", "pedal"));

    const width = 0.16;
    const height = 0.055;
    const depth = 0.22;
    addUnitContactShadow(root, geometries, extraMaterials, width, depth);

  const bodyGeo = new THREE.BoxGeometry(width, height, depth);
  geometries.add(bodyGeo);
  const body = new THREE.Mesh(bodyGeo, materials.body);
  body.position.y = height / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.chainNodeId = desc.nodeId;
  root.add(body);

  const topGeo = new THREE.BoxGeometry(width * 0.92, 0.008, depth * 0.92);
  geometries.add(topGeo);
  const top = new THREE.Mesh(topGeo, materials.face);
  top.position.y = height + 0.002;
  top.userData.chainNodeId = desc.nodeId;
  root.add(top);

  const labelTex = makeLabelTexture(desc.label, { width: 256, height: 96 });
  textures.push(labelTex);
  materials.label.map = labelTex;
  const labelGeo = new THREE.PlaneGeometry(width * 0.8, 0.03);
  geometries.add(labelGeo);
  const label = new THREE.Mesh(labelGeo, materials.label);
  label.rotation.x = -Math.PI / 2;
  label.position.set(0, height + 0.008, -depth * 0.22);
  label.userData.chainNodeId = desc.nodeId;
  root.add(label);

  const modelTex = makeLabelTexture(desc.displayText || "NO MODEL", {
    width: 384,
    height: 64,
    fill: "#d7dee8",
  });
  textures.push(modelTex);
  const modelMat = materials.face.clone();
  modelMat.map = modelTex;
  modelMat.needsUpdate = true;
  const modelGeo = new THREE.PlaneGeometry(width * 0.78, 0.022);
  geometries.add(modelGeo);
  const modelLabel = new THREE.Mesh(modelGeo, modelMat);
  modelLabel.rotation.x = -Math.PI / 2;
  modelLabel.position.set(0, height + 0.008, -depth * 0.02);
  modelLabel.userData.chainNodeId = desc.nodeId;
  root.add(modelLabel);

  const fsGeo = new THREE.CylinderGeometry(0.018, 0.02, 0.016, 16);
  geometries.add(fsGeo);
  const footswitch = new THREE.Mesh(fsGeo, materials.metal);
  footswitch.position.set(0, height + 0.01, depth * 0.28);
  footswitch.userData.chainNodeId = desc.nodeId;
  footswitch.userData.bypassTarget = true;
  root.add(footswitch);

  const ledGeo = new THREE.SphereGeometry(0.006, 12, 12);
  geometries.add(ledGeo);
  const led = new THREE.Mesh(ledGeo, desc.bypassed ? materials.ledOff : materials.ledOn);
  led.position.set(width * 0.28, height + 0.01, depth * 0.12);
  led.userData.chainNodeId = desc.nodeId;
  led.userData.bypassTarget = true;
  root.add(led);

  const knobs = buildKnobRow(desc.knobs, materials, {
    origin: new THREE.Vector3(0, height + 0.014, -depth * 0.28),
    spacing: 0.04,
    knobRadius: 0.012,
    knobHeight: 0.014,
    geometries,
  });
  knobs.forEach((knob) => {
    knob.root.traverse((obj) => {
      obj.userData.chainNodeId = desc.nodeId;
    });
    root.add(knob.root);
  });

  let bypassed = desc.bypassed;
  let disposed = false;
  const pickMeshes = [body, top, label, modelLabel, footswitch, led];

  const unit: ChainUnit = {
    nodeId: desc.nodeId,
    root,
    setParams(params: Record<string, number>) {
      knobs.forEach((knob) => {
        const value = params[knob.spec.key];
        if (typeof value === "number" && Number.isFinite(value)) {
          unit.setKnobValue(knob.spec.key, value);
        }
      });
    },
    setKnobSpecs(next: Amp3dKnobSpec[]) {
      next.forEach((spec) => unit.setKnobValue(spec.key, spec.value));
    },
    setBypassed(next: boolean) {
      bypassed = next;
      led.material = bypassed ? materials.ledOff : materials.ledOn;
      materials.body.opacity = bypassed ? 0.7 : 1;
      materials.body.transparent = bypassed;
    },
    setHighlighted(active: boolean) {
      applyHighlight([materials], active);
      root.position.y = active ? 0.015 : 0;
    },
    setDisplayText(text: string) {
      const tex = makeLabelTexture(text || "NO MODEL", { width: 384, height: 64, fill: "#d7dee8" });
      textures.push(tex);
      const prev = modelMat.map;
      modelMat.map = tex;
      modelMat.needsUpdate = true;
      prev?.dispose();
    },
    getFocusAnchor(): ChainUnitFocusAnchor {
      const position = new THREE.Vector3();
      body.getWorldPosition(position);
      return { position, fitDistance: 0.95 };
    },
    getPickMeshes: () => pickMeshes,
    getKnobMeshes: () => knobs.flatMap((k) => k.meshes),
    getBypassMeshes: () => [footswitch, led],
    getKnobSpec(key: string) {
      return knobs.find((k) => k.spec.key === key)?.spec;
    },
    setKnobValue(key: string, value: number) {
      const knob = knobs.find((k) => k.spec.key === key);
      if (!knob) return;
      knob.spec.value = value;
      knob.root.rotation.y = 0;
      knob.root.rotation.z = -valueToRotationRad(value, knob.spec.min, knob.spec.max);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      geometries.forEach((g) => g.dispose());
      textures.forEach((t) => t.dispose());
            extraMaterials.forEach((m) => {
              const std = m as THREE.MeshBasicMaterial;
              std.alphaMap?.dispose();
              m.dispose();
            });
            modelMat.dispose();
            disposeMaterials(materials);
            root.clear();
          },
        };

        unit.setBypassed(bypassed);
        return unit;
      }
