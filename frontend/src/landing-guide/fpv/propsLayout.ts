import type { SpawnPose } from './types';

/**
 * World layout of the moonbase (metres, -Z = North, azimuth clockwise from North), authored for
 * the illustrative Sun at azimuth ≈ 252°, elevation 10° and composed so that each reference frame
 * of the walk can be framed from some pose (REFERENCE_POSES). Measured scale cues: eye 1.7 m,
 * tanks 1.8 m, hazard containers 2.3 × 1.25 × 1.3 m, ship ≈ 25 m long / 7.5 m tall.
 */

const DEG = Math.PI / 180;

/** Horizontal point at `bearingDeg` (clockwise from North/-Z) and `dist` metres from (ox, oz). */
export function polar(bearingDeg: number, dist: number, ox = 0, oz = 0): { x: number; z: number } {
  return { x: ox + Math.sin(bearingDeg * DEG) * dist, z: oz - Math.cos(bearingDeg * DEG) * dist };
}

/** Bearing (deg, clockwise from North) from (fx, fz) to (tx, tz). */
export function bearing(fx: number, fz: number, tx: number, tz: number): number {
  return ((Math.atan2(tx - fx, -(tz - fz)) / DEG) % 360 + 360) % 360;
}

/** Spawn = reference frame t01: ship ahead-right, rover and dark crate row on the left. */
export const MOONBASE_SPAWN: SpawnPose = { x: 0, z: 0, yawDeg: 50, pitchDeg: -4 };

/** Ship centre and the azimuth of its nose → tail axis (+X local); its +Z flank faces the spawn and the Sun. */
export const SHIP_CENTER = polar(54.5, 36);
export const SHIP_AXIS_AZ = 130;

/** Ship-local (x along nose → tail, z toward the sunlit flank) → world XZ. */
export function shipLocal(lx: number, lz: number): { x: number; z: number } {
  const yaw = (90 - SHIP_AXIS_AZ) * DEG;
  return {
    x: SHIP_CENTER.x + Math.cos(yaw) * lx + Math.sin(yaw) * lz,
    z: SHIP_CENTER.z - Math.sin(yaw) * lx + Math.cos(yaw) * lz,
  };
}

/**
 * Backlit group toward the Sun (t08, t12, t21, t30): row modules with a dark crate on top, and a
 * tank pair 8 m beyond them.
 */
export const SUNWARD_CRATES = { x: -24, z: 8 };
export const SUNWARD_TANKS = polar(226, 8.3, SUNWARD_CRATES.x, SUNWARD_CRATES.z);
/** Lone dark crate 6 m beyond the group on the t12 line of sight (t47 foreground). */
export const SUNWARD_LONE_CRATE = polar(273.7, 6.2, SUNWARD_CRATES.x, SUNWARD_CRATES.z);

/** Viewpoint the second container row is composed around (t41.5, t43, t47). */
export const T41_VIEW: SpawnPose = { x: 70, z: -70, yawDeg: 42, pitchDeg: -3 };

/**
 * Greenhouse: far beyond the sunward crest. In the reference it keeps the same bearing (≈ 13–14°
 * left of the Sun) and size in every sunward frame while the nearby groups shift by up to 25°,
 * which only a distant dome reproduces; glass ≈ 160–180 px wide at 1920 × 940 / 60° vFOV.
 */
export const GREENHOUSE_CENTER = polar(238.6, 380);
export const GREENHOUSE_RADIUS = 38;

/**
 * Poses reproducing the reference frames (round-2 pose table; `?fpvPose=x,z,yaw,pitch`). Sunward
 * yaw/pitch are solved from the Sun's pixel position (azimuth 252°, elevation 10°), ship-side poses
 * from matched ship / tank / container screen points. t05 is only approximate: no rigid layout
 * puts the ship's head 63° right of the Sun with the containers 10 m away as in the reference.
 */
export const REFERENCE_POSES: Record<string, SpawnPose> = {
  t01: { ...MOONBASE_SPAWN },
  t05: { x: 34.5, z: -2.2, yawDeg: 294.1, pitchDeg: -2.4 },
  t08: { x: 1.63, z: 8.77, yawDeg: 243.3, pitchDeg: -15.5 },
  t12: { x: -5.24, z: 9.21, yawDeg: 262.2, pitchDeg: -2.1 },
  t15: { x: 8.72, z: -9.89, yawDeg: 54.3, pitchDeg: -0.7 },
  t17: { x: 13.31, z: -12.0, yawDeg: 73.7, pitchDeg: -3.9 },
  't18.5': { x: 16.64, z: -13.15, yawDeg: 70.3, pitchDeg: -1.0 },
  t21: { x: 4.18, z: -7.17, yawDeg: 257.7, pitchDeg: -2.6 },
  t30: { x: 4.18, z: -7.17, yawDeg: 241.6, pitchDeg: -4.5 },
  t37: { x: -34, z: 12, yawDeg: 243.15, pitchDeg: -4.95 },
  t39: { x: -33, z: 9, yawDeg: 254.9, pitchDeg: -7.4 },
  't41.5': { ...T41_VIEW },
  t43: { x: 70.5, z: -69.5, yawDeg: 39, pitchDeg: -3 },
  t47: { x: -29.2, z: 5.48, yawDeg: 240.1, pitchDeg: 0.3 },
};
