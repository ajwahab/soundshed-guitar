import { describe, expect, it } from "vitest";

import {
  KNOB_DRAG_RANGE_PX,
  KNOB_FINE_DRAG_SCALE,
  KNOB_ROTATION_RANGE_DEG,
  MAX_PANEL_KNOBS,
  PANEL_RECT,
  computeKnobPlacements,
  dragToValue,
  formatKnobValue,
  normalizeValue,
  panelPixelsPerMetre,
  panelPointToCanvas,
  valueToRotationDeg,
} from "../ts/amp3d/ampLayout.js";

describe("computeKnobPlacements", () => {
  it("returns nothing for a non-positive count", () => {
    expect(computeKnobPlacements(0)).toEqual([]);
    expect(computeKnobPlacements(-3)).toEqual([]);
  });

  it("centres a single knob in the knob zone", () => {
    const [only] = computeKnobPlacements(1);
    expect(only.x).toBeCloseTo(0.06, 6);
  });

  it("keeps placements symmetric about the zone centre", () => {
    const placements = computeKnobPlacements(6);
    const first = placements[0].x;
    const last = placements[placements.length - 1].x;
    expect((first + last) / 2).toBeCloseTo(0.06, 6);
  });

  it("uses uniform spacing that never drops below a knob diameter", () => {
    for (let count = 2; count <= MAX_PANEL_KNOBS; count += 1) {
      const placements = computeKnobPlacements(count);
      const gaps = placements.slice(1).map((placement, index) => placement.x - placements[index].x);
      gaps.forEach((gap) => {
        expect(gap).toBeCloseTo(gaps[0], 9);
        expect(gap).toBeGreaterThanOrEqual(0.044 - 1e-9);
      });
    }
  });

  it("puts every knob on the same vertical centre line", () => {
    const placements = computeKnobPlacements(5);
    placements.forEach((placement) => expect(placement.y).toBeCloseTo(placements[0].y, 9));
  });

  it("stays inside the panel even at maximum capacity", () => {
    const placements = computeKnobPlacements(MAX_PANEL_KNOBS);
    placements.forEach((placement) => {
      expect(placement.x).toBeGreaterThan(PANEL_RECT.left);
      expect(placement.x).toBeLessThan(PANEL_RECT.right);
    });
  });
});

describe("normalizeValue", () => {
  it("maps a value onto 0..1 and clamps outside the range", () => {
    expect(normalizeValue(5, 0, 10)).toBeCloseTo(0.5, 9);
    expect(normalizeValue(-4, 0, 10)).toBe(0);
    expect(normalizeValue(99, 0, 10)).toBe(1);
  });

  it("degrades safely for a degenerate range", () => {
    expect(normalizeValue(1, 5, 5)).toBe(0);
    expect(normalizeValue(1, 10, 0)).toBe(0);
    expect(normalizeValue(1, Number.NaN, 10)).toBe(0);
  });
});

describe("valueToRotationDeg", () => {
  it("spans a symmetric sweep around 12 o'clock", () => {
    expect(valueToRotationDeg(0, 0, 1)).toBeCloseTo(-KNOB_ROTATION_RANGE_DEG / 2, 9);
    expect(valueToRotationDeg(0.5, 0, 1)).toBeCloseTo(0, 9);
    expect(valueToRotationDeg(1, 0, 1)).toBeCloseTo(KNOB_ROTATION_RANGE_DEG / 2, 9);
  });

  it("works for signed ranges such as dB gains", () => {
    expect(valueToRotationDeg(0, -20, 20)).toBeCloseTo(0, 9);
    expect(valueToRotationDeg(-20, -20, 20)).toBeCloseTo(-135, 9);
  });
});

describe("dragToValue", () => {
  const base = { startValue: 0.5, min: 0, max: 1 };

  it("sweeps the full range over KNOB_DRAG_RANGE_PX pixels", () => {
    expect(dragToValue({ ...base, startValue: 0, deltaPixels: KNOB_DRAG_RANGE_PX })).toBeCloseTo(1, 9);
    expect(dragToValue({ ...base, deltaPixels: KNOB_DRAG_RANGE_PX / 4 })).toBeCloseTo(0.75, 9);
  });

  it("treats downward drags as decreasing", () => {
    expect(dragToValue({ ...base, deltaPixels: -KNOB_DRAG_RANGE_PX / 4 })).toBeCloseTo(0.25, 9);
  });

  it("clamps to the parameter range", () => {
    expect(dragToValue({ ...base, deltaPixels: 10_000 })).toBe(1);
    expect(dragToValue({ ...base, deltaPixels: -10_000 })).toBe(0);
  });

  it("scales down when fine mode is on", () => {
    const coarse = dragToValue({ ...base, deltaPixels: 44 });
    const fine = dragToValue({ ...base, deltaPixels: 44, fine: true });
    expect(fine - base.startValue).toBeCloseTo((coarse - base.startValue) * KNOB_FINE_DRAG_SCALE, 9);
  });

  it("snaps to the step grid relative to the minimum", () => {
    expect(dragToValue({ startValue: 0, deltaPixels: 30, min: -20, max: 20, step: 1 })).toBeCloseTo(5, 9);
    expect(dragToValue({ startValue: 0, deltaPixels: 3, min: -20, max: 20, step: 1 })).toBeCloseTo(1, 9);
  });

  it("returns the minimum for a degenerate range", () => {
    expect(dragToValue({ startValue: 3, deltaPixels: 80, min: 5, max: 5 })).toBe(5);
  });
});

describe("panelPointToCanvas", () => {
  it("maps the panel corners onto the canvas corners", () => {
    const topLeft = panelPointToCanvas(PANEL_RECT.left, PANEL_RECT.top, 2048, 256);
    const bottomRight = panelPointToCanvas(PANEL_RECT.right, PANEL_RECT.bottom, 2048, 256);
    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
    expect(bottomRight.x).toBeCloseTo(2048, 6);
    expect(bottomRight.y).toBeCloseTo(256, 6);
  });

  it("flips the Y axis because panel space is bottom-up", () => {
    const middle = panelPointToCanvas(0, (PANEL_RECT.top + PANEL_RECT.bottom) / 2, 1000, 200);
    expect(middle.y).toBeCloseTo(100, 6);
  });
});

describe("panelPixelsPerMetre", () => {
  it("derives the texture scale from the panel width", () => {
    const width = PANEL_RECT.right - PANEL_RECT.left;
    expect(panelPixelsPerMetre(2048)).toBeCloseTo(2048 / width, 6);
  });
});

describe("formatKnobValue", () => {
  it("signs and suffixes dB values", () => {
    expect(formatKnobValue(3, "dB")).toBe("+3.0 dB");
    expect(formatKnobValue(-3.25, "dB")).toBe("-3.3 dB");
  });

  it("renders unitless values with two decimals", () => {
    expect(formatKnobValue(0.5, "")).toBe("0.50");
    expect(formatKnobValue(0.5, "amount")).toBe("0.50");
  });

  it("keeps other units suffixed", () => {
    expect(formatKnobValue(440, "Hz")).toBe("440.0 Hz");
    expect(formatKnobValue(2, "x")).toBe("2.00 x");
  });
});
