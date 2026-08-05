/**
 * Procedural texture generation for the Neural Amp 3D view.
 *
 * Textures are generated at runtime with the 2D canvas API rather than shipped
 * as image files. That keeps the repository small, lets the control panel
 * silkscreen follow the effect's real parameter list, and lets every surface be
 * re-tinted when the app theme changes.
 *
 * This module is DOM-only (no three.js) so it can be reasoned about and tested
 * independently of the renderer.
 */

import {
  PANEL_HARDWARE,
  PANEL_RECT,
  panelPixelsPerMetre,
  panelPointToCanvas,
  type KnobPlacement,
} from "./ampLayout.js";

/** Deterministic PRNG so a given amp always looks identical between sessions. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable - cannot build amp textures");
  }
  return ctx;
}

/**
 * Converts a greyscale height field into a tangent-space normal map using a
 * Sobel filter. Sampling wraps so the result tiles seamlessly.
 */
export function heightToNormalCanvas(height: HTMLCanvasElement, strength = 2.2): HTMLCanvasElement {
  const width = height.width;
  const heightPx = height.height;
  const source = context2d(height).getImageData(0, 0, width, heightPx).data;
  const target = createCanvas(width, heightPx);
  const ctx = context2d(target);
  const output = ctx.createImageData(width, heightPx);

  const sample = (x: number, y: number): number => {
    const wx = ((x % width) + width) % width;
    const wy = ((y % heightPx) + heightPx) % heightPx;
    return source[(wy * width + wx) * 4] / 255;
  };

  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (
        sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1)
        - sample(x - 1, y - 1) - 2 * sample(x - 1, y) - sample(x - 1, y + 1)
      ) * strength;
      const dy = (
        sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1)
        - sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1)
      ) * strength;
      const length = Math.hypot(dx, dy, 1);
      const index = (y * width + x) * 4;
      output.data[index] = ((-dx / length) * 0.5 + 0.5) * 255;
      output.data[index + 1] = ((-dy / length) * 0.5 + 0.5) * 255;
      output.data[index + 2] = ((1 / length) * 0.5 + 0.5) * 255;
      output.data[index + 3] = 255;
    }
  }

  ctx.putImageData(output, 0, 0);
  return target;
}

export interface SurfaceTextures {
  albedo: HTMLCanvasElement;
  normal: HTMLCanvasElement;
  roughness?: HTMLCanvasElement;
}

/**
 * Pebbled vinyl (tolex) covering. Drawn with wrap-around so it tiles across the
 * cabinet without visible seams.
 */
export function createTolexTextures(tint: string, size = 512): SurfaceTextures {
  const random = createRandom(0x5eed1a);
  const height = createCanvas(size, size);
  const hctx = context2d(height);
  hctx.fillStyle = "#808080";
  hctx.fillRect(0, 0, size, size);

  const pebbleCount = Math.round((size * size) / 90);
  for (let i = 0; i < pebbleCount; i += 1) {
    const x = random() * size;
    const y = random() * size;
    const radius = 2.5 + random() * 4.5;
    const bright = 0.5 + random() * 0.5;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const gradient = hctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, radius);
      gradient.addColorStop(0, `rgba(255,255,255,${0.5 * bright})`);
      gradient.addColorStop(0.65, `rgba(128,128,128,${0.18 * bright})`);
      gradient.addColorStop(1, "rgba(0,0,0,0.16)");
      hctx.fillStyle = gradient;
      hctx.beginPath();
      hctx.arc(x + ox, y + oy, radius, 0, Math.PI * 2);
      hctx.fill();
    }
  }

  const albedo = createCanvas(size, size);
  const actx = context2d(albedo);
  actx.fillStyle = tint;
  actx.fillRect(0, 0, size, size);
  // Modulate the base colour with the height field for subtle tonal variation.
  actx.globalAlpha = 0.22;
  actx.globalCompositeOperation = "overlay";
  actx.drawImage(height, 0, 0);
  actx.globalCompositeOperation = "source-over";
  actx.globalAlpha = 1;

  return { albedo, normal: heightToNormalCanvas(height, 1.6) };
}

/**
 * Converts an already-loaded image into a tangent-space normal map.
 *
 * The luminance of the photo is used as the height field, auto-contrasted first
 * because photographed material (a near-black tolex swatch, for instance)
 * occupies only a sliver of the tonal range and would otherwise yield an almost
 * flat normal map.
 *
 * Throws if the image cannot be read back (e.g. a cross-origin taint on the
 * canvas); callers are expected to fall back to a procedural normal map.
 */
export function createNormalFromImageCanvas(
  image: CanvasImageSource,
  size = 512,
  strength = 3.0,
): HTMLCanvasElement {
  const height = createCanvas(size, size);
  const ctx = context2d(height);
  ctx.drawImage(image, 0, 0, size, size);

  const data = ctx.getImageData(0, 0, size, size);
  const pixels = data.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    pixels[i] = luma;
    if (luma < min) {
      min = luma;
    }
    if (luma > max) {
      max = luma;
    }
  }
  const span = Math.max(1, max - min);
  for (let i = 0; i < pixels.length; i += 4) {
    const stretched = ((pixels[i] - min) / span) * 255;
    pixels[i] = stretched;
    pixels[i + 1] = stretched;
    pixels[i + 2] = stretched;
    pixels[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);

  return heightToNormalCanvas(height, strength);
}

/**
 * Soft circular falloff used as the sprite/point map for the amp internals.
 * Greyscale (no colour of its own) so a single texture can be tinted per use.
 */
export function createSoftDotCanvas(size = 128): HTMLCanvasElement {
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  const radius = size / 2;
  const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.28, "rgba(255,255,255,0.62)");
  gradient.addColorStop(0.62, "rgba(255,255,255,0.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Fine grain leather for the carry handle. */
export function createLeatherTextures(tint: string, size = 256): SurfaceTextures {
  const random = createRandom(0x1eaf01);
  const height = createCanvas(size, size);
  const ctx = context2d(height);
  ctx.fillStyle = "#7d7d7d";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 14; i += 1) {
    const x = random() * size;
    const y = random() * size;
    const shade = Math.round(90 + random() * 90);
    ctx.fillStyle = `rgba(${shade},${shade},${shade},0.35)`;
    ctx.beginPath();
    ctx.ellipse(x, y, 1 + random() * 2.2, 1 + random() * 1.6, random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const albedo = createCanvas(size, size);
  const actx = context2d(albedo);
  actx.fillStyle = tint;
  actx.fillRect(0, 0, size, size);
  actx.globalAlpha = 0.3;
  actx.globalCompositeOperation = "overlay";
  actx.drawImage(height, 0, 0);
  actx.globalCompositeOperation = "source-over";
  actx.globalAlpha = 1;

  return { albedo, normal: heightToNormalCanvas(height, 1.1) };
}

/** Horizontally brushed aluminium, used as the base of the control panel. */
export function createBrushedMetalCanvas(
  width: number,
  height: number,
  baseColor: string,
  highlightColor: string,
  seed = 0xb2ee5,
): HTMLCanvasElement {
  const random = createRandom(seed);
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, highlightColor);
  gradient.addColorStop(0.35, baseColor);
  gradient.addColorStop(0.72, highlightColor);
  gradient.addColorStop(1, baseColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.globalAlpha = 0.06;
  for (let i = 0; i < width * 1.4; i += 1) {
    const y = random() * height;
    const length = width * (0.15 + random() * 0.85);
    const x = random() * width;
    ctx.strokeStyle = random() > 0.5 ? "#ffffff" : "#000000";
    ctx.lineWidth = random() * 1.6 + 0.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + length, y + (random() - 0.5) * 0.7);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  return canvas;
}

export interface PanelLabel {
  placement: KnobPlacement;
  topLabel: string;
  bottomLabel?: string;
}

export interface PanelTextureOptions {
  labels: PanelLabel[];
  /** Text printed to the right of the power switch, e.g. the effect name. */
  brandText: string;
  panelBase: string;
  panelTint: string;
  textColor: string;
  mutedTextColor: string;
}

const PANEL_TEXTURE_WIDTH = 2048;
const PANEL_TEXTURE_HEIGHT = 256;

/**
 * Silkscreened control panel: brushed metal plus the parameter names, the
 * INPUT / POWER legends and the "AMP MODEL" label around the display window.
 */
export function createPanelTexture(options: PanelTextureOptions): HTMLCanvasElement {
  const canvas = createBrushedMetalCanvas(
    PANEL_TEXTURE_WIDTH,
    PANEL_TEXTURE_HEIGHT,
    options.panelBase,
    options.panelTint,
  );
  const ctx = context2d(canvas);
  const pxPerMetre = panelPixelsPerMetre(PANEL_TEXTURE_WIDTH);

  const toCanvas = (x: number, y: number) => panelPointToCanvas(x, y, PANEL_TEXTURE_WIDTH, PANEL_TEXTURE_HEIGHT);
  const drawText = (
    text: string,
    x: number,
    y: number,
    fontPx: number,
    color: string,
    weight = "700",
    letterSpacing = 2,
    maxWidthPx?: number,
  ) => {
    ctx.save();
    const measure = (size: number, spacing: number) => {
      ctx.font = `${weight} ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
      const characters = [...text];
      const widths = characters.map((character) => ctx.measureText(character).width);
      const total = widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, characters.length - 1);
      return { characters, widths, total };
    };

    let size = fontPx;
    let spacing = letterSpacing;
    let metrics = measure(size, spacing);
    // Long text (e.g. a user-supplied brand string) is scaled down rather than
    // being allowed to run off the edge of the panel.
    if (maxWidthPx && metrics.total > maxWidthPx) {
      const scale = maxWidthPx / metrics.total;
      size = Math.max(6, size * scale);
      spacing = spacing * scale;
      metrics = measure(size, spacing);
    }

    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let cursor = x - metrics.total / 2;
    metrics.characters.forEach((character, index) => {
      ctx.fillText(character, cursor, y);
      cursor += metrics.widths[index] + spacing;
    });
    ctx.restore();
  };

  // ~33% smaller than the previous 0.011 m silkscreen size.
  const labelFont = Math.round(0.0074 * pxPerMetre);
  // Keep labels tight to the control they annotate.
  const labelOffsetY = 0.022;

  options.labels.forEach((label) => {
    const top = toCanvas(label.placement.x, label.placement.y + labelOffsetY);
    drawText(label.topLabel.toUpperCase(), top.x, top.y, labelFont, options.textColor);
    if (label.bottomLabel) {
      const bottom = toCanvas(label.placement.x, label.placement.y - labelOffsetY);
      drawText(label.bottomLabel.toUpperCase(), bottom.x, bottom.y, Math.round(labelFont * 0.9), options.mutedTextColor);
    }
  });

  const inputLabel = toCanvas(PANEL_HARDWARE.jack.x, PANEL_HARDWARE.jack.y + labelOffsetY);
  drawText("INPUT", inputLabel.x, inputLabel.y, labelFont, options.textColor);

  const moduleLabel = toCanvas(PANEL_HARDWARE.display.x, PANEL_HARDWARE.display.y + 0.02);
  drawText("AMP MODEL", moduleLabel.x, moduleLabel.y, Math.round(labelFont * 0.85), options.mutedTextColor, "600", 1.4);

  const powerLabel = toCanvas(
    (PANEL_HARDWARE.powerSwitch.x + PANEL_HARDWARE.powerLed.x) / 2,
    PANEL_HARDWARE.powerSwitch.y + labelOffsetY,
  );
  drawText("POWER", powerLabel.x, powerLabel.y, labelFont, options.textColor);

  if (options.brandText) {
    const brandCenterX = (PANEL_HARDWARE.powerSwitch.x + PANEL_HARDWARE.powerLed.x) / 2;
    const brand = toCanvas(brandCenterX, PANEL_HARDWARE.powerSwitch.y - labelOffsetY);
    const availableMetres = Math.max(0.02, (PANEL_RECT.right - 0.006 - brandCenterX) * 2);
    drawText(
      options.brandText.toUpperCase(),
      brand.x,
      brand.y,
      Math.round(labelFont * 0.78),
      options.mutedTextColor,
      "600",
      1.1,
      availableMetres * pxPerMetre,
    );
  }

  // Subtle screw heads at the panel corners.
  const screwPositions = [
    [PANEL_RECT.left + 0.012, PANEL_RECT.top - 0.012],
    [PANEL_RECT.right - 0.012, PANEL_RECT.top - 0.012],
    [PANEL_RECT.left + 0.012, PANEL_RECT.bottom + 0.012],
    [PANEL_RECT.right - 0.012, PANEL_RECT.bottom + 0.012],
  ];
  screwPositions.forEach(([x, y]) => {
    const point = toCanvas(x, y);
    const radius = 0.0035 * pxPerMetre;
    const gradient = ctx.createRadialGradient(point.x - radius * 0.3, point.y - radius * 0.3, radius * 0.1, point.x, point.y, radius);
    gradient.addColorStop(0, "rgba(255,255,255,0.85)");
    gradient.addColorStop(0.6, "rgba(120,124,130,0.75)");
    gradient.addColorStop(1, "rgba(40,42,46,0.85)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(20,22,26,0.7)";
    ctx.lineWidth = Math.max(1, radius * 0.22);
    ctx.beginPath();
    ctx.moveTo(point.x - radius * 0.6, point.y);
    ctx.lineTo(point.x + radius * 0.6, point.y);
    ctx.stroke();
  });

  return canvas;
}

const GRILLE_TEXTURE_WIDTH = 1024;
const GRILLE_TEXTURE_HEIGHT = 272;

/**
 * Alpha mask for the perforated front grille: opaque metal with a field of
 * diamond shaped holes that the backlight shines through.
 */
export function createGrilleAlphaCanvas(): HTMLCanvasElement {
  const random = createRandom(0x9a11e);
  const canvas = createCanvas(GRILLE_TEXTURE_WIDTH, GRILLE_TEXTURE_HEIGHT);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, GRILLE_TEXTURE_WIDTH, GRILLE_TEXTURE_HEIGHT);

  const cell = 26;
  const holeRadius = cell * 0.36;
  ctx.fillStyle = "#000000";
  for (let row = 0; row * (cell / 2) < GRILLE_TEXTURE_HEIGHT + cell; row += 1) {
    const y = row * (cell / 2);
    const offset = row % 2 === 0 ? 0 : cell / 2;
    for (let x = -cell; x < GRILLE_TEXTURE_WIDTH + cell; x += cell) {
      // A random scatter of "missing" holes gives the pattern its organic look.
      if (random() < 0.14) {
        continue;
      }
      ctx.save();
      ctx.translate(x + offset, y);
      ctx.rotate(Math.PI / 4);
      const size = holeRadius * (0.94 + random() * 0.12);
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.restore();
    }
  }

  return canvas;
}

/** Dark brushed metal base colour for the grille panel. */
export function createGrilleBaseCanvas(): HTMLCanvasElement {
  return createBrushedMetalCanvas(
    GRILLE_TEXTURE_WIDTH,
    GRILLE_TEXTURE_HEIGHT,
    "#1a1c20",
    "#2a2d33",
    0x71115,
  );
}

/**
 * The backlight behind the grille. Bright hotspots plus falloff read as real
 * lamps behind a perforated screen rather than a flat emissive panel.
 */
export function createGrilleGlowCanvas(color: string, active: boolean): HTMLCanvasElement {
  const random = createRandom(0x6106);
  const canvas = createCanvas(GRILLE_TEXTURE_WIDTH, GRILLE_TEXTURE_HEIGHT);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, GRILLE_TEXTURE_WIDTH, GRILLE_TEXTURE_HEIGHT);

  if (!active) {
    return canvas;
  }

  // Soft cavity wash behind the perforated grille. Intensity is modulated at
  // runtime from the node's smoothed output peak rather than by extra sprites.
  const base = ctx.createLinearGradient(0, 0, 0, GRILLE_TEXTURE_HEIGHT);
  base.addColorStop(0, "rgba(255,255,255,0.16)");
  base.addColorStop(0.45, "rgba(255,255,255,0.34)");
  base.addColorStop(1, "rgba(255,255,255,0.14)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, GRILLE_TEXTURE_WIDTH, GRILLE_TEXTURE_HEIGHT);

  // A few large, evenly spaced pools rather than random speckle: real backlit
  // grilles read as a smooth wash behind a regular perforation grid.
  ctx.globalCompositeOperation = "lighter";
  const pools = 5;
  for (let i = 0; i < pools; i += 1) {
    const x = ((i + 0.5) / pools) * GRILLE_TEXTURE_WIDTH;
    const y = GRILLE_TEXTURE_HEIGHT * (0.42 + (random() - 0.5) * 0.16);
    const radius = GRILLE_TEXTURE_WIDTH / pools * 0.95;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, 0, radius * 2, GRILLE_TEXTURE_HEIGHT);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  return canvas;
}

/** Etched logo plate decal shown in the centre of the grille. */
export function createLogoCanvas(text: string): HTMLCanvasElement {
  const canvas = createCanvas(1024, 256);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const label = (text || "NEURAL AMP").toUpperCase();
  const fontSize = label.length > 16 ? 84 : 118;
  ctx.font = `200 ${fontSize}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f2f4f8";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  return canvas;
}

/** Backlit LCD strip that shows the loaded model name. */
export function createDisplayCanvas(text: string, color: string, active: boolean): HTMLCanvasElement {
  const canvas = createCanvas(1024, 192);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#050607";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const glass = ctx.createLinearGradient(0, 0, 0, canvas.height);
  glass.addColorStop(0, "rgba(255,255,255,0.12)");
  glass.addColorStop(0.45, "rgba(255,255,255,0.02)");
  glass.addColorStop(1, "rgba(255,255,255,0.07)");
  ctx.fillStyle = glass;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!active) {
    return canvas;
  }

  const rawLabel = (text || "NO MODEL LOADED").toUpperCase();
  const gap = "   \u2022   ";
  const label = rawLabel + gap + rawLabel + gap;
  const fontSize = 104;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${fontSize}px "Courier New", ui-monospace, monospace`;

  ctx.shadowColor = color;
  ctx.shadowBlur = 26;
  ctx.fillStyle = color;
  const textWidth = ctx.measureText(label).width;
  const offset = ((performance.now() / 1000) * 70) % Math.max(1, textWidth);
  ctx.fillText(label, canvas.width - offset, canvas.height / 2);
  ctx.fillText(label, canvas.width - offset - textWidth, canvas.height / 2);
  ctx.fillText(label, canvas.width - offset + textWidth, canvas.height / 2);
  return canvas;
}

/** Woven speaker cloth for the cabinet front. */
export function createClothTextures(tint: string, size = 512): SurfaceTextures {
  const random = createRandom(0xc107);
  const height = createCanvas(size, size);
  const ctx = context2d(height);
  ctx.fillStyle = "#6e6e6e";
  ctx.fillRect(0, 0, size, size);

  const thread = 6;
  for (let y = 0; y < size; y += thread) {
    for (let x = 0; x < size; x += thread) {
      const warp = ((x / thread) + (y / thread)) % 2 === 0;
      const shade = warp ? 190 : 96;
      const jitter = (random() - 0.5) * 26;
      ctx.fillStyle = `rgb(${shade + jitter},${shade + jitter},${shade + jitter})`;
      ctx.fillRect(x, y, thread, thread);
    }
  }

  const albedo = createCanvas(size, size);
  const actx = context2d(albedo);
  actx.fillStyle = tint;
  actx.fillRect(0, 0, size, size);
  actx.globalAlpha = 0.35;
  actx.globalCompositeOperation = "overlay";
  actx.drawImage(height, 0, 0);
  actx.globalCompositeOperation = "source-over";
  actx.globalAlpha = 1;

  return { albedo, normal: heightToNormalCanvas(height, 1.3) };
}

/**
 * Radial fade used as the floor alpha map so the finite floor plane never shows
 * a hard edge against the backdrop.
 */
export function createFloorFadeCanvas(size = 256): HTMLCanvasElement {
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.18, "#ffffff");
  gradient.addColorStop(0.42, "#8a8a8a");
  gradient.addColorStop(1, "#000000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Studio backdrop: a soft vertical gradient with a radial pool of light behind
 * the amp and a vignette, used as the scene background.
 */
export function createBackdropCanvas(topColor: string, bottomColor: string, size = 512): HTMLCanvasElement {
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);

  const vertical = ctx.createLinearGradient(0, 0, 0, size);
  vertical.addColorStop(0, topColor);
  vertical.addColorStop(1, bottomColor);
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, size, size);

  // Light pool centred slightly above the middle, where the amp sits.
  const glow = ctx.createRadialGradient(size * 0.5, size * 0.42, 0, size * 0.5, size * 0.42, size * 0.62);
  glow.addColorStop(0, "rgba(255,255,255,0.10)");
  glow.addColorStop(0.55, "rgba(255,255,255,0.03)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  const vignette = ctx.createRadialGradient(size * 0.5, size * 0.5, size * 0.25, size * 0.5, size * 0.5, size * 0.78);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}
