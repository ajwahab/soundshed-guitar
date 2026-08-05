/**
 * Smooth camera focus for the signal-chain 3D stage.
 */

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ChainUnitFocusAnchor } from "./units/chainUnit.js";

export interface CameraDirectorOptions {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  durationMs?: number;
}

export class CameraDirector {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly durationMs: number;
  private anim: {
    start: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null = null;

  constructor(options: CameraDirectorOptions) {
    this.camera = options.camera;
    this.controls = options.controls;
    this.durationMs = options.durationMs ?? 520;
  }

  focus(anchor: ChainUnitFocusAnchor, options?: { immediate?: boolean }): void {
    const target = anchor.position.clone();
    const distance = Math.max(0.55, anchor.fitDistance);
      // Front-biased product angle (matches chain orbit defaults).
      const azimuth = 0.18;
      const polar = 0.28;
      const offset = new THREE.Vector3(
        Math.sin(azimuth) * Math.cos(polar) * distance,
        Math.sin(polar) * distance + 0.15,
        Math.cos(azimuth) * Math.cos(polar) * distance,
      );
      const toPos = target.clone().add(offset);

      if (options?.immediate) {
        this.camera.position.copy(toPos);
        this.controls.target.copy(target);
        this.controls.update();
        this.anim = null;
        return;
      }

      this.anim = {
        start: performance.now(),
        fromPos: this.camera.position.clone(),
        toPos,
        fromTarget: this.controls.target.clone(),
        toTarget: target,
      };
    }

  /** Returns true while an animation is active. */
  update(now = performance.now()): boolean {
    if (!this.anim) return false;
    const t = Math.min(1, (now - this.anim.start) / this.durationMs);
    const e = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(this.anim.fromPos, this.anim.toPos, e);
    this.controls.target.lerpVectors(this.anim.fromTarget, this.anim.toTarget, e);
    this.controls.update();
    if (t >= 1) {
      this.anim = null;
      return false;
    }
    return true;
  }

  isAnimating(): boolean {
    return this.anim !== null;
  }
}
