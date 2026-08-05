/**
 * Shared procedural helpers for rack / pedal / junction units.
 */

import * as THREE from "three";
import { valueToRotationRad } from "../ampLayout.js";
import type { Amp3dKnobSpec } from "../ampScene.js";
import type { Amp3dThemePreset } from "../ampTheme.js";
import type { GenericUnitMaterials } from "./chainUnit.js";

export const MAX_UNIT_KNOBS = 6;

export function createUnitMaterials(preset: Amp3dThemePreset, accentHex: number): GenericUnitMaterials {
  // Studio-grade PBR responses so generic units sit next to the photo amp
  // without reading as flat unlit toys (env map from the chain stage helps).
  return {
    body: new THREE.MeshStandardMaterial({
      color: accentHex,
      roughness: 0.48,
      metalness: 0.42,
      envMapIntensity: 0.85,
    }),
    face: new THREE.MeshStandardMaterial({
      color: new THREE.Color(preset.panelBase),
      roughness: 0.32,
      metalness: 0.78,
      envMapIntensity: 1.0,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: 0xc5cad1,
      roughness: 0.22,
      metalness: 1.0,
      envMapIntensity: 1.15,
    }),
    knob: new THREE.MeshStandardMaterial({
      color: 0x14161a,
      roughness: 0.52,
      metalness: 0.18,
      envMapIntensity: 0.55,
    }),
    ledOn: new THREE.MeshStandardMaterial({
      color: preset.ledColor,
      emissive: preset.ledColor,
      emissiveIntensity: Math.max(0.9, preset.ledIntensity),
      roughness: 0.28,
      metalness: 0.05,
    }),
    ledOff: new THREE.MeshStandardMaterial({
      color: 0x1c2026,
      emissive: 0x000000,
      emissiveIntensity: 0.02,
      roughness: 0.55,
      metalness: 0.15,
    }),
    label: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.15,
      transparent: true,
      opacity: 0.96,
      envMapIntensity: 0.35,
    }),
  };
}

export function disposeMaterials(materials: GenericUnitMaterials): void {
  Object.values(materials).forEach((material) => material.dispose());
}

export function makeLabelTexture(
  text: string,
  options?: { width?: number; height?: number; fill?: string },
): THREE.CanvasTexture {
  const width = options?.width ?? 512;
  const height = options?.height ?? 128;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    // Soft plate behind type so labels read on dark/light tolex-like bodies.
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(255,255,255,0.10)");
    gradient.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = options?.fill ?? "#f2f4f7";
    ctx.font = "600 48px system-ui, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 6;
    ctx.fillText((text || "FX").slice(0, 28), width / 2, height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Soft elliptical contact shadow under generic units (matches amp contact shadow language). */
export function addUnitContactShadow(
  root: THREE.Group,
  geometries: Set<THREE.BufferGeometry>,
  materials: THREE.Material[],
  width: number,
  depth: number,
): void {
  const geo = new THREE.PlaneGeometry(width * 1.7, depth * 2.4);
  geometries.add(geo);
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(0.55, "rgba(0,0,0,0.18)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const alpha = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.55,
    alphaMap: alpha,
    depthWrite: false,
  });
  materials.push(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.0015;
  mesh.renderOrder = 1;
  root.add(mesh);
}

export interface KnobHandle {
  spec: Amp3dKnobSpec;
  root: THREE.Group;
  meshes: THREE.Object3D[];
}

export function buildKnobRow(
  knobs: Amp3dKnobSpec[],
  materials: GenericUnitMaterials,
  options: {
    origin: THREE.Vector3;
    spacing: number;
    knobRadius: number;
    knobHeight: number;
    geometries: Set<THREE.BufferGeometry>;
  },
): KnobHandle[] {
  const count = Math.min(MAX_UNIT_KNOBS, knobs.length);
  if (count <= 0) return [];
  const totalWidth = options.spacing * (count - 1);
  const startX = options.origin.x - totalWidth / 2;
  const handles: KnobHandle[] = [];

  for (let i = 0; i < count; i += 1) {
    const spec = { ...knobs[i] };
    const root = new THREE.Group();
    root.position.set(startX + i * options.spacing, options.origin.y, options.origin.z);

    const geo = new THREE.CylinderGeometry(options.knobRadius, options.knobRadius * 1.05, options.knobHeight, 20);
    options.geometries.add(geo);
    const mesh = new THREE.Mesh(geo, materials.knob);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.knobKey = spec.key;
    root.add(mesh);

    const pointerGeo = new THREE.BoxGeometry(
      options.knobRadius * 0.18,
      options.knobHeight * 0.2,
      options.knobRadius * 0.9,
    );
    options.geometries.add(pointerGeo);
    const pointer = new THREE.Mesh(pointerGeo, materials.metal);
    pointer.position.set(0, options.knobHeight * 0.35, options.knobRadius * 0.15);
    pointer.userData.knobKey = spec.key;
    root.add(pointer);

    root.rotation.z = -valueToRotationRad(spec.value, spec.min, spec.max);
    handles.push({ spec, root, meshes: [mesh, pointer] });
  }
  return handles;
}

export function categoryAccent(category: string, kind: string): number {
  const c = (category || kind || "").toLowerCase();
  if (c.includes("drive") || c.includes("dist") || c.includes("fuzz") || c.includes("over") || c.includes("boost")) {
    return 0xb33a2e;
  }
  if (c.includes("delay") || c.includes("echo")) return 0x2f6fed;
  if (c.includes("reverb") || c.includes("room") || c.includes("hall") || c.includes("plate")) return 0x5b4fc9;
  if (c.includes("mod") || c.includes("chorus") || c.includes("flange") || c.includes("phaser") || c.includes("trem")) {
    return 0x2f9e6b;
  }
  if (c.includes("dyn") || c.includes("comp") || c.includes("gate") || c.includes("limit")) return 0xc48a1a;
  if (c.includes("eq") || c.includes("filter") || c.includes("tone") || c.includes("wah")) return 0x3d8ea8;
  if (c.includes("pitch") || c.includes("transpose") || c.includes("harmon")) return 0x9b59b6;
  if (c.includes("pedal") || kind === "pedal" || c.includes("fx_nam") || c.includes("neural")) return 0xd35400;
  if (c.includes("amp") || c.includes("nam")) return 0x4a5562;
  if (c.includes("cab") || c.includes("ir")) return 0x3a3028;
  return 0x5a6570;
}

export function applyHighlight(materials: GenericUnitMaterials[], active: boolean): void {
  materials.forEach((set) => {
    set.body.emissive = new THREE.Color(active ? 0x224466 : 0x000000);
    set.body.emissiveIntensity = active ? 0.18 : 0;
    set.face.emissive = new THREE.Color(active ? 0x1a3050 : 0x000000);
    set.face.emissiveIntensity = active ? 0.12 : 0;
  });
}
