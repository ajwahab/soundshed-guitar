/**
 * Maps chain unit descriptors to concrete 3D builders.
 */

import type * as THREE from "three";
import type { Amp3dThemePreset } from "./ampTheme.js";
import type { ChainUnitDesc, ChainUnitKind } from "./chainTypes.js";
import type { ChainUnit } from "./units/chainUnit.js";
import { buildAmpRigUnit } from "./units/ampRigUnit.js";
import { buildJunctionUnit } from "./units/junctionUnit.js";
import { buildPedalUnit } from "./units/pedalUnit.js";
import { buildRackUnit } from "./units/rackUnit.js";

export interface ChainUnitBuildContext {
  renderer: THREE.WebGLRenderer;
}

export type ChainUnitBuilder = (
  desc: ChainUnitDesc,
  preset: Amp3dThemePreset,
  context: ChainUnitBuildContext,
) => Promise<ChainUnit>;

export function resolveUnitBuilder(kind: ChainUnitKind): ChainUnitBuilder {
  switch (kind) {
    case "amp":
    case "cab":
    case "amp_cab_cluster":
      return (desc, preset, context) => buildAmpRigUnit(desc, preset, context);
    case "pedal":
      return (desc, preset) => buildPedalUnit(desc, preset);
    case "junction":
    case "io":
      return (desc, preset) => buildJunctionUnit(desc, preset);
    case "rack":
    case "rack_stack":
    default:
      return (desc, preset) => buildRackUnit(desc, preset);
  }
}

export async function buildChainUnit(
  desc: ChainUnitDesc,
  preset: Amp3dThemePreset,
  context: ChainUnitBuildContext,
): Promise<ChainUnit> {
  return resolveUnitBuilder(desc.kind)(desc, preset, context);
}
