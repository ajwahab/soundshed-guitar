/**
 * Lighting / grading presets for the Neural Amp 3D view.
 *
 * The app themes are `dark`, `light` and `classic` (displayed as "Vintage").
 * Each preset is a small physically-plausible studio setup rather than an
 * arbitrary colour tweak: a key light, a cooler fill, a rim light, ambient
 * bounce, an environment intensity and a tone-mapping exposure.
 */

import type { ThemeName } from "../theme-switcher.js";

export interface Amp3dLightSetting {
  color: number;
  intensity: number;
  position: [number, number, number];
}

export interface Amp3dThemePreset {
  /** Tone mapping exposure applied to the renderer. */
  exposure: number;
  /** Vertical background gradient behind the amp. */
  backgroundTop: number;
  backgroundBottom: number;
  ambientColor: number;
  ambientIntensity: number;
  /** Intensity multiplier applied to the generated environment map. */
  environmentIntensity: number;
  key: Amp3dLightSetting;
  fill: Amp3dLightSetting;
  rim: Amp3dLightSetting;
  /** Colour/strength of the light spilling through the front grille. */
  grilleGlowColor: number;
  grilleGlowIntensity: number;
  /** Power LED colour when the effect is active. */
  ledColor: number;
  ledIntensity: number;
  /** Opacity of the contact shadow the amp casts on the floor. */
  shadowOpacity: number;
  floorColor: number;
  /** Silkscreen colours for the generated control panel texture. */
  panelBase: string;
  panelTint: string;
  panelText: string;
  panelTextMuted: string;
  displayColor: string;
  tolexTint: string;
}

const DARK_PRESET: Amp3dThemePreset = {
  exposure: 0.95,
  backgroundTop: 0x14171d,
  backgroundBottom: 0x05070a,
  ambientColor: 0x38414f,
  ambientIntensity: 0.5,
  environmentIntensity: 0.6,
  key: { color: 0xfdfaf4, intensity: 2.8, position: [0.55, 0.85, 1.15] },
  fill: { color: 0x9aa6bd, intensity: 0.65, position: [-0.95, 0.15, 0.85] },
  rim: { color: 0xbcd8f2, intensity: 1.0, position: [-0.5, 0.6, -1.1] },
  grilleGlowColor: 0x3f7bff,
  grilleGlowIntensity: 1.35,
  ledColor: 0x4d8cff,
  ledIntensity: 3.4,
  shadowOpacity: 0.55,
  floorColor: 0x0d1014,
  panelBase: "#c9cbd0",
  panelTint: "#e8eaee",
  panelText: "#15171b",
  panelTextMuted: "#494d55",
  displayColor: "#7fd2ff",
  tolexTint: "#1a1512",
};

const LIGHT_PRESET: Amp3dThemePreset = {
  exposure: 1.2,
  backgroundTop: 0xf1f3f6,
  backgroundBottom: 0xc9ced6,
  ambientColor: 0xf5f7ff,
  ambientIntensity: 1.1,
  environmentIntensity: 1.15,
  key: { color: 0xffffff, intensity: 3.1, position: [0.7, 1.1, 1.25] },
  fill: { color: 0xdfe8ff, intensity: 1.4, position: [-1.05, 0.3, 0.95] },
  rim: { color: 0xffffff, intensity: 1.1, position: [-0.4, 0.75, -1.05] },
  grilleGlowColor: 0x4f86ff,
  grilleGlowIntensity: 0.85,
  ledColor: 0x2f6fff,
  ledIntensity: 2.4,
  shadowOpacity: 0.32,
  floorColor: 0xb9bec6,
  panelBase: "#e4e6ea",
  panelTint: "#fbfcfd",
  panelText: "#10131a",
  panelTextMuted: "#5a6069",
  displayColor: "#2f9fd6",
  tolexTint: "#2a221d",
};

const VINTAGE_PRESET: Amp3dThemePreset = {
  exposure: 1.05,
  backgroundTop: 0x2b2118,
  backgroundBottom: 0x0d0907,
  ambientColor: 0x5a3f28,
  ambientIntensity: 0.7,
  environmentIntensity: 0.7,
  key: { color: 0xffcf96, intensity: 2.8, position: [0.6, 0.9, 1.1] },
  fill: { color: 0xa9713c, intensity: 1.0, position: [-0.9, 0.2, 0.9] },
  rim: { color: 0xffb060, intensity: 1.3, position: [-0.55, 0.55, -1.1] },
  grilleGlowColor: 0xffa542,
  grilleGlowIntensity: 1.15,
  ledColor: 0xff9b3d,
  ledIntensity: 3.0,
  shadowOpacity: 0.5,
  floorColor: 0x17110c,
  panelBase: "#c8b48c",
  panelTint: "#e7d7b4",
  panelText: "#241a10",
  panelTextMuted: "#5c4a33",
  displayColor: "#ffb765",
  tolexTint: "#2c1d12",
};

const PRESETS: Record<ThemeName, Amp3dThemePreset> = {
  dark: DARK_PRESET,
  light: LIGHT_PRESET,
  classic: VINTAGE_PRESET,
};

export function getAmp3dThemePreset(theme: ThemeName): Amp3dThemePreset {
  return PRESETS[theme] ?? DARK_PRESET;
}
