import type * as THREE from 'three';

/**
 * Skyline of the illustrative terrain as seen from the player, used by the sky to know how much
 * of the Sun's disc the ground hides (the disc itself is depth-tested; its halo is a glare with
 * no depth, so it has to be faded by hand as the disc sinks behind a ridge).
 *
 * The ground mesh registers its height function here, keyed by its own Object3D, so the sky can
 * find it through the scene graph without any extra wiring between the two modules.
 */

export type HeightFn = (x: number, z: number) => number;

export const GROUND_OBJECT_NAME = 'lunar-ground';

const HEIGHT_FNS = new WeakMap<THREE.Object3D, HeightFn>();

export function registerGroundHeight(ground: THREE.Object3D, heightAt: HeightFn): void {
  HEIGHT_FNS.set(ground, heightAt);
}

export function unregisterGroundHeight(ground: THREE.Object3D): void {
  HEIGHT_FNS.delete(ground);
}

/** Height function of the ground mesh in `scene`, or null when there is none (tests, other scenes). */
export function findGroundHeight(scene: THREE.Object3D): HeightFn | null {
  const ground = scene.getObjectByName(GROUND_OBJECT_NAME);
  return (ground && HEIGHT_FNS.get(ground)) ?? null;
}

/** First and last sample distances (m) and the growth of the step between samples. */
const SCAN_START_M = 3;
const SCAN_END_M = 4600;
const SCAN_GROWTH = 1.075;

/**
 * Highest elevation angle (radians) of the terrain seen from (x, eyeY, z) along the horizontal
 * unit direction (dirX, dirZ). About 100 height lookups.
 */
export function skylineElevation(heightAt: HeightFn, x: number, eyeY: number, z: number, dirX: number, dirZ: number): number {
  let best = -Math.PI / 2;
  for (let d = SCAN_START_M; d < SCAN_END_M; d *= SCAN_GROWTH) {
    const e = Math.atan2(heightAt(x + dirX * d, z + dirZ * d) - eyeY, d);
    if (e > best) best = e;
  }
  return best;
}

/**
 * Fraction (0..1) of a disc of angular radius `radiusRad` centred at elevation `elevationRad`
 * that clears a skyline at `skylineRad` (straight-edge approximation, smooth at both ends).
 */
export function discVisibleFraction(elevationRad: number, radiusRad: number, skylineRad: number): number {
  const t = Math.min(1, Math.max(0, (elevationRad + radiusRad - skylineRad) / (2 * radiusRad)));
  return t * t * (3 - 2 * t);
}
