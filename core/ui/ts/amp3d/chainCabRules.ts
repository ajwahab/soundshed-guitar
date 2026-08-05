/**
 * Pure helpers: cabinet counts and amp/cab product rules. No three.js / DOM.
 */

import type { ChainLayoutNodeInput } from "./chainTypes.js";

export function countLoadedResources(
  node: ChainLayoutNodeInput | undefined | null,
): number {
  if (!node || !Array.isArray(node.resources)) {
    return 0;
  }
  let count = 0;
  for (const res of node.resources) {
    const id = typeof res?.id === "string" && res.id
      ? res.id
      : (typeof res?.resourceId === "string" && res.resourceId
        ? res.resourceId
        : (typeof res?.embeddedId === "string" ? res.embeddedId : ""));
    const filePath = typeof res?.filePath === "string" ? res.filePath : "";
    if (id || filePath) {
      count += 1;
    }
  }
  return count;
}

/** Cabinet mesh count for a cab node: 0/1/2 (capped). */
export function cabinetCountForCabNode(node: ChainLayoutNodeInput | undefined | null): number {
  return Math.min(2, countLoadedResources(node));
}

/**
 * Product rule for a linear amp+cab region:
 * - full-rig amp, no cab node → 1 cab
 * - amp + cab with N IRs → N (1–2), or 1 if full-rig and empty
 * - cab only → N (0–2); empty cab still shows 1 shell at layout layer if desired
 */
export function resolveCabinetCount(options: {
  hasAmp: boolean;
  ampIsFullRig: boolean;
  cabNode?: ChainLayoutNodeInput | null;
}): number {
  const irCount = cabinetCountForCabNode(options.cabNode ?? null);
  if (options.hasAmp && options.cabNode) {
    if (irCount > 0) {
      return Math.min(2, irCount);
    }
    return options.ampIsFullRig ? 1 : 0;
  }
  if (options.hasAmp && !options.cabNode) {
    return options.ampIsFullRig ? 1 : 0;
  }
  return irCount;
}

export function shouldShowAmpHead(hasAmp: boolean): boolean {
  return hasAmp;
}
