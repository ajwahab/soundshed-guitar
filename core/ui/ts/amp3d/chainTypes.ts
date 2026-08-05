/**
 * Shared types for the full signal-chain 3D stage.
 * Pure data only — no three.js dependency.
 */

import type { Amp3dKnobSpec } from "./ampScene.js";

export type ChainUnitKind =
  | "amp"
  | "cab"
  | "amp_cab_cluster"
  | "pedal"
  | "rack"
  | "rack_stack"
  | "junction"
  | "io";

export interface ChainUnitResourceSnap {
  id: string;
  filePath: string;
}

/** One 1U faceplate inside a rack chassis (effect or blank plate). */
export interface ChainRackSlotDesc {
  nodeId: string;
  effectType: string;
  label: string;
  category: string;
  bypassed: boolean;
  knobs: Amp3dKnobSpec[];
  displayText: string;
  resources: ChainUnitResourceSnap[];
  /** Empty 1U blank plate (no interactive controls). */
  blank?: boolean;
}

export interface ChainUnitDesc {
  nodeId: string;
  effectType: string;
  label: string;
  category: string;
  kind: ChainUnitKind;
  bypassed: boolean;
  knobs: Amp3dKnobSpec[];
  displayText: string;
  resources: ChainUnitResourceSnap[];
  laneIndex: number;
  orderInLane: number;
  pairedNodeId?: string;
  cabinetCount: number;
  showHead: boolean;
  /**
   * Real effect modules hosted by this chassis, in signal-chain order
   * (rendered top → bottom). Blank plates fill remaining U spaces in the builder.
   * Primary `nodeId` is stack[0] when present.
   */
  stack?: ChainRackSlotDesc[];
  /** Fixed chassis height in rack units (default 12). */
  rackUnitCount?: number;
}

export interface ChainUnitAnchor {
  nodeId: string;
  x: number;
  y: number;
  z: number;
  fitDistance: number;
  kind: ChainUnitKind;
}

export interface ChainLaneLayout {
  laneIndex: number;
  z: number;
  unitNodeIds: string[];
}

export interface ChainLayout {
  units: ChainUnitDesc[];
  anchors: ChainUnitAnchor[];
  lanes: ChainLaneLayout[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  structureSignature: string;
}

export interface ChainLayoutNodeInput {
  id: string;
  type: string;
  displayName?: string;
  category?: string;
  bypassed?: boolean;
  enabled?: boolean;
  params?: Record<string, number>;
  resources?: Array<{ id?: string; resourceId?: string; embeddedId?: string; filePath?: string }>;
}

export interface ChainLayoutEdgeInput {
  from: string;
  to: string;
  fromPort?: number;
  toPort?: number;
  gain?: number;
}

export interface ChainLayoutGraphInput {
  nodes: ChainLayoutNodeInput[];
  edges: ChainLayoutEdgeInput[];
}

export interface ChainKnobDefInput {
  key: string;
  label: string;
  value: number;
  defaultValue?: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
}

export interface BuildChainLayoutOptions {
  graph: ChainLayoutGraphInput;
  knobsByNodeId?: Record<string, ChainKnobDefInput[]>;
  displayTextByNodeId?: Record<string, string>;
  fullRigByNodeId?: Record<string, boolean>;
  resolveType?: (type: string) => string;
  ampTypeIds?: string[];
  cabTypeIds?: string[];
  pedalTypeIds?: string[];
  junctionTypeIds?: string[];
  /** Extra effect type ids omitted from the 3D stage (utilities). */
  utilityTypeIds?: string[];
}
