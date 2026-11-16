import * as THREE from 'three';

/**
 * How the scene lighting follows the real mission conditions: pure look functions shared by the
 * sky and the ground (so both fade the same way), plus the night-only lights.
 *
 * `f` is the fraction of the solar disc above the real terrain horizon (dataset-derived): 1 = full
 * Sun, 0 = night at the site. Everything Sun-driven scales with it. As it goes to 0 the night
 * look fades in: a camera-following helmet lamp, a faint bluish earthshine when the Earth is up,
 * a very dim ambient (starlight stand-in) and the star field. At f = 1 every night term is
 * exactly 0, so daylight renders as it always did.
 * Illustrative lighting: none of these levels is a measurement.
 */

const DEG = Math.PI / 180;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Night terms (lamp, earthshine, dim ambient) are fully off from this illumination fraction up. */
export const NIGHT_FADE_END = 0.35;

/** 0 in daylight … 1 at night: weight of the helmet lamp, the earthshine and the night ambient. */
export function nightFactor(f: number): number {
  return 1 - smoothstep(0, NIGHT_FADE_END, f);
}

/** Star-field brightness: stars come out as the Sun goes and are hidden in daylight. */
export function starGain(f: number): number {
  return 1 - smoothstep(0, 0.45, f);
}

/**
 * Brightness of the Sun disc and halo. The disc sinks behind the terrain by itself (depth test),
 * so it keeps its white core while a good part of it is still up and only fades at the very end.
 */
export function sunGlowGain(f: number): number {
  return smoothstep(0, 0.3, f);
}

/** Gate (0..1) for the Sun-only terms of the regolith shader: exactly 1 whenever the Sun is up. */
export function sunGate(f: number): number {
  return smoothstep(0, 0.05, f);
}

/** Lunar-like diffuse compression used by the regolith shader: F = 2μ / (μ + k). */
export const REGOLITH_PHOT_K = 0.35;
/** Drawn Sun elevation (deg) the daylight look was tuned at; at and above it nothing changes. */
export const TUNED_SUN_EL_DEG = 10;
const SIN_TUNED = Math.sin(TUNED_SUN_EL_DEG * DEG);

/**
 * Regolith bounce relative to the tuned look, 0..1: with a lower Sun the plain itself is dimmer,
 * so it throws less light back onto shaded prop faces. Keeps a floor (grazing light still scatters
 * off every clod and slope turned to the Sun) so silhouettes stay readable at sunrise and sunset.
 */
export function groundBounce(sinEl: number): number {
  const s = Math.max(0, sinEl);
  if (s >= SIN_TUNED) return 1;
  const ratio = ((2 * s) / (s + REGOLITH_PHOT_K)) / ((2 * SIN_TUNED) / (SIN_TUNED + REGOLITH_PHOT_K));
  return 0.3 + 0.7 * ratio;
}

/**
 * Strength of the cast (shadow-map) shadows, 0..1. Near the horizon shadows grow without bound
 * and outrun the shadow box, so they are faded out before the light itself goes.
 */
export function shadowFade(sinEl: number): number {
  return smoothstep(Math.sin(0.3 * DEG), Math.sin(2.2 * DEG), sinEl);
}

/**
 * 0 at the tuned elevation and above … 1 for a very low Sun: drives the longer, stronger
 * received shadows on the regolith (long light) without touching the tuned daylight look.
 */
export function lowSunFactor(sinEl: number): number {
  return 1 - smoothstep(Math.sin(3 * DEG), SIN_TUNED, sinEl);
}

/** 0 when the Earth is behind the game horizon … 1 when its whole disc is up. */
export function earthUpFactor(sinEl: number): number {
  return smoothstep(Math.sin(-1 * DEG), Math.sin(2 * DEG), sinEl);
}

/** Lit fraction of the Earth's disc seen from the Moon for the given Sun / Earth directions. */
export function earthLitFraction(sunDir: THREE.Vector3, earthDir: THREE.Vector3): number {
  // "Full Earth" when the Sun is opposite to it in the sky, "new Earth" when they line up.
  return THREE.MathUtils.clamp(0.5 * (1 - sunDir.dot(earthDir)), 0, 1);
}

// --- Night light levels (linear, before exposure). The tone mapper's toe is quadratic, so these
// --- sit higher than their on-screen result suggests; tints are faint because the toe amplifies them.

/** Hemisphere fill at night (sky / ground colours): keeps shaded prop faces off pure black. */
export const NIGHT_HEMI_SKY: readonly [number, number, number] = [0.15, 0.165, 0.2];
export const NIGHT_HEMI_GROUND: readonly [number, number, number] = [0.045, 0.05, 0.06];
/** Ambient irradiance factor on the regolith at night (× albedo): the plain stays barely visible. */
export const NIGHT_REGOLITH_AMBIENT: readonly [number, number, number] = [0.078, 0.084, 0.098];

/** Earthshine: DirectionalLight intensity for a full Earth well above the horizon, and its tint. */
export const EARTHSHINE_INTENSITY = 0.5;
export const EARTHSHINE_COLOR: readonly [number, number, number] = [0.8, 0.88, 1.0];

/** Earthshine DirectionalLight intensity for the current geometry and illumination. */
export function earthshineIntensity(f: number, sunDir: THREE.Vector3, earthDir: THREE.Vector3): number {
  const phase = 0.35 + 0.65 * earthLitFraction(sunDir, earthDir);
  return EARTHSHINE_INTENSITY * nightFactor(f) * earthUpFactor(earthDir.y) * phase;
}

// --- Helmet lamp ---

/** Reach of the helmet lamp (m): the light is gone at this distance. */
export const HELMET_LAMP_REACH_M = 28;
export const HELMET_LAMP_INTENSITY = 6.5;
/** Cool white. */
export const HELMET_LAMP_COLOR: readonly [number, number, number] = [0.8, 0.88, 1.0];
const LAMP_CONE_RAD = 56 * DEG;
const LAMP_DECAY = 0.62;
/** Lamp sits at the helmet, slightly above and to the right of the eye. */
const LAMP_OFFSET = new THREE.Vector3(0.12, 0.14, 0);
const LAMP_AIM_DISTANCE = 10;

export interface HelmetLamp {
  light: THREE.SpotLight;
  /** 0 = off (daylight) … 1 = full night. */
  setGain(gain: number): void;
  update(camera: THREE.PerspectiveCamera): void;
  dispose(): void;
}

/**
 * Soft spot light that follows the camera. It stays in the scene with intensity 0 in daylight
 * (toggling `visible` would change the light count and recompile every lit material).
 */
export function createHelmetLamp(): HelmetLamp {
  const light = new THREE.SpotLight(0xffffff, 0, HELMET_LAMP_REACH_M, LAMP_CONE_RAD, 1, LAMP_DECAY);
  light.name = 'helmet-lamp';
  light.color.setRGB(HELMET_LAMP_COLOR[0], HELMET_LAMP_COLOR[1], HELMET_LAMP_COLOR[2]);
  light.castShadow = false;
  const camPos = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  return {
    light,
    setGain(gain) {
      light.intensity = HELMET_LAMP_INTENSITY * THREE.MathUtils.clamp(gain, 0, 1);
    },
    update(camera) {
      camera.getWorldPosition(camPos);
      camera.getWorldQuaternion(camQuat);
      camera.getWorldDirection(forward);
      offset.copy(LAMP_OFFSET).applyQuaternion(camQuat);
      light.position.copy(camPos).add(offset);
      light.target.position.copy(camPos).addScaledVector(forward, LAMP_AIM_DISTANCE);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
    },
    dispose() {
      light.dispose();
    },
  };
}

/** Bluish DirectionalLight from the Earth's direction; kept in the scene at intensity 0 by day. */
export function createEarthshineLight(): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.name = 'earthshine';
  light.color.setRGB(EARTHSHINE_COLOR[0], EARTHSHINE_COLOR[1], EARTHSHINE_COLOR[2]);
  light.castShadow = false;
  return light;
}
