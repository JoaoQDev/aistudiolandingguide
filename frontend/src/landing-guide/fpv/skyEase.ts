import * as THREE from 'three';

/**
 * Temporal easing of the mission lighting (Sun / Earth directions, solar illumination).
 *
 * Time playback hands the scene a new state every ~180 ms in hourly steps; easing toward it with
 * an exponential makes the motion continuous. The step is exact for any frame time (two steps of
 * dt/2 land where one step of dt does), so the look does not depend on the frame rate. The first
 * value and very large jumps (site switch) are applied instantly.
 *
 * The sky and the ground each own an `EasedSun` fed with the same calls and the same frame `dt`,
 * so the light, the Sun disc and the terrain shader always use the same direction.
 */

/** Time constant (s) of the ease toward a new direction / illumination. */
export const LIGHT_EASE_TAU_S = 0.4;
/** A direction change larger than this (degrees) is a site switch, not playback: it snaps. */
export const LIGHT_SNAP_ANGLE_DEG = 25;

const SNAP_ANGLE_RAD = (LIGHT_SNAP_ANGLE_DEG * Math.PI) / 180;
const DIR_EPS_RAD = 1e-5;
const SCALAR_EPS = 1e-4;

/** Fraction of the remaining distance covered after `dt` seconds (0 for dt ≤ 0 or NaN). */
export function easeAlpha(dt: number, tau: number = LIGHT_EASE_TAU_S): number {
  if (!(dt > 0)) return 0;
  return 1 - Math.exp(-dt / tau);
}

const isFiniteVec = (v: THREE.Vector3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Unit direction that eases along the great circle toward its target. */
export class EasedDirection {
  readonly value = new THREE.Vector3();
  readonly target = new THREE.Vector3();
  private primed = false;

  constructor(initial: THREE.Vector3) {
    this.value.copy(initial).normalize();
    this.target.copy(this.value);
  }

  /** Sets a new target. Returns true when the value snapped (first call or a jump beyond the snap angle). */
  set(dir: THREE.Vector3): boolean {
    if (!isFiniteVec(dir) || dir.lengthSq() < 1e-12) return false;
    this.target.copy(dir).normalize();
    if (!this.primed || this.value.angleTo(this.target) > SNAP_ANGLE_RAD) {
      this.primed = true;
      this.value.copy(this.target);
      return true;
    }
    return false;
  }

  /** Advances by `dt` seconds. Returns true while the value is still moving. */
  step(dt: number): boolean {
    const angle = this.value.angleTo(this.target);
    if (angle < DIR_EPS_RAD) {
      if (angle === 0) return false;
      this.value.copy(this.target);
      return true;
    }
    const a = easeAlpha(dt);
    if (a <= 0) return false;
    // Spherical interpolation: the remaining angle decays exactly as exp(−dt/τ).
    const sin = Math.sin(angle);
    if (sin < 1e-6) {
      this.value.lerp(this.target, a).normalize();
    } else {
      const w0 = Math.sin((1 - a) * angle) / sin;
      const w1 = Math.sin(a * angle) / sin;
      this.value.multiplyScalar(w0).addScaledVector(this.target, w1).normalize();
    }
    return true;
  }
}

/** Scalar that eases exponentially toward its target. */
export class EasedScalar {
  value: number;
  target: number;
  private primed = false;

  constructor(
    initial: number,
    private readonly tau: number = LIGHT_EASE_TAU_S,
  ) {
    this.value = initial;
    this.target = initial;
  }

  /** Sets a new target; the first call (or `snap`) applies it instantly. */
  set(v: number, snap = false): void {
    if (!Number.isFinite(v)) return;
    this.target = v;
    if (!this.primed || snap) {
      this.primed = true;
      this.value = v;
    }
  }

  /** Advances by `dt` seconds. Returns true while the value is still moving. */
  step(dt: number): boolean {
    const d = this.target - this.value;
    if (d === 0) return false;
    if (Math.abs(d) < SCALAR_EPS) {
      this.value = this.target;
      return true;
    }
    const a = easeAlpha(dt, this.tau);
    if (a <= 0) return false;
    this.value += d * a;
    return true;
  }
}

/**
 * Eased Sun state shared (by construction, not by reference) between sky and ground: direction
 * toward the Sun and the fraction of the solar disc above the real terrain horizon.
 * When the direction snaps (site switch) the next illumination value snaps with it.
 */
export class EasedSun {
  readonly dir: EasedDirection;
  readonly illum = new EasedScalar(1);
  private snapIllum = false;

  constructor(initialDir: THREE.Vector3) {
    this.dir = new EasedDirection(initialDir);
  }

  /** Current eased direction (unit, world space). */
  get direction(): THREE.Vector3 {
    return this.dir.value;
  }

  /** Current eased illumination fraction, 0..1. */
  get illumination(): number {
    return this.illum.value;
  }

  setDirection(dir: THREE.Vector3): void {
    if (this.dir.set(dir)) this.snapIllum = true;
  }

  setIllumination(fraction: number): void {
    if (!Number.isFinite(fraction)) return;
    this.illum.set(Math.min(1, Math.max(0, fraction)), this.snapIllum);
    this.snapIllum = false;
  }

  /** Advances both values. Returns true while anything is still moving. */
  step(dt: number): boolean {
    const a = this.dir.step(dt);
    const b = this.illum.step(dt);
    return a || b;
  }
}
