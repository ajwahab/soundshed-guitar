/**
 * Pure layout / value mapping helpers for the Neural Amp 3D view.
 *
 * Kept free of three.js and DOM APIs so the maths can be unit tested and so the
 * panel texture generator and the 3D scene always agree on where a control sits.
 *
 * All coordinates are in metres in the amp head's local space (front face
 * towards +Z, +Y up, origin at the centre of the head). The values mirror
 * `HEAD_LAYOUT` in scripts/generate-amp-models.js - keep both in sync.
 */

export interface PanelRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  faceZ: number;
}

export const PANEL_RECT: PanelRect = {
  left: -0.352,
  right: 0.352,
  top: -0.048,
  bottom: -0.136,
  faceZ: 0.1345,
};

export const GRILLE_RECT: PanelRect = {
  left: -0.325,
  right: 0.325,
  top: 0.128,
  bottom: -0.04,
  faceZ: 0.1215,
};

/**
 * Z of the emissive backlight plane recessed behind the grille face
 * (`HEAD.baffleZ + 0.007` in scripts/generate-amp-models.js). The thin slab
 * between this and `GRILLE_RECT.faceZ` is where the animated amp internals live.
 */
export const GRILLE_GLOW_Z = 0.115;

/** Fixed hardware positions on the control panel. */
export const PANEL_HARDWARE = {
  jack: { x: -0.315, y: -0.092 },
  display: { x: -0.212, y: -0.088, width: 0.124, height: 0.023 },
  powerSwitch: { x: 0.3, y: -0.096 },
  powerLed: { x: 0.334, y: -0.096 },
} as const;

/** Horizontal band of the panel that knobs are laid out across. */
const KNOB_ZONE_LEFT = -0.135;
const KNOB_ZONE_RIGHT = 0.265;
const KNOB_CENTER_Y = -0.092;
const KNOB_MAX_SPACING = 0.062;
const KNOB_MIN_SPACING = 0.047;

/** Knobs that do not fit on the panel fall back to the regular HTML controls. */
export const MAX_PANEL_KNOBS = Math.max(
  1,
  Math.floor((KNOB_ZONE_RIGHT - KNOB_ZONE_LEFT) / KNOB_MIN_SPACING) + 1,
);

export const KNOB_ROTATION_RANGE_DEG = 270;
export const KNOB_DRAG_RANGE_PX = 220;
export const KNOB_FINE_DRAG_SCALE = 0.25;

export interface KnobPlacement {
  x: number;
  y: number;
}

/**
 * Evenly distributes `count` knobs across the panel's knob zone, centred, using
 * realistic spacing (never tighter than a knob diameter).
 */
export function computeKnobPlacements(count: number): KnobPlacement[] {
  if (count <= 0) {
    return [];
  }

  const zoneWidth = KNOB_ZONE_RIGHT - KNOB_ZONE_LEFT;
  const zoneCenter = (KNOB_ZONE_LEFT + KNOB_ZONE_RIGHT) / 2;
  const spacing = count === 1
    ? 0
    : Math.max(KNOB_MIN_SPACING, Math.min(KNOB_MAX_SPACING, zoneWidth / (count - 1)));
  const span = spacing * (count - 1);
  const start = zoneCenter - span / 2;

  const placements: KnobPlacement[] = [];
  for (let index = 0; index < count; index += 1) {
    placements.push({ x: start + spacing * index, y: KNOB_CENTER_Y });
  }
  return placements;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** Normalized 0..1 position of a value within its range. */
export function normalizeValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 0;
  }
  return clamp((value - min) / (max - min), 0, 1);
}

/**
 * Knob rotation in degrees, clockwise from the 12 o'clock position.
 * Minimum sits at -135deg (7 o'clock), maximum at +135deg (5 o'clock).
 */
export function valueToRotationDeg(value: number, min: number, max: number): number {
  return (normalizeValue(value, min, max) - 0.5) * KNOB_ROTATION_RANGE_DEG;
}

export function valueToRotationRad(value: number, min: number, max: number): number {
  return (valueToRotationDeg(value, min, max) * Math.PI) / 180;
}

export interface DragValueOptions {
  startValue: number;
  deltaPixels: number;
  min: number;
  max: number;
  step?: number;
  fine?: boolean;
}

/**
 * Converts a vertical pointer drag (upwards is positive) into a parameter
 * value. A full range sweep takes KNOB_DRAG_RANGE_PX pixels; holding shift
 * gives fine control.
 */
export function dragToValue({ startValue, deltaPixels, min, max, step, fine }: DragValueOptions): number {
  if (max <= min) {
    return min;
  }
  const scale = fine ? KNOB_FINE_DRAG_SCALE : 1;
  const raw = startValue + (deltaPixels / KNOB_DRAG_RANGE_PX) * (max - min) * scale;
  const clamped = clamp(raw, min, max);
  if (typeof step === "number" && step > 0) {
    const snapped = min + Math.round((clamped - min) / step) * step;
    return clamp(snapped, min, max);
  }
  return clamped;
}

/**
 * Maps a point in panel space to pixel coordinates in the panel texture canvas.
 * The canvas origin is top-left, panel space is bottom-up, hence the flip.
 */
export function panelPointToCanvas(
  x: number,
  y: number,
  canvasWidth: number,
  canvasHeight: number,
  rect: PanelRect = PANEL_RECT,
): { x: number; y: number } {
  const u = (x - rect.left) / (rect.right - rect.left);
  const v = (y - rect.bottom) / (rect.top - rect.bottom);
  return { x: u * canvasWidth, y: (1 - v) * canvasHeight };
}

/** Pixels-per-metre of the panel texture, used to size silkscreen text. */
export function panelPixelsPerMetre(canvasWidth: number, rect: PanelRect = PANEL_RECT): number {
  return canvasWidth / (rect.right - rect.left);
}

export function formatKnobValue(value: number, unit: string): string {
  if (unit === "dB") {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`;
  }
  if (unit === "Hz" || unit === "ms" || unit === "%") {
    return `${value.toFixed(1)} ${unit}`;
  }
  if (unit === "amount" || unit === "") {
    return value.toFixed(2);
  }
  return `${value.toFixed(2)} ${unit}`;
}
