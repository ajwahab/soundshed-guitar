/**
 * Public entry point for the signal-chain / amp 3D views.
 *
 * Import this module dynamically (`await import("./amp3d/index.js")`) so the
 * vendored three.js bundle is only fetched when a user enables 3D mode.
 */

export { Amp3dView, isWebglAvailable } from "./ampView.js";
export type { Amp3dViewOptions } from "./ampView.js";
export type { Amp3dKnobSpec } from "./ampScene.js";
export { MAX_PANEL_KNOBS } from "./ampLayout.js";

export {
  isSignalChain3dEnabled,
  setSignalChain3dEnabled,
  isNeuralAmp3dViewEnabled,
  setNeuralAmp3dViewEnabled,
  isWebglSupported,
  SIGNAL_CHAIN_3D_SETTING,
  NEURAL_AMP_3D_SETTING,
} from "./ampSupport.js";

export { Chain3dView } from "./chainView.js";
export type { Chain3dViewOptions } from "./chainView.js";
export { buildChainLayout, collectChainLanes, findAnchorForNode, findUnitForNode } from "./chainLayout.js";
export type {
  BuildChainLayoutOptions,
  ChainLayout,
  ChainLayoutGraphInput,
  ChainUnitDesc,
} from "./chainTypes.js";
export {
  cabinetCountForCabNode,
  countLoadedResources,
  resolveCabinetCount,
} from "./chainCabRules.js";
