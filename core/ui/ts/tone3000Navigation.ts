/**
 * Walking a captured Tone3000 result set.
 *
 * A search returns tones, each holding several models, and only the tones the
 * user expanded have had their models fetched. Navigation therefore walks the
 * set lazily: the models of a tone are loaded at the moment stepping reaches
 * it, and the list wraps so next/previous is always available.
 */

import type { Tone3000Model, Tone3000Tone } from "./tone3000ApiTypes.js";

export interface Tone3000NavigationPosition {
  /// Index into the tone list, or -1 when the loaded resource is not part of
  /// this result set (picked from the library, or the filters have moved on).
  toneIndex: number;
  modelId: string;
}

export type Tone3000ModelLoader = (tone: Tone3000Tone) => Promise<Tone3000Model[]>;

/**
 * Locates a tone/model pair in the result set. The tone id is matched first;
 * failing that (older imports recorded no tone id) the already-loaded model
 * lists are searched for the model itself.
 */
export function locateTone3000Position(
  tones: Tone3000Tone[],
  modelsByToneId: Map<string, Tone3000Model[]>,
  toneId: string,
  modelId: string,
): Tone3000NavigationPosition {
  let toneIndex = toneId
    ? tones.findIndex((tone) => String(tone.id) === toneId)
    : -1;

  if (toneIndex < 0 && modelId) {
    toneIndex = tones.findIndex((tone) => (modelsByToneId.get(String(tone.id)) ?? [])
      .some((model) => String(model.id) === modelId));
  }

  return { toneIndex, modelId };
}

/**
 * The model one step from `position` in result order, loading each tone's
 * models as it reaches them. Tones that yield no models are skipped rather than
 * stalling navigation, and the walk wraps around the end of the set.
 */
export async function findAdjacentTone3000Model(
  tones: Tone3000Tone[],
  position: Tone3000NavigationPosition,
  direction: number,
  loadModels: Tone3000ModelLoader,
): Promise<{ tone: Tone3000Tone; model: Tone3000Model } | null> {
  const toneCount = tones.length;
  if (!toneCount) {
    return null;
  }

  const step = direction >= 0 ? 1 : -1;
  // An unlocated resource enters the list from the matching end rather than
  // stepping relative to a position we do not have.
  let toneIndex = position.toneIndex >= 0 ? position.toneIndex : (step > 0 ? 0 : toneCount - 1);
  let models = await loadModels(tones[toneIndex]);
  const modelIndex = position.toneIndex >= 0 && position.modelId
    ? models.findIndex((model) => String(model.id) === position.modelId)
    : -1;
  let nextIndex = modelIndex >= 0 ? modelIndex + step : (step > 0 ? 0 : models.length - 1);

  for (let visited = 0; visited <= toneCount; visited += 1) {
    if (nextIndex >= 0 && nextIndex < models.length) {
      return { tone: tones[toneIndex], model: models[nextIndex] };
    }

    toneIndex = (((toneIndex + step) % toneCount) + toneCount) % toneCount;
    models = await loadModels(tones[toneIndex]);
    nextIndex = step > 0 ? 0 : models.length - 1;
  }

  return null;
}
