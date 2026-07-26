/**
 * Spatial panner visualisation for the 3D Spatial effect.
 *
 * Two linked views on one canvas:
 *   - a top-down radar carrying azimuth and distance, with the listener at the centre
 *   - a side-on elevation arc carrying height
 *
 * They are drawn as a single object: a ground shadow links the elevation puck back to
 * the radar, so raising the source visibly lifts it off the floor.
 *
 * Honesty note: elevation and front/back are pinna cues that only really survive over
 * headphones. In speaker mode the DSP scales those cues right back, so this widget
 * dims what it is no longer delivering rather than drawing a cue the listener cannot
 * hear. See docs/fx-library.md.
 */

export const SPATIAL_AZIMUTH_MIN = -180;
export const SPATIAL_AZIMUTH_MAX = 180;
export const SPATIAL_ELEVATION_MIN = -90;
export const SPATIAL_ELEVATION_MAX = 90;
export const SPATIAL_DISTANCE_MIN = 0.2;
export const SPATIAL_DISTANCE_MAX = 10;

export interface SpatialPosition {
  azimuth: number;
  elevation: number;
  distance: number;
}

export interface SpatialLiveState extends SpatialPosition {
  itdUs: number;
  ildDb: number;
  moving: boolean;
}

export type SpatialChangeHandler = (position: SpatialPosition) => void;

interface ThemeColors {
  grid: string;
  head: string;
  label: string;
  labelMuted: string;
  anchor: string;
  source: string;
  sourceBehind: string;
  trail: string;
  shadow: string;
  focus: string;
}

function readTheme(canvas: HTMLCanvasElement): ThemeColors {
  const styles = window.getComputedStyle(canvas);
  const value = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    grid: value("--spatial-grid", "rgba(255,255,255,0.10)"),
    head: value("--spatial-head", "rgba(255,255,255,0.32)"),
    label: value("--spatial-label", "rgba(255,255,255,0.62)"),
    labelMuted: value("--spatial-label-muted", "rgba(255,255,255,0.28)"),
    anchor: value("--spatial-anchor", "rgba(255,255,255,0.38)"),
    source: value("--spatial-source", "rgba(72, 168, 224, 0.95)"),
    sourceBehind: value("--spatial-source-behind", "rgba(150, 122, 208, 0.85)"),
    trail: value("--spatial-trail", "rgba(72, 168, 224, 0.30)"),
    shadow: value("--spatial-shadow", "rgba(0,0,0,0.35)"),
    focus: value("--spatial-focus", "rgba(120, 200, 255, 0.9)"),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Wrap to (-180, 180] so the shortest way round is always taken. */
function wrapDegrees(deg: number): number {
  let d = deg;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

const DEG = Math.PI / 180;

/**
 * Distance is mapped logarithmically: the near field, where the cues change fastest,
 * gets most of the radar's area. A linear map would bunch everything under 2 m into a
 * few pixels and make the useful range undraggable.
 */
function distanceToNorm(distance: number): number {
  const d = clamp(distance, SPATIAL_DISTANCE_MIN, SPATIAL_DISTANCE_MAX);
  return (
    (Math.log(d) - Math.log(SPATIAL_DISTANCE_MIN)) /
    (Math.log(SPATIAL_DISTANCE_MAX) - Math.log(SPATIAL_DISTANCE_MIN))
  );
}

function normToDistance(norm: number): number {
  const n = clamp(norm, 0, 1);
  return Math.exp(
    Math.log(SPATIAL_DISTANCE_MIN) +
      n * (Math.log(SPATIAL_DISTANCE_MAX) - Math.log(SPATIAL_DISTANCE_MIN))
  );
}

/** 0 dead ahead, 1 directly behind, exactly 0.5 overhead where it is undefined. */
export function backness(azimuth: number, elevation: number): number {
  return 0.5 - 0.5 * Math.cos(azimuth * DEG) * Math.cos(elevation * DEG);
}

interface Layout {
  radarCx: number;
  radarCy: number;
  radarInner: number;
  radarOuter: number;
  arcX: number;
  arcCy: number;
  arcR: number;
  arcPaneLeft: number;
  width: number;
  height: number;
}

type DragTarget = "radar" | "arc" | null;

export class SpatialPannerInteraction {
  private canvas: HTMLCanvasElement;
  private position: SpatialPosition;
  private onChange: SpatialChangeHandler;
  private onCommit: SpatialChangeHandler;

  private live: SpatialLiveState | null = null;
  private trail: Array<{ azimuth: number; elevation: number; distance: number }> = [];
  private speakerMode = false;
  private dragTarget: DragTarget = null;
  private hover: DragTarget = null;
  private focused = false;
  private destroyed = false;
  private layout: Layout | null = null;
  private rafHandle = 0;
  private redrawQueued = false;

  private readonly TRAIL_LENGTH = 96;
  private readonly PUCK_RADIUS = 8;

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerLeave: (e: PointerEvent) => void;
  private readonly onDoubleClick: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onFocus: () => void;
  private readonly onBlur: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    position: SpatialPosition,
    onChange: SpatialChangeHandler,
    onCommit: SpatialChangeHandler
  ) {
    this.canvas = canvas;
    this.position = this.sanitise(position);
    this.onChange = onChange;
    this.onCommit = onCommit;

    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.onPointerLeave = () => this.handlePointerLeave();
    this.onDoubleClick = (e) => this.handleDoubleClick(e);
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.onFocus = () => {
      this.focused = true;
      this.requestDraw();
    };
    this.onBlur = () => {
      this.focused = false;
      this.requestDraw();
    };

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("focus", this.onFocus);
    canvas.addEventListener("blur", this.onBlur);

    canvas.style.touchAction = "none";
    if (!canvas.hasAttribute("tabindex")) {
      canvas.setAttribute("tabindex", "0");
    }
    canvas.setAttribute("role", "application");
    this.updateAccessibleLabel();

    this.draw();
  }

  private sanitise(position: Partial<SpatialPosition>): SpatialPosition {
    const azimuth = Number.isFinite(position.azimuth) ? Number(position.azimuth) : 0;
    const elevation = Number.isFinite(position.elevation) ? Number(position.elevation) : 0;
    const distance = Number.isFinite(position.distance) ? Number(position.distance) : 1.5;
    return {
      azimuth: wrapDegrees(azimuth),
      elevation: clamp(elevation, SPATIAL_ELEVATION_MIN, SPATIAL_ELEVATION_MAX),
      distance: clamp(distance, SPATIAL_DISTANCE_MIN, SPATIAL_DISTANCE_MAX),
    };
  }

  /** Update the anchor position from the knobs. Ignored mid-drag so the puck cannot fight the pointer. */
  updatePosition(position: Partial<SpatialPosition>): void {
    if (this.dragTarget) return;
    this.position = this.sanitise({ ...this.position, ...position });
    this.updateAccessibleLabel();
    this.requestDraw();
  }

  setSpeakerMode(speakers: boolean): void {
    if (this.speakerMode === speakers) return;
    this.speakerMode = speakers;
    this.requestDraw();
  }

  /**
   * Feed the position the DSP is actually rendering right now. Without this the puck
   * would show where the motion engine was told to start, not where it has got to, and
   * on a slow orbit the mismatch is impossible to miss.
   */
  setLiveState(live: SpatialLiveState | null): void {
    this.live = live;
    if (live && live.moving) {
      this.trail.push({ azimuth: live.azimuth, elevation: live.elevation, distance: live.distance });
      if (this.trail.length > this.TRAIL_LENGTH) {
        this.trail.shift();
      }
    } else if (this.trail.length > 0) {
      this.trail = [];
    }
    this.requestDraw();
  }

  /** The position to draw the source at: what is being heard if known, else the anchor. */
  private displayPosition(): SpatialPosition {
    if (this.live) {
      return this.sanitise(this.live);
    }
    return this.position;
  }

  private requestDraw(): void {
    if (this.destroyed || this.redrawQueued) return;
    this.redrawQueued = true;
    this.rafHandle = window.requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.rafHandle = 0;
      this.draw();
    });
  }

  private computeLayout(width: number, height: number): Layout {
    const pad = 10;
    const arcPaneWidth = Math.min(96, Math.max(60, width * 0.26));
    const arcPaneLeft = width - arcPaneWidth;
    const radarSize = Math.min(arcPaneLeft - pad * 2, height - pad * 2);
    const radarCx = pad + radarSize / 2;
    const radarCy = height / 2;
    const radarOuter = radarSize / 2;
    return {
      radarCx,
      radarCy,
      radarInner: Math.min(22, radarOuter * 0.28),
      radarOuter,
      arcX: arcPaneLeft + arcPaneWidth * 0.34,
      arcCy: height / 2,
      arcR: Math.min(arcPaneWidth * 0.55, height / 2 - pad - 8),
      arcPaneLeft,
      width,
      height,
    };
  }

  private radarPoint(layout: Layout, azimuth: number, distance: number): { x: number; y: number } {
    const radius = layout.radarInner + (layout.radarOuter - layout.radarInner) * distanceToNorm(distance);
    // Screen up is straight ahead; +azimuth turns clockwise, i.e. to the listener's right.
    return {
      x: layout.radarCx + radius * Math.sin(azimuth * DEG),
      y: layout.radarCy - radius * Math.cos(azimuth * DEG),
    };
  }

  private arcPoint(layout: Layout, elevation: number): { x: number; y: number } {
    const a = clamp(elevation, SPATIAL_ELEVATION_MIN, SPATIAL_ELEVATION_MAX) * DEG;
    return {
      x: layout.arcX + layout.arcR * Math.cos(a),
      y: layout.arcCy - layout.arcR * Math.sin(a),
    };
  }

  draw(): void {
    if (this.destroyed) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const cssWidth = Math.max(1, this.canvas.clientWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const layout = this.computeLayout(cssWidth, cssHeight);
    this.layout = layout;
    if (layout.radarOuter <= 4 || layout.arcR <= 4) {
      return;
    }

    const theme = readTheme(this.canvas);
    const shown = this.displayPosition();

    this.drawRadar(ctx, layout, theme, shown);
    this.drawElevationArc(ctx, layout, theme, shown);
    this.drawReadouts(ctx, layout, theme, shown);

    if (this.focused) {
      ctx.strokeStyle = theme.focus;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(0.75, 0.75, cssWidth - 1.5, cssHeight - 1.5);
    }
  }

  private drawRadar(ctx: CanvasRenderingContext2D, layout: Layout, theme: ThemeColors, shown: SpatialPosition): void {
    ctx.save();

    // Distance rings, labelled where there is room for it.
    const rings = [0.5, 1, 2, 5, 10];
    ctx.lineWidth = 1;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    rings.forEach((metres) => {
      const radius = layout.radarInner + (layout.radarOuter - layout.radarInner) * distanceToNorm(metres);
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.arc(layout.radarCx, layout.radarCy, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (radius > layout.radarInner + 12) {
        ctx.fillStyle = theme.labelMuted;
        ctx.fillText(`${metres}m`, layout.radarCx + 3, layout.radarCy - radius + 6);
      }
    });

    // Cross hairs.
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(layout.radarCx - layout.radarOuter, layout.radarCy);
    ctx.lineTo(layout.radarCx + layout.radarOuter, layout.radarCy);
    ctx.moveTo(layout.radarCx, layout.radarCy - layout.radarOuter);
    ctx.lineTo(layout.radarCx, layout.radarCy + layout.radarOuter);
    ctx.stroke();

    // In speaker mode the rear half of the radar is a position we cannot honestly
    // render, so it is visibly knocked back rather than drawn as if it worked.
    if (this.speakerMode) {
      ctx.fillStyle = theme.shadow;
      ctx.beginPath();
      ctx.arc(layout.radarCx, layout.radarCy, layout.radarOuter, 0, Math.PI);
      ctx.fill();
    }

    // Listener: a head looking up the screen.
    ctx.strokeStyle = theme.head;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(layout.radarCx, layout.radarCy, layout.radarInner * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(layout.radarCx - 3, layout.radarCy - layout.radarInner * 0.55);
    ctx.lineTo(layout.radarCx, layout.radarCy - layout.radarInner * 0.55 - 5);
    ctx.lineTo(layout.radarCx + 3, layout.radarCy - layout.radarInner * 0.55);
    ctx.stroke();

    ctx.fillStyle = theme.label;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("FRONT", layout.radarCx, layout.radarCy - layout.radarOuter - 1);
    ctx.textBaseline = "bottom";
    ctx.fillText(this.speakerMode ? "BEHIND *" : "BEHIND", layout.radarCx, layout.radarCy + layout.radarOuter + 1);
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.fillText("L", layout.radarCx - layout.radarOuter - 2, layout.radarCy);
    ctx.textAlign = "left";
    ctx.fillText("R", layout.radarCx + layout.radarOuter + 2, layout.radarCy);

    // Trajectory trail, oldest faintest.
    if (this.trail.length > 1) {
      ctx.lineWidth = 1.5;
      for (let i = 1; i < this.trail.length; i += 1) {
        const a = this.radarPoint(layout, this.trail[i - 1].azimuth, this.trail[i - 1].distance);
        const b = this.radarPoint(layout, this.trail[i].azimuth, this.trail[i].distance);
        ctx.globalAlpha = (i / this.trail.length) * 0.8;
        ctx.strokeStyle = theme.trail;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // When motion is running the anchor and the audible position differ, so show both:
    // the hollow ring is the position you dragged, the filled puck is what you hear.
    const anchorVisible = this.live !== null && this.live.moving;
    if (anchorVisible) {
      const anchor = this.radarPoint(layout, this.position.azimuth, this.position.distance);
      ctx.strokeStyle = theme.anchor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, this.PUCK_RADIUS - 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.drawPuck(ctx, layout, theme, shown, this.radarPoint(layout, shown.azimuth, shown.distance));
    ctx.restore();
  }

  private drawPuck(
    ctx: CanvasRenderingContext2D,
    layout: Layout,
    theme: ThemeColors,
    shown: SpatialPosition,
    at: { x: number; y: number }
  ): void {
    const back = backness(shown.azimuth, shown.elevation);
    // Further away reads as smaller; behind reads as a different, dimmer colour.
    const scale = 1.25 - 0.5 * distanceToNorm(shown.distance);
    const radius = this.PUCK_RADIUS * scale;

    ctx.beginPath();
    ctx.arc(at.x, at.y + 2, radius * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = theme.shadow;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = back > 0.5 ? theme.sourceBehind : theme.source;
    ctx.globalAlpha = 1 - 0.35 * back;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (this.hover === "radar" || this.dragTarget === "radar") {
      ctx.strokeStyle = theme.focus;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    void layout;
  }

  private drawElevationArc(
    ctx: CanvasRenderingContext2D,
    layout: Layout,
    theme: ThemeColors,
    shown: SpatialPosition
  ): void {
    ctx.save();
    // Elevation is a pinna cue. On loudspeakers there is barely any of it, so the whole
    // pane is dimmed rather than implying a height that is not being delivered.
    if (this.speakerMode) {
      ctx.globalAlpha = 0.35;
    }

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(layout.arcX, layout.arcCy, layout.arcR, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();

    // Ear level, and the ground plane the source casts its shadow onto.
    ctx.beginPath();
    ctx.moveTo(layout.arcX - 4, layout.arcCy);
    ctx.lineTo(layout.arcX + layout.arcR + 4, layout.arcCy);
    ctx.stroke();

    ctx.fillStyle = theme.labelMuted;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("UP", layout.arcX + 6, layout.arcCy - layout.arcR - 2);
    ctx.textBaseline = "top";
    ctx.fillText("DOWN", layout.arcX + 6, layout.arcCy + layout.arcR + 2);

    ctx.strokeStyle = theme.head;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(layout.arcX, layout.arcCy, 5, 0, Math.PI * 2);
    ctx.stroke();

    const point = this.arcPoint(layout, shown.elevation);

    // The link back to ear level is what makes the two panes read as one object.
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, layout.arcCy);
    ctx.stroke();
    ctx.setLineDash([]);

    const back = backness(shown.azimuth, shown.elevation);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = back > 0.5 ? theme.sourceBehind : theme.source;
    ctx.fill();

    if (this.hover === "arc" || this.dragTarget === "arc") {
      ctx.strokeStyle = theme.focus;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawReadouts(
    ctx: CanvasRenderingContext2D,
    layout: Layout,
    theme: ThemeColors,
    shown: SpatialPosition
  ): void {
    ctx.save();
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.label;

    const lines = [
      `${Math.round(shown.azimuth)}\u00b0  ${shown.elevation >= 0 ? "+" : ""}${Math.round(shown.elevation)}\u00b0`,
      `${shown.distance.toFixed(2)} m`,
    ];
    if (this.live) {
      lines.push(`ITD ${Math.round(this.live.itdUs)} \u00b5s`);
      lines.push(`ILD ${this.live.ildDb >= 0 ? "+" : ""}${this.live.ildDb.toFixed(1)} dB`);
    }
    lines.forEach((line, index) => {
      ctx.fillText(line, 4, 4 + index * 11);
    });
    void layout;
    ctx.restore();
  }

  private canvasPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private hitTest(x: number, y: number): DragTarget {
    const layout = this.layout;
    if (!layout) return null;
    if (x >= layout.arcPaneLeft) return "arc";
    const dx = x - layout.radarCx;
    const dy = y - layout.radarCy;
    if (Math.hypot(dx, dy) <= layout.radarOuter + 12) return "radar";
    return null;
  }

  private positionFromRadar(x: number, y: number, fine: boolean): SpatialPosition {
    const layout = this.layout;
    if (!layout) return this.position;
    const dx = x - layout.radarCx;
    const dy = y - layout.radarCy;
    const radius = Math.hypot(dx, dy);

    // Right at the centre the angle is meaningless, so hold the current azimuth
    // rather than letting the source snap to whatever side of zero the cursor is on.
    const azimuth = radius < 2 ? this.position.azimuth : wrapDegrees((Math.atan2(dx, -dy) * 180) / Math.PI);
    const norm = (radius - layout.radarInner) / Math.max(1, layout.radarOuter - layout.radarInner);
    const distance = normToDistance(norm);

    if (fine) {
      return {
        azimuth: wrapDegrees(this.position.azimuth + wrapDegrees(azimuth - this.position.azimuth) * 0.25),
        elevation: this.position.elevation,
        distance: this.position.distance + (distance - this.position.distance) * 0.25,
      };
    }
    return { azimuth, elevation: this.position.elevation, distance };
  }

  private positionFromArc(x: number, y: number, fine: boolean): SpatialPosition {
    const layout = this.layout;
    if (!layout) return this.position;
    const dx = Math.max(0, x - layout.arcX);
    const dy = layout.arcCy - y;
    const raw = Math.hypot(dx, dy) < 2 ? this.position.elevation : (Math.atan2(dy, dx) * 180) / Math.PI;
    const elevation = clamp(raw, SPATIAL_ELEVATION_MIN, SPATIAL_ELEVATION_MAX);
    return {
      azimuth: this.position.azimuth,
      elevation: fine
        ? this.position.elevation + (elevation - this.position.elevation) * 0.25
        : elevation,
      distance: this.position.distance,
    };
  }

  private handlePointerDown(event: PointerEvent): void {
    const { x, y } = this.canvasPoint(event);
    const target = this.hitTest(x, y);
    if (!target) return;
    event.preventDefault();
    this.canvas.focus();
    this.dragTarget = target;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nicety; dragging still works without it.
    }
    this.applyDrag(x, y, event.shiftKey, false);
  }

  private handlePointerMove(event: PointerEvent): void {
    const { x, y } = this.canvasPoint(event);
    if (this.dragTarget) {
      event.preventDefault();
      this.applyDrag(x, y, event.shiftKey, false);
      return;
    }
    const target = this.hitTest(x, y);
    if (target !== this.hover) {
      this.hover = target;
      this.canvas.style.cursor = target ? "grab" : "default";
      this.requestDraw();
    }
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragTarget) return;
    const { x, y } = this.canvasPoint(event);
    this.applyDrag(x, y, event.shiftKey, true);
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Already released, or never captured.
    }
    this.dragTarget = null;
    this.requestDraw();
  }

  private handlePointerLeave(): void {
    if (this.dragTarget) return;
    this.hover = null;
    this.canvas.style.cursor = "default";
    this.requestDraw();
  }

  private applyDrag(x: number, y: number, fine: boolean, commit: boolean): void {
    const next =
      this.dragTarget === "arc" ? this.positionFromArc(x, y, fine) : this.positionFromRadar(x, y, fine);
    this.position = this.sanitise(next);
    this.updateAccessibleLabel();
    (commit ? this.onCommit : this.onChange)({ ...this.position });
    this.requestDraw();
  }

  private handleDoubleClick(event: MouseEvent): void {
    const { x, y } = this.canvasPoint(event);
    const target = this.hitTest(x, y);
    if (!target) return;
    event.preventDefault();
    // Reset only the axis that was double-clicked, so a careful distance setting is
    // not thrown away by someone re-centring the height.
    this.position =
      target === "arc"
        ? this.sanitise({ ...this.position, elevation: 0 })
        : this.sanitise({ ...this.position, azimuth: 0, distance: 1.5 });
    this.updateAccessibleLabel();
    this.onCommit({ ...this.position });
    this.requestDraw();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const fine = event.shiftKey;
    const azStep = fine ? 1 : 5;
    const elStep = fine ? 1 : 5;
    const distStep = fine ? 0.05 : 0.25;
    let handled = true;

    switch (event.key) {
      case "ArrowLeft":
        this.position.azimuth = wrapDegrees(this.position.azimuth - azStep);
        break;
      case "ArrowRight":
        this.position.azimuth = wrapDegrees(this.position.azimuth + azStep);
        break;
      case "ArrowUp":
        if (event.altKey) {
          this.position.distance = clamp(this.position.distance - distStep, SPATIAL_DISTANCE_MIN, SPATIAL_DISTANCE_MAX);
        } else {
          this.position.elevation = clamp(this.position.elevation + elStep, SPATIAL_ELEVATION_MIN, SPATIAL_ELEVATION_MAX);
        }
        break;
      case "ArrowDown":
        if (event.altKey) {
          this.position.distance = clamp(this.position.distance + distStep, SPATIAL_DISTANCE_MIN, SPATIAL_DISTANCE_MAX);
        } else {
          this.position.elevation = clamp(this.position.elevation - elStep, SPATIAL_ELEVATION_MIN, SPATIAL_ELEVATION_MAX);
        }
        break;
      case "Home":
        this.position = { azimuth: 0, elevation: 0, distance: 1.5 };
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    this.updateAccessibleLabel();
    this.onCommit({ ...this.position });
    this.requestDraw();
  }

  private updateAccessibleLabel(): void {
    const p = this.position;
    const side = Math.abs(p.azimuth) < 1 ? "centre" : p.azimuth > 0 ? "right" : "left";
    const depth = Math.abs(p.azimuth) > 90 ? "behind" : "in front";
    const height = Math.abs(p.elevation) < 1 ? "at ear level" : p.elevation > 0 ? "above" : "below";
    this.canvas.setAttribute(
      "aria-label",
      `Spatial position: ${Math.round(Math.abs(p.azimuth))} degrees ${side}, ${depth}, ` +
        `${height} by ${Math.round(Math.abs(p.elevation))} degrees, ${p.distance.toFixed(2)} metres away. ` +
        `Arrow keys pan and tilt, Alt with up or down changes distance, Home re-centres.`
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafHandle) {
      window.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("focus", this.onFocus);
    this.canvas.removeEventListener("blur", this.onBlur);
    this.canvas.style.cursor = "default";
  }
}
