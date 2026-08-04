/**
 * Capability + preference helpers for the Neural Amp 3D view.
 *
 * Deliberately free of three.js imports so the effect panel can decide whether
 * to offer the 3D view without pulling the (large) renderer into the initial
 * page load. three.js is only fetched by the dynamic import in signalPath.ts.
 */

import { setAppSetting } from "../bridge.js";
import { uiState } from "../state.js";

export const NEURAL_AMP_3D_SETTING = "ui.neuralAmp3dView.enabled";

let cachedWebglSupport: boolean | null = null;

/** True when the WebView can create a WebGL context for the 3D view. */
export function isWebglSupported(): boolean {
  if (cachedWebglSupport !== null) {
    return cachedWebglSupport;
  }
  try {
    if (typeof document === "undefined" || typeof window === "undefined" || !window.WebGLRenderingContext) {
      cachedWebglSupport = false;
      return cachedWebglSupport;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    cachedWebglSupport = Boolean(context);
    // Release the probe context immediately; contexts are a limited resource.
    (context as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cachedWebglSupport = false;
  }
  return cachedWebglSupport;
}

/** User preference: render Neural Amp nodes as the 3D amp instead of knobs. */
export function isNeuralAmp3dViewEnabled(): boolean {
  return uiState.appSettings?.[NEURAL_AMP_3D_SETTING] === true;
}

export function setNeuralAmp3dViewEnabled(enabled: boolean): void {
  uiState.appSettings[NEURAL_AMP_3D_SETTING] = enabled;
  setAppSetting(NEURAL_AMP_3D_SETTING, enabled);
}
