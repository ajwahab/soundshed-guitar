/**
 * Public entry point for the Neural Amp 3D view.
 *
 * Import this module dynamically (`await import("./amp3d/index.js")`) so the
 * vendored three.js bundle is only fetched when a user actually switches a
 * Neural Amp effect into 3D mode.
 */

export { Amp3dView, isWebglAvailable } from "./ampView.js";
export type { Amp3dViewOptions } from "./ampView.js";
export type { Amp3dKnobSpec } from "./ampScene.js";
export { MAX_PANEL_KNOBS } from "./ampLayout.js";
