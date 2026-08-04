#!/usr/bin/env node
/**
 * Generates the glTF 2.0 component models used by the Neural Amp 3D view.
 *
 * The models are geometry-only: every primitive references a *named* material
 * slot (Tolex, PanelFace, KnobBody, ...) and the runtime (core/ui/ts/amp3d)
 * assigns procedurally generated PBR textures to those slots. That keeps the
 * committed assets small and lets panel labels follow the effect's real
 * parameter list.
 *
 * Units are metres, the amp faces +Z, +Y is up.
 *
 * Usage:
 *   node scripts/generate-amp-models.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const OUT_DIR = path.join(ROOT, 'assets', 'models');

// ── Geometry primitives ────────────────────────────────────────────────────
// Every primitive returns { positions, normals, uvs, indices } with UVs in
// metres ("meters" uv mode) unless stated otherwise. Metre UVs let the runtime
// tile a single tolex/metal texture consistently across differently sized
// parts by setting texture.repeat = 1 / tileSizeInMetres.

function emptyGeometry() {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

function appendGeometry(target, source) {
  const offset = target.positions.length / 3;
  target.positions.push(...source.positions);
  target.normals.push(...source.normals);
  target.uvs.push(...source.uvs);
  for (const index of source.indices) {
    target.indices.push(index + offset);
  }
  return target;
}

/**
 * Rounded (bevelled) box. Bevelled edges are what make a rendered cabinet read
 * as a real object, so every tolex covered part uses this rather than a raw box.
 */
function roundedBox(width, height, depth, radius, segments = 4) {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;
  const r = Math.min(radius, hw, hh, hd);
  const inner = [hw - r, hh - r, hd - r];
  const geo = emptyGeometry();
  const n = Math.max(2, segments * 2 + 2);

  // Six faces of the cube, each sampled on an n x n grid then pushed out to the
  // rounded surface: clamp to the inner box, then offset by the corner radius.
  const faces = [
    { axis: 0, sign: 1, u: 2, v: 1, flipU: true },
    { axis: 0, sign: -1, u: 2, v: 1, flipU: false },
    { axis: 1, sign: 1, u: 0, v: 2, flipU: false },
    { axis: 1, sign: -1, u: 0, v: 2, flipU: false },
    { axis: 2, sign: 1, u: 0, v: 1, flipU: false },
    { axis: 2, sign: -1, u: 0, v: 1, flipU: true },
  ];
  const half = [hw, hh, hd];

  for (const face of faces) {
    const base = geo.positions.length / 3;
    for (let iy = 0; iy < n; iy += 1) {
      for (let ix = 0; ix < n; ix += 1) {
        const su = (ix / (n - 1)) * 2 - 1;
        const sv = (iy / (n - 1)) * 2 - 1;
        const p = [0, 0, 0];
        p[face.axis] = half[face.axis] * face.sign;
        p[face.u] = half[face.u] * (face.flipU ? -su : su);
        p[face.v] = half[face.v] * sv;

        const c = [
          Math.max(-inner[0], Math.min(inner[0], p[0])),
          Math.max(-inner[1], Math.min(inner[1], p[1])),
          Math.max(-inner[2], Math.min(inner[2], p[2])),
        ];
        let dx = p[0] - c[0];
        let dy = p[1] - c[1];
        let dz = p[2] - c[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len;
        dy /= len;
        dz /= len;
        geo.positions.push(c[0] + dx * r, c[1] + dy * r, c[2] + dz * r);
        geo.normals.push(dx, dy, dz);
        geo.uvs.push(p[face.u], p[face.v]);
      }
    }
    for (let iy = 0; iy < n - 1; iy += 1) {
      for (let ix = 0; ix < n - 1; ix += 1) {
        const a = base + iy * n + ix;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        geo.indices.push(a, c, b, b, c, d);
      }
    }
  }

  return geo;
}

/** Cylinder with its axis along +Z (so it points out of the amp front panel). */
function cylinderZ(radiusTop, radiusBottom, length, radialSegments = 32, capTop = true, capBottom = true) {
  const geo = emptyGeometry();
  const hl = length / 2;
  const slope = (radiusBottom - radiusTop) / length;

  const base = geo.positions.length / 3;
  for (let i = 0; i <= radialSegments; i += 1) {
    const t = i / radialSegments;
    const angle = t * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const nl = Math.hypot(1, slope) || 1;
    for (let j = 0; j <= 1; j += 1) {
      const z = j === 0 ? -hl : hl;
      const radius = j === 0 ? radiusBottom : radiusTop;
      geo.positions.push(cos * radius, sin * radius, z);
      geo.normals.push((cos * 1) / nl, (sin * 1) / nl, slope / nl);
      geo.uvs.push(t * Math.PI * 2 * Math.max(radiusTop, radiusBottom), z);
    }
  }
  for (let i = 0; i < radialSegments; i += 1) {
    const a = base + i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    geo.indices.push(a, c, b, b, c, d);
  }

  const addCap = (z, radius, normalZ) => {
    if (radius <= 0) return;
    const capBase = geo.positions.length / 3;
    geo.positions.push(0, 0, z);
    geo.normals.push(0, 0, normalZ);
    geo.uvs.push(0, 0);
    for (let i = 0; i <= radialSegments; i += 1) {
      const angle = (i / radialSegments) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      geo.positions.push(cos * radius, sin * radius, z);
      geo.normals.push(0, 0, normalZ);
      geo.uvs.push(cos * radius, sin * radius);
    }
    for (let i = 0; i < radialSegments; i += 1) {
      const a = capBase + 1 + i;
      const b = capBase + 2 + i;
      if (normalZ > 0) {
        geo.indices.push(capBase, a, b);
      } else {
        geo.indices.push(capBase, b, a);
      }
    }
  };

  if (capTop) addCap(hl, radiusTop, 1);
  if (capBottom) addCap(-hl, radiusBottom, -1);

  return geo;
}

/** Torus lying in the XY plane (ring facing +Z). */
function torusZ(ringRadius, tubeRadius, ringSegments = 40, tubeSegments = 14) {
  const geo = emptyGeometry();
  for (let i = 0; i <= ringSegments; i += 1) {
    const u = (i / ringSegments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let j = 0; j <= tubeSegments; j += 1) {
      const v = (j / tubeSegments) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const x = (ringRadius + tubeRadius * cv) * cu;
      const y = (ringRadius + tubeRadius * cv) * su;
      const z = tubeRadius * sv;
      geo.positions.push(x, y, z);
      geo.normals.push(cv * cu, cv * su, sv);
      geo.uvs.push(u * ringRadius, v * tubeRadius);
    }
  }
  for (let i = 0; i < ringSegments; i += 1) {
    for (let j = 0; j < tubeSegments; j += 1) {
      const a = i * (tubeSegments + 1) + j;
      const b = a + tubeSegments + 1;
      geo.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return geo;
}

function sphere(radius, widthSegments = 24, heightSegments = 16, phiLength = Math.PI) {
  const geo = emptyGeometry();
  for (let iy = 0; iy <= heightSegments; iy += 1) {
    const v = iy / heightSegments;
    const phi = v * phiLength;
    for (let ix = 0; ix <= widthSegments; ix += 1) {
      const u = ix / widthSegments;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.sin(phi) * Math.sin(theta);
      const nz = Math.cos(phi);
      geo.positions.push(nx * radius, ny * radius, nz * radius);
      geo.normals.push(nx, ny, nz);
      geo.uvs.push(u * radius * Math.PI * 2, v * radius * Math.PI);
    }
  }
  for (let iy = 0; iy < heightSegments; iy += 1) {
    for (let ix = 0; ix < widthSegments; ix += 1) {
      const a = iy * (widthSegments + 1) + ix;
      const b = a + widthSegments + 1;
      geo.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return geo;
}

/** Flat quad in the XY plane facing +Z with normalized (0..1) UVs. */
function planeXY(width, height) {
  const hw = width / 2;
  const hh = height / 2;
  return {
    positions: [-hw, -hh, 0, hw, -hh, 0, -hw, hh, 0, hw, hh, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    indices: [0, 1, 2, 2, 1, 3],
  };
}

// ── Transforms (baked into geometry) ───────────────────────────────────────

function transformGeometry(geo, { translate = [0, 0, 0], rotate = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const [rx, ry, rz] = rotate;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  const rotatePoint = (x, y, z) => {
    let y1 = y * cx - z * sx;
    let z1 = y * sx + z * cx;
    let x2 = x * cy + z1 * sy;
    let z2 = -x * sy + z1 * cy;
    let x3 = x2 * cz - y1 * sz;
    let y3 = x2 * sz + y1 * cz;
    return [x3, y3, z2];
  };

  const out = {
    positions: [],
    normals: [],
    uvs: geo.uvs.slice(),
    indices: geo.indices.slice(),
  };
  for (let i = 0; i < geo.positions.length; i += 3) {
    const [x, y, z] = rotatePoint(
      geo.positions[i] * scale[0],
      geo.positions[i + 1] * scale[1],
      geo.positions[i + 2] * scale[2],
    );
    out.positions.push(x + translate[0], y + translate[1], z + translate[2]);
    const [nx, ny, nz] = rotatePoint(geo.normals[i], geo.normals[i + 1], geo.normals[i + 2]);
    const len = Math.hypot(nx, ny, nz) || 1;
    out.normals.push(nx / len, ny / len, nz / len);
  }
  return out;
}

// ── glTF writer ────────────────────────────────────────────────────────────

const MATERIAL_DEFAULTS = {
  Tolex: { baseColorFactor: [0.11, 0.09, 0.08, 1], metallicFactor: 0.0, roughnessFactor: 0.85 },
  Leather: { baseColorFactor: [0.09, 0.08, 0.07, 1], metallicFactor: 0.0, roughnessFactor: 0.7 },
  PanelFace: { baseColorFactor: [0.82, 0.82, 0.83, 1], metallicFactor: 0.85, roughnessFactor: 0.32 },
  PanelBody: { baseColorFactor: [0.7, 0.7, 0.72, 1], metallicFactor: 0.85, roughnessFactor: 0.36 },
  GrilleMetal: { baseColorFactor: [0.05, 0.05, 0.06, 1], metallicFactor: 0.9, roughnessFactor: 0.42, doubleSided: true },
  GrilleBacking: { baseColorFactor: [0.02, 0.02, 0.03, 1], metallicFactor: 0.0, roughnessFactor: 0.95 },
  GrilleGlow: { baseColorFactor: [0.05, 0.12, 0.4, 1], metallicFactor: 0.0, roughnessFactor: 1.0 },
  GrilleCloth: { baseColorFactor: [0.16, 0.14, 0.12, 1], metallicFactor: 0.0, roughnessFactor: 0.95 },
  LogoPlate: { baseColorFactor: [0.85, 0.86, 0.88, 1], metallicFactor: 1.0, roughnessFactor: 0.22 },
  ChromeTrim: { baseColorFactor: [0.78, 0.79, 0.82, 1], metallicFactor: 1.0, roughnessFactor: 0.16 },
  CornerMetal: { baseColorFactor: [0.16, 0.16, 0.17, 1], metallicFactor: 1.0, roughnessFactor: 0.38 },
  DisplayGlass: { baseColorFactor: [0.02, 0.02, 0.02, 1], metallicFactor: 0.0, roughnessFactor: 0.18 },
  KnobBody: { baseColorFactor: [0.86, 0.86, 0.87, 1], metallicFactor: 0.55, roughnessFactor: 0.34 },
  KnobPointer: { baseColorFactor: [0.04, 0.04, 0.05, 1], metallicFactor: 0.0, roughnessFactor: 0.5 },
  LedLens: { baseColorFactor: [0.12, 0.35, 0.9, 1], metallicFactor: 0.0, roughnessFactor: 0.08 },
  Rubber: { baseColorFactor: [0.04, 0.04, 0.045, 1], metallicFactor: 0.0, roughnessFactor: 0.95 },
  SpeakerCone: { baseColorFactor: [0.12, 0.1, 0.09, 1], metallicFactor: 0.0, roughnessFactor: 0.9 },
  SpeakerDust: { baseColorFactor: [0.06, 0.06, 0.07, 1], metallicFactor: 0.2, roughnessFactor: 0.6 },
};

function buildGltf(parts, generatorNote, binFileName) {
  const materialNames = [];
  for (const part of parts) {
    if (!MATERIAL_DEFAULTS[part.material]) {
      throw new Error(`Unknown material slot "${part.material}" on part "${part.name}"`);
    }
    if (!materialNames.includes(part.material)) {
      materialNames.push(part.material);
    }
  }

  const chunks = [];
  let byteOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];

  const pushView = (typedArray, target) => {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const padding = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes);
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
    const view = {
      buffer: 0,
      byteOffset,
      byteLength: bytes.length,
      target,
    };
    byteOffset += bytes.length + padding;
    bufferViews.push(view);
    return bufferViews.length - 1;
  };

  for (const part of parts) {
    const geo = part.geometry;
    const vertexCount = geo.positions.length / 3;
    if (vertexCount === 0) {
      throw new Error(`Part "${part.name}" has no geometry`);
    }

    const positions = new Float32Array(geo.positions);
    const normals = new Float32Array(geo.normals);
    const uvs = new Float32Array(geo.uvs);
    const useUint32 = vertexCount > 65535;
    const indices = useUint32 ? new Uint32Array(geo.indices) : new Uint16Array(geo.indices);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], positions[i + axis]);
        max[axis] = Math.max(max[axis], positions[i + axis]);
      }
    }

    const positionView = pushView(positions, 34962);
    const normalView = pushView(normals, 34962);
    const uvView = pushView(uvs, 34962);
    const indexView = pushView(indices, 34963);

    accessors.push({ bufferView: positionView, componentType: 5126, count: vertexCount, type: 'VEC3', min, max });
    const positionAccessor = accessors.length - 1;
    accessors.push({ bufferView: normalView, componentType: 5126, count: vertexCount, type: 'VEC3' });
    const normalAccessor = accessors.length - 1;
    accessors.push({ bufferView: uvView, componentType: 5126, count: vertexCount, type: 'VEC2' });
    const uvAccessor = accessors.length - 1;
    accessors.push({
      bufferView: indexView,
      componentType: useUint32 ? 5125 : 5123,
      count: indices.length,
      type: 'SCALAR',
    });
    const indexAccessor = accessors.length - 1;

    meshes.push({
      name: `${part.name}Mesh`,
      primitives: [{
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
        indices: indexAccessor,
        material: materialNames.indexOf(part.material),
      }],
    });

    const node = { name: part.name, mesh: meshes.length - 1 };
    if (part.translation) {
      node.translation = part.translation;
    }
    node.extras = { uvMode: part.uvMode ?? 'meters', materialSlot: part.material };
    nodes.push(node);
  }

  // Parent/child wiring (used for pivots such as the power switch lever).
  const nodeIndexByName = new Map(nodes.map((node, index) => [node.name, index]));
  const childIndices = new Set();
  parts.forEach((part, index) => {
    if (!part.parent) return;
    const parentIndex = nodeIndexByName.get(part.parent);
    if (parentIndex === undefined) {
      throw new Error(`Part "${part.name}" references unknown parent "${part.parent}"`);
    }
    const parentNode = nodes[parentIndex];
    parentNode.children = parentNode.children ?? [];
    parentNode.children.push(index);
    childIndices.add(index);
  });

  const buffer = Buffer.concat(chunks);

  return {
    binary: buffer,
    binFileName,
    asset: { version: '2.0', generator: `soundshed-guitar generate-amp-models.js (${generatorNote})` },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index).filter((index) => !childIndices.has(index)) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{
      byteLength: buffer.length,
      uri: binFileName,
    }],
    materials: materialNames.map((name) => {
      const defaults = MATERIAL_DEFAULTS[name];
      const material = {
        name,
        pbrMetallicRoughness: {
          baseColorFactor: defaults.baseColorFactor,
          metallicFactor: defaults.metallicFactor,
          roughnessFactor: defaults.roughnessFactor,
        },
      };
      if (defaults.doubleSided) {
        material.doubleSided = true;
      }
      return material;
    }),
  };
}

// ── Shared dimensions ──────────────────────────────────────────────────────

const HEAD = {
  width: 0.74,
  height: 0.30,
  depth: 0.26,
  cornerRadius: 0.018,
  // Front frame opening (the recessed grille area).
  openingLeft: -0.325,
  openingRight: 0.325,
  openingTop: 0.128,
  openingBottom: -0.040,
  frontZ: 0.13,
  baffleZ: 0.108,
  panelTop: -0.048,
  panelBottom: -0.136,
  panelFrontZ: 0.1345,
};

// Exported for the runtime: keep in sync with amp3d/ampLayout.ts.
const HEAD_LAYOUT = {
  panel: {
    left: -0.352,
    right: 0.352,
    top: HEAD.panelTop,
    bottom: HEAD.panelBottom,
    faceZ: HEAD.panelFrontZ,
  },
  grille: {
    left: HEAD.openingLeft,
    right: HEAD.openingRight,
    top: HEAD.openingTop,
    bottom: HEAD.openingBottom,
    faceZ: 0.1215,
  },
};

// ── Amp head ───────────────────────────────────────────────────────────────

function buildAmpHead() {
  const parts = [];
  const { width, height, depth, cornerRadius } = HEAD;

  // Main tolex covered shell. Its front face sits behind the grille opening so
  // the front frame rails below can form a genuine recess.
  const shellDepth = depth - 0.024;
  parts.push({
    name: 'HeadShell',
    material: 'Tolex',
    geometry: transformGeometry(
      roundedBox(width, height, shellDepth, cornerRadius, 4),
      { translate: [0, 0, -0.012] },
    ),
  });

  // Front frame: four tolex rails around the grille opening.
  const frameZ = 0.118;
  const frameDepth = 0.026;
  const railTopHeight = height / 2 - HEAD.openingTop;
  parts.push({
    name: 'FrameTop',
    material: 'Tolex',
    geometry: transformGeometry(
      roundedBox(width, railTopHeight, frameDepth, 0.008, 3),
      { translate: [0, HEAD.openingTop + railTopHeight / 2, frameZ] },
    ),
  });
  const railBottomTop = HEAD.openingBottom;
  const railBottomHeight = railBottomTop - HEAD.panelTop;
  parts.push({
    name: 'FrameBottom',
    material: 'Tolex',
    geometry: transformGeometry(
      roundedBox(width, railBottomHeight, frameDepth, 0.006, 3),
      { translate: [0, HEAD.panelTop + railBottomHeight / 2, frameZ] },
    ),
  });
  const railSideWidth = width / 2 + HEAD.openingLeft;
  const railSideHeight = HEAD.openingTop - HEAD.openingBottom;
  for (const sign of [-1, 1]) {
    parts.push({
      name: sign < 0 ? 'FrameLeft' : 'FrameRight',
      material: 'Tolex',
      geometry: transformGeometry(
        roundedBox(railSideWidth, railSideHeight, frameDepth, 0.008, 3),
        { translate: [sign * (width / 2 - railSideWidth / 2), (HEAD.openingTop + HEAD.openingBottom) / 2, frameZ] },
      ),
    });
  }

  // Recessed grille assembly: dark cavity, blue backlight, perforated face.
  const openingWidth = HEAD.openingRight - HEAD.openingLeft;
  const openingHeight = HEAD.openingTop - HEAD.openingBottom;
  const openingCenterY = (HEAD.openingTop + HEAD.openingBottom) / 2;
  parts.push({
    name: 'GrilleCavity',
    material: 'GrilleBacking',
    geometry: transformGeometry(
      roundedBox(openingWidth + 0.01, openingHeight + 0.01, 0.012, 0.004, 2),
      { translate: [0, openingCenterY, HEAD.baffleZ] },
    ),
  });
  parts.push({
    name: 'GrilleGlow',
    material: 'GrilleGlow',
    uvMode: 'normalized',
    geometry: transformGeometry(
      planeXY(openingWidth, openingHeight),
      { translate: [0, openingCenterY, HEAD.baffleZ + 0.007] },
    ),
  });
  parts.push({
    name: 'GrilleFace',
    material: 'GrilleMetal',
    uvMode: 'normalized',
    geometry: transformGeometry(
      planeXY(openingWidth, openingHeight),
      { translate: [0, openingCenterY, HEAD_LAYOUT.grille.faceZ] },
    ),
  });

  // Control panel: brushed metal strip with a separate face plane that carries
  // the silkscreened labels generated at runtime.
  const panelWidth = HEAD_LAYOUT.panel.right - HEAD_LAYOUT.panel.left;
  const panelHeight = HEAD.panelTop - HEAD.panelBottom;
  const panelCenterY = (HEAD.panelTop + HEAD.panelBottom) / 2;
  parts.push({
    name: 'PanelBody',
    material: 'PanelBody',
    geometry: transformGeometry(
      roundedBox(panelWidth, panelHeight, 0.03, 0.004, 3),
      { translate: [0, panelCenterY, HEAD.panelFrontZ - 0.015] },
    ),
  });
  parts.push({
    name: 'PanelFace',
    material: 'PanelFace',
    uvMode: 'normalized',
    geometry: transformGeometry(
      planeXY(panelWidth, panelHeight),
      { translate: [0, panelCenterY, HEAD.panelFrontZ + 0.0006] },
    ),
  });

  // Model-name display window (mirrors the reference "amp control module").
  parts.push({
    name: 'DisplayBezel',
    material: 'ChromeTrim',
    geometry: transformGeometry(
      roundedBox(0.132, 0.03, 0.006, 0.002, 2),
      { translate: [-0.212, panelCenterY + 0.004, HEAD.panelFrontZ + 0.002] },
    ),
  });
  parts.push({
    name: 'DisplayGlass',
    material: 'DisplayGlass',
    uvMode: 'normalized',
    geometry: transformGeometry(
      planeXY(0.124, 0.023),
      { translate: [-0.212, panelCenterY + 0.004, HEAD.panelFrontZ + 0.0055] },
    ),
  });

  // Metal corner protectors.
  const cornerSize = 0.055;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push({
          name: `Corner_${sx < 0 ? 'L' : 'R'}${sy < 0 ? 'B' : 'T'}${sz < 0 ? 'R' : 'F'}`,
          material: 'CornerMetal',
          geometry: transformGeometry(
            roundedBox(cornerSize, cornerSize, cornerSize, 0.02, 2),
            {
              translate: [
                sx * (width / 2 - cornerSize / 2 + 0.004),
                sy * (height / 2 - cornerSize / 2 + 0.004),
                sz * (depth / 2 - cornerSize / 2 + 0.002) - 0.012,
              ],
            },
          ),
        });
      }
    }
  }

  // Top handle: leather strap plus two chrome mounts.
  parts.push({
    name: 'HandleStrap',
    material: 'Leather',
    geometry: transformGeometry(
      roundedBox(0.20, 0.014, 0.034, 0.006, 3),
      { translate: [0, height / 2 + 0.014, -0.012] },
    ),
  });
  for (const sign of [-1, 1]) {
    parts.push({
      name: sign < 0 ? 'HandleMountL' : 'HandleMountR',
      material: 'ChromeTrim',
      geometry: transformGeometry(
        roundedBox(0.03, 0.026, 0.044, 0.004, 2),
        { translate: [sign * 0.108, height / 2 + 0.004, -0.012] },
      ),
    });
  }

  // Rubber feet.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({
        name: `Foot_${sx < 0 ? 'L' : 'R'}${sz < 0 ? 'R' : 'F'}`,
        material: 'Rubber',
        geometry: transformGeometry(
          cylinderZ(0.016, 0.018, 0.012, 20),
          {
            rotate: [Math.PI / 2, 0, 0],
            translate: [sx * 0.27, -height / 2 - 0.005, sz * 0.075 - 0.012],
          },
        ),
      });
    }
  }

  return buildGltf(parts, 'amp head', 'amp-head.bin');
}

// ── Knob ───────────────────────────────────────────────────────────────────
// Built facing +Z with its mounting face at z = 0 so it can be dropped onto the
// control panel and rotated about Z to show its value.

function buildKnob() {
  const parts = [];
  const skirtRadius = 0.0215;
  const skirtLength = 0.014;
  const capLength = 0.006;

  parts.push({
    name: 'KnobSkirt',
    material: 'KnobBody',
    geometry: transformGeometry(
      cylinderZ(skirtRadius * 0.97, skirtRadius, skirtLength, 48, false, true),
      { translate: [0, 0, skirtLength / 2] },
    ),
  });
  parts.push({
    name: 'KnobShoulder',
    material: 'KnobBody',
    geometry: transformGeometry(
      cylinderZ(skirtRadius * 0.86, skirtRadius * 0.97, capLength, 48, true, false),
      { translate: [0, 0, skirtLength + capLength / 2] },
    ),
  });
  parts.push({
    name: 'KnobEdge',
    material: 'KnobBody',
    geometry: transformGeometry(
      torusZ(skirtRadius * 0.9, 0.0016, 48, 10),
      { translate: [0, 0, skirtLength + capLength] },
    ),
  });
  // Pointer groove running from the centre to the rim (the value indicator).
  parts.push({
    name: 'KnobPointer',
    material: 'KnobPointer',
    geometry: transformGeometry(
      roundedBox(0.0028, skirtRadius * 1.55, 0.0035, 0.0012, 2),
      { translate: [0, skirtRadius * 0.42, skirtLength + capLength - 0.0004] },
    ),
  });

  return buildGltf(parts, 'knob', 'amp-knob.bin');
}

// ── Power switch ───────────────────────────────────────────────────────────
// "SwitchLever" is a child node pivoting at the base so the runtime can flip it.

function buildToggleSwitch() {
  const parts = [];
  parts.push({
    name: 'SwitchBase',
    material: 'ChromeTrim',
    geometry: transformGeometry(
      cylinderZ(0.0075, 0.0095, 0.006, 6),
      { translate: [0, 0, 0.003] },
    ),
  });
  parts.push({
    name: 'SwitchCollar',
    material: 'ChromeTrim',
    geometry: transformGeometry(
      cylinderZ(0.0055, 0.0072, 0.004, 24),
      { translate: [0, 0, 0.008] },
    ),
  });
  parts.push({
    name: 'SwitchLever',
    parent: 'SwitchBase',
    material: 'ChromeTrim',
    translation: [0, 0, 0.009],
    geometry: appendGeometry(
      transformGeometry(cylinderZ(0.0022, 0.0032, 0.011, 20), { translate: [0, 0, 0.0055] }),
      transformGeometry(sphere(0.0034, 20, 12, Math.PI), { translate: [0, 0, 0.011] }),
    ),
  });
  return buildGltf(parts, 'toggle switch', 'amp-switch.bin');
}

// ── Power LED jewel ────────────────────────────────────────────────────────

function buildLed() {
  const parts = [];
  parts.push({
    name: 'LedBezel',
    material: 'ChromeTrim',
    geometry: transformGeometry(
      cylinderZ(0.0068, 0.0082, 0.005, 28),
      { translate: [0, 0, 0.0025] },
    ),
  });
  parts.push({
    name: 'LedLens',
    material: 'LedLens',
    geometry: appendGeometry(
      transformGeometry(sphere(0.0055, 24, 12, Math.PI / 2), { translate: [0, 0, 0.004] }),
      transformGeometry(cylinderZ(0.0055, 0.0055, 0.003, 24, false, true), { translate: [0, 0, 0.0025] }),
    ),
  });
  return buildGltf(parts, 'led', 'amp-led.bin');
}

// ── Input jack ─────────────────────────────────────────────────────────────

function buildJack() {
  const parts = [];
  parts.push({
    name: 'JackNut',
    material: 'ChromeTrim',
    geometry: appendGeometry(
      transformGeometry(cylinderZ(0.0085, 0.0105, 0.004, 6), { translate: [0, 0, 0.002] }),
      transformGeometry(torusZ(0.0072, 0.0016, 32, 10), { translate: [0, 0, 0.0045] }),
    ),
  });
  parts.push({
    name: 'JackHole',
    material: 'DisplayGlass',
    geometry: transformGeometry(
      cylinderZ(0.0048, 0.0048, 0.01, 24, false, true),
      { translate: [0, 0, -0.002] },
    ),
  });
  return buildGltf(parts, 'input jack', 'amp-jack.bin');
}

// ── 4x12 cabinet (used for full-rig captures) ──────────────────────────────

function buildCabinet() {
  const parts = [];
  const width = 0.80;
  const height = 0.78;
  const depth = 0.36;
  const frontZ = depth / 2;
  const wall = 0.019;
  const frame = 0.05;      // width of the tolex rails around the cloth opening
  const frameDepth = 0.022;
  const clothZ = frontZ - 0.036;   // cloth is genuinely recessed inside the frame

  // The shell is an open-fronted box (back + four walls) so the baffle area is a
  // real cavity: the speakers behind the cloth are visible instead of being
  // buried inside a solid block.
  parts.push({
    name: 'CabBack',
    material: 'Tolex',
    geometry: transformGeometry(
      roundedBox(width, height, 0.018, 0.008, 2),
      { translate: [0, 0, -frontZ + 0.009] },
    ),
  });
  for (const sign of [-1, 1]) {
    parts.push({
      name: sign < 0 ? 'CabWallLeft' : 'CabWallRight',
      material: 'Tolex',
      geometry: transformGeometry(
        roundedBox(wall, height, depth - 0.018, 0.006, 2),
        { translate: [sign * (width / 2 - wall / 2), 0, 0.009] },
      ),
    });
    parts.push({
      name: sign < 0 ? 'CabWallBottom' : 'CabWallTop',
      material: 'Tolex',
      geometry: transformGeometry(
        roundedBox(width - 2 * wall, wall, depth - 0.018, 0.006, 2),
        { translate: [0, sign * (height / 2 - wall / 2), 0.009] },
      ),
    });
  }

  // Front frame rails around the grille opening.
  parts.push({
    name: 'CabFrameTop',
    material: 'Tolex',
    geometry: transformGeometry(
      roundedBox(width, frame, frameDepth, 0.008, 3),
      { translate: [0, height / 2 - frame / 2, frontZ - frameDepth / 2] },
    ),
  });
  parts.push({
    name: 'CabFrameBottom',
    material: 'Tolex',
    geometry: transformGeometry(
      roundedBox(width, frame, frameDepth, 0.008, 3),
      { translate: [0, -(height / 2 - frame / 2), frontZ - frameDepth / 2] },
    ),
  });
  for (const sign of [-1, 1]) {
    parts.push({
      name: sign < 0 ? 'CabFrameLeft' : 'CabFrameRight',
      material: 'Tolex',
      geometry: transformGeometry(
        roundedBox(frame, height - 2 * frame, frameDepth, 0.008, 3),
        { translate: [sign * (width / 2 - frame / 2), 0, frontZ - frameDepth / 2] },
      ),
    });
  }

  // Baffle board sitting behind the speakers, closing off the cavity.
  parts.push({
    name: 'CabBaffle',
    material: 'GrilleBacking',
    geometry: transformGeometry(
      roundedBox(width - 2 * wall, height - 2 * wall, 0.012, 0.004, 2),
      { translate: [0, 0, frontZ - 0.145] },
    ),
  });

  // Speakers sit behind the cloth: visible as soft shapes, exactly like a real cab.
  const speakerOffset = 0.185;
  const speakerFrontZ = frontZ - 0.072;
  let speakerIndex = 0;
  for (const sy of [1, -1]) {
    for (const sx of [-1, 1]) {
      speakerIndex += 1;
      const cx = sx * speakerOffset;
      const cy = sy * speakerOffset;
      parts.push({
        name: `SpeakerCone_${speakerIndex}`,
        material: 'SpeakerCone',
        geometry: transformGeometry(
          cylinderZ(0.145, 0.05, 0.062, 40, false, false),
          { translate: [cx, cy, speakerFrontZ - 0.031] },
        ),
      });
      parts.push({
        name: `SpeakerDust_${speakerIndex}`,
        material: 'SpeakerDust',
        geometry: transformGeometry(
          sphere(0.042, 24, 12, Math.PI / 2),
          { translate: [cx, cy, speakerFrontZ - 0.042] },
        ),
      });
      parts.push({
        name: `SpeakerSurround_${speakerIndex}`,
        material: 'Rubber',
        geometry: transformGeometry(
          torusZ(0.148, 0.009, 36, 10),
          { translate: [cx, cy, speakerFrontZ - 0.004] },
        ),
      });
    }
  }

  parts.push({
    name: 'CabCloth',
    material: 'GrilleCloth',
    uvMode: 'normalized',
    geometry: transformGeometry(
      planeXY(width - 2 * frame + 0.004, height - 2 * frame + 0.004),
      { translate: [0, 0, clothZ] },
    ),
  });

  const cornerSize = 0.075;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push({
          name: `CabCorner_${sx < 0 ? 'L' : 'R'}${sy < 0 ? 'B' : 'T'}${sz < 0 ? 'R' : 'F'}`,
          material: 'CornerMetal',
          geometry: transformGeometry(
            roundedBox(cornerSize, cornerSize, cornerSize, 0.026, 2),
            {
              translate: [
                sx * (width / 2 - cornerSize / 2 + 0.005),
                sy * (height / 2 - cornerSize / 2 + 0.005),
                sz * (depth / 2 - cornerSize / 2 + 0.004),
              ],
            },
          ),
        });
      }
    }
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({
        name: `CabCaster_${sx < 0 ? 'L' : 'R'}${sz < 0 ? 'R' : 'F'}`,
        material: 'Rubber',
        geometry: transformGeometry(
          cylinderZ(0.028, 0.028, 0.02, 24),
          {
            rotate: [0, Math.PI / 2, 0],
            translate: [sx * 0.29, -height / 2 - 0.026, sz * 0.1],
          },
        ),
      });
    }
  }

  return buildGltf(parts, '4x12 cabinet', 'amp-cabinet.bin');
}

// ── Entry point ────────────────────────────────────────────────────────────

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const outputs = [
    ['amp-head.gltf', buildAmpHead()],
    ['amp-knob.gltf', buildKnob()],
    ['amp-switch.gltf', buildToggleSwitch()],
    ['amp-led.gltf', buildLed()],
    ['amp-jack.gltf', buildJack()],
    ['amp-cabinet.gltf', buildCabinet()],
  ];

  for (const [fileName, gltf] of outputs) {
    const target = path.join(OUT_DIR, fileName);
    const { binary, binFileName, ...document } = gltf;
    fs.writeFileSync(path.join(OUT_DIR, binFileName), binary);
    fs.writeFileSync(target, `${JSON.stringify(document)}\n`, 'utf8');
    const kb = ((fs.statSync(target).size + binary.length) / 1024).toFixed(1);
    console.log(`[generate-amp-models] ${fileName} + ${binFileName} (${kb} KB, ${document.nodes.length} nodes)`);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'amp-head-layout.json'),
    `${JSON.stringify(HEAD_LAYOUT, null, 2)}\n`,
    'utf8',
  );
  console.log('[generate-amp-models] amp-head-layout.json');
}

main();
