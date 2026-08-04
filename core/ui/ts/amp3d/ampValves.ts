/**
 * "Inside the amp" lighting for the Neural Amp 3D view.
 *
 * When the amp is active the grille backlight alone reads as a flat wash. This
 * module adds the detail that sells a powered-up valve amp: a row of softly
 * breathing valve halos, a handful of small circuit indicators and a slow drift
 * of dust/ember particles caught in the light - all of it behind the perforated
 * grille face, so it is only ever glimpsed through the holes.
 *
 * Everything here is additive and depth-write free, sits in the thin slab
 * between the grille backlight plane and the grille face, and is driven from a
 * single `update(elapsedSeconds)` call so the effect is deterministic and can be
 * frozen for users who prefer reduced motion.
 */

import * as THREE from "three";

import { createSoftDotCanvas } from "./ampTextures.js";

/** Deterministic PRNG so the internals look identical between sessions. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export interface AmpInternalsOptions {
  /** Grille opening in amp-head local space (metres). */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Z of the grille backlight plane (the back of the visible slab). */
  glowZ: number;
  /** Z of the perforated grille face (the front of the visible slab). */
  faceZ: number;
  /** Heater colour of the valves. */
  valveColor: number;
  /** Colour used for circuit indicators and drifting particles. */
  circuitColor: number;
  /** Master brightness, driven by the theme's grille glow intensity. */
  intensity: number;
  active: boolean;
}

const VALVE_COUNT = 4;
const CIRCUIT_COUNT = 5;
const PARTICLE_COUNT = 56;

/** Fraction of the opening width the valve row spans. */
const VALVE_ROW_SPAN = 0.62;

interface ValveInstance {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  phase: number;
  rate: number;
  base: number;
}

interface CircuitInstance {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  phase: number;
  rate: number;
  base: number;
}

/**
 * Owns the animated internals. All GPU resources it creates are released by
 * `dispose`; it never touches resources owned by the scene.
 */
export class AmpInternals {
  readonly group = new THREE.Group();

  private readonly options: AmpInternalsOptions;
  private readonly dotTexture: THREE.Texture;
  private readonly valves: ValveInstance[] = [];
  private readonly circuits: CircuitInstance[] = [];
  private readonly particles: THREE.Points;
  private readonly particleMaterial: THREE.PointsMaterial;
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly particlePositions: Float32Array;
  private readonly particleColors: Float32Array;
  private readonly particleSeeds: Float32Array;
  private readonly particleBaseColor = new THREE.Color();
  private readonly heaterLight: THREE.PointLight;
  private readonly heaterLightBase: number;

  private active: boolean;
  private disposed = false;

  constructor(options: AmpInternalsOptions) {
    this.options = options;
    this.active = options.active;
    this.group.name = "AmpInternals";
    // Rendered after the opaque grille face so the additive halos blend over
    // whatever survives the grille's alpha test.
    this.group.renderOrder = 2;

    const dotCanvas = createSoftDotCanvas(128);
    this.dotTexture = new THREE.CanvasTexture(dotCanvas);
    this.dotTexture.colorSpace = THREE.NoColorSpace;
    this.dotTexture.needsUpdate = true;

    const width = options.right - options.left;
    const height = options.top - options.bottom;
    const centerX = (options.left + options.right) / 2;
    const centerY = (options.top + options.bottom) / 2;
    // Slab the internals live in: in front of the backlight plane, behind the
    // grille face, so the halos read as depth rather than as a decal.
    const slabBack = options.glowZ + 0.0008;
    const slabFront = options.faceZ - 0.0015;
    const slabDepth = Math.max(0.001, slabFront - slabBack);

    const random = createRandom(0x7a15e5);

    // ── Valve heaters ─────────────────────────────────────────────────────
    const rowWidth = width * VALVE_ROW_SPAN;
    const valveHeight = Math.min(height * 0.9, 0.14);
    const valveWidth = valveHeight * 0.7;
    for (let i = 0; i < VALVE_COUNT; i += 1) {
      const t = VALVE_COUNT < 2 ? 0.5 : i / (VALVE_COUNT - 1);
      const material = new THREE.SpriteMaterial({
        map: this.dotTexture,
        color: new THREE.Color(options.valveColor),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(valveWidth, valveHeight, 1);
      sprite.position.set(
        centerX + (t - 0.5) * rowWidth,
        centerY - height * 0.06,
        slabFront - slabDepth * 0.35,
      );
      sprite.renderOrder = 3;
      this.group.add(sprite);
      this.valves.push({
        sprite,
        material,
        phase: random() * Math.PI * 2,
        // Slightly different rates per valve so they never pulse in lockstep.
        rate: 0.55 + random() * 0.35,
        base: 0.9 + random() * 0.25,
      });
    }

    // ── Circuit indicators ────────────────────────────────────────────────
    for (let i = 0; i < CIRCUIT_COUNT; i += 1) {
      const material = new THREE.SpriteMaterial({
        map: this.dotTexture,
        color: new THREE.Color(options.circuitColor),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(material);
      const size = 0.010 + random() * 0.008;
      sprite.scale.set(size, size, 1);
      sprite.position.set(
        options.left + width * (0.08 + random() * 0.84),
        options.bottom + height * (0.08 + random() * 0.26),
        slabFront - slabDepth * (0.2 + random() * 0.5),
      );
      sprite.renderOrder = 3;
      this.group.add(sprite);
      this.circuits.push({
        sprite,
        material,
        phase: random() * Math.PI * 2,
        rate: 0.4 + random() * 1.6,
        base: 0.18 + random() * 0.22,
      });
    }

    // ── Drifting particles ────────────────────────────────────────────────
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleColors = new Float32Array(PARTICLE_COUNT * 3);
    // Per particle: [startY offset 0..1, rise speed, sway amplitude, phase]
    this.particleSeeds = new Float32Array(PARTICLE_COUNT * 4);
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      this.particlePositions[i * 3] = options.left + width * random();
      this.particlePositions[i * 3 + 1] = options.bottom + height * random();
      this.particlePositions[i * 3 + 2] = slabBack + slabDepth * random();
      this.particleSeeds[i * 4] = random();
      this.particleSeeds[i * 4 + 1] = 0.004 + random() * 0.011;
      this.particleSeeds[i * 4 + 2] = 0.004 + random() * 0.012;
      this.particleSeeds[i * 4 + 3] = random() * Math.PI * 2;
    }

    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.particlePositions, 3),
    );
    this.particleGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.particleColors, 3),
    );
    this.particleMaterial = new THREE.PointsMaterial({
      map: this.dotTexture,
      size: 0.007,
      sizeAttenuation: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    });
    this.particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    this.particles.name = "AmpInternalsParticles";
    this.particles.renderOrder = 3;
    this.particles.frustumCulled = false;
    this.group.add(this.particles);

    // A single low-range point light so the cavity and the back of the grille
    // actually receive the valve glow instead of it reading as a flat sprite.
    this.heaterLightBase = 0.055 * Math.max(0.2, options.intensity);
    this.heaterLight = new THREE.PointLight(options.valveColor, 0, 0.22, 2);
    this.heaterLight.position.set(centerX, centerY, slabBack);
    this.group.add(this.heaterLight);

    this.group.visible = this.active;
    // Deterministic resting pose: what reduced-motion users (and the very first
    // frame) see before any animation runs.
    this.update(0);
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) {
      return;
    }
    this.active = active;
    this.group.visible = active;
  }

  get isActive(): boolean {
    return this.active && !this.disposed;
  }

  /**
   * Advances the animation. `elapsedSeconds` is absolute time since the view
   * was created, so the motion is a pure function of it (no accumulated drift).
   */
  update(elapsedSeconds: number): void {
    if (this.disposed || !this.active) {
      return;
    }

    const t = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const master = Math.max(0.15, this.options.intensity);

    for (const valve of this.valves) {
      // Two detuned sines: a slow breath plus a faint mains-ish shimmer. Kept
      // well under a 30% swing so it never reads as a strobe.
      const wobble = 0.88
        + 0.08 * Math.sin(t * valve.rate + valve.phase)
        + 0.04 * Math.sin(t * valve.rate * 3.1 + valve.phase * 1.7);
      valve.material.opacity = valve.base * master * wobble;
    }

    for (const circuit of this.circuits) {
      const pulse = 0.5 + 0.5 * Math.sin(t * circuit.rate + circuit.phase);
      circuit.material.opacity = circuit.base * master * (0.35 + 0.65 * pulse);
    }

    this.updateParticles(t, master);

    this.heaterLight.intensity = this.heaterLightBase * (0.85 + 0.15 * Math.sin(t * 0.7));
  }

  private updateParticles(t: number, master: number): void {
    const { left, right, top, bottom, circuitColor } = this.options;
    const width = right - left;
    const height = top - bottom;
    this.particleBaseColor.set(circuitColor);

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      const start = this.particleSeeds[i * 4];
      const speed = this.particleSeeds[i * 4 + 1];
      const sway = this.particleSeeds[i * 4 + 2];
      const phase = this.particleSeeds[i * 4 + 3];

      // Normalised height, wrapping so particles reappear at the bottom.
      const travel = (start + (t * speed) / height) % 1;
      const y = bottom + travel * height;
      const baseX = left + width * ((start * 7.13) % 1);
      const x = baseX + Math.sin(t * 0.6 + phase) * sway;

      this.particlePositions[i * 3] = THREE.MathUtils.clamp(x, left, right);
      this.particlePositions[i * 3 + 1] = y;

      // Fade in off the floor of the cavity and out again at the top so
      // particles never pop in or out of existence.
      const fade = Math.sin(Math.PI * travel);
      const twinkle = 0.65 + 0.35 * Math.sin(t * 1.7 + phase * 2.3);
      const level = THREE.MathUtils.clamp(fade * twinkle * 0.95 * master, 0, 1);
      this.particleColors[i * 3] = this.particleBaseColor.r * level;
      this.particleColors[i * 3 + 1] = this.particleBaseColor.g * level;
      this.particleColors[i * 3 + 2] = this.particleBaseColor.b * level;
    }

    this.particleGeometry.attributes.position.needsUpdate = true;
    this.particleGeometry.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.valves.forEach((valve) => {
      valve.sprite.removeFromParent();
      valve.material.dispose();
    });
    this.valves.length = 0;

    this.circuits.forEach((circuit) => {
      circuit.sprite.removeFromParent();
      circuit.material.dispose();
    });
    this.circuits.length = 0;

    this.particles.removeFromParent();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();

    this.heaterLight.removeFromParent();
    this.heaterLight.dispose();

    this.dotTexture.dispose();
    this.group.removeFromParent();
  }
}
