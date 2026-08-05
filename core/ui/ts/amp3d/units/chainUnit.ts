/**
 * Shared contract for a single unit in the signal-chain 3D stage.
 */

import type * as THREE from "three";
import type { Amp3dKnobSpec } from "../ampScene.js";

export interface ChainUnitFocusAnchor {
  position: THREE.Vector3;
  fitDistance: number;
  /** Optional world-space AABB for FOV-accurate framing. */
  bounds?: THREE.Box3;
}

export interface ChainUnit {
  readonly nodeId: string;
  readonly root: THREE.Group;
  readonly pairedNodeId?: string;
  /** All effect node ids hosted by this unit (rack stacks, amp+cab, …). */
  readonly hostedNodeIds?: string[];
  setParams(params: Record<string, number>, nodeId?: string): void;
  setKnobSpecs?(knobs: Amp3dKnobSpec[], nodeId?: string): void;
  setBypassed(bypassed: boolean, nodeId?: string): void;
  setHighlighted(active: boolean, focusNodeId?: string): void;
  setDisplayText?(text: string, nodeId?: string): void;
  /** Optional focusNodeId picks amp head vs cab, or a rack slot faceplate. */
  getFocusAnchor(focusNodeId?: string): ChainUnitFocusAnchor;
  getPickMeshes(): THREE.Object3D[];
  getKnobMeshes(): THREE.Object3D[];
  getBypassMeshes(): THREE.Object3D[];
  getKnobSpec(key: string, nodeId?: string): Amp3dKnobSpec | undefined;
  setKnobValue(key: string, value: number, nodeId?: string): void;
  /** Optional per-frame motion (power ramps, marquees). */
  update?(elapsedSeconds: number): void;
  isAnimated?(): boolean;
  dispose(): void;
}

export interface GenericUnitMaterials {
  body: THREE.MeshStandardMaterial;
  face: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  knob: THREE.MeshStandardMaterial;
  ledOn: THREE.MeshStandardMaterial;
  ledOff: THREE.MeshStandardMaterial;
  label: THREE.MeshStandardMaterial;
}
