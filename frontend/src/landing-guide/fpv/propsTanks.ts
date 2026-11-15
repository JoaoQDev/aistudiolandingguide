import * as THREE from 'three';
import { cylinderY, mergeAll } from './propsGeometry';

/**
 * Vertical storage tank (t18.5, t41.5): plain body on a slightly wider foot ring, a ribbed
 * (threaded) band, an overhanging collar, a truncated-cone cap with a flat top, a small neck and
 * a thin antenna mast. Proportions measured on the reference frames relative to the 1.7 m eye
 * height: cap top ≈ 1.8 m, body ≈ 0.85 m wide. Local origin at the bottom centre.
 *
 * UVs: u runs around the tank, v = height / TANK_UV_HEIGHT, so `tankDetailMap` can paint the
 * foot notches, band and cap seams at their real heights.
 */

/** Body radius (m). */
export const TANK_RADIUS = 0.425;
/** Height of the flat cap top (m), mast excluded. */
export const TANK_HEIGHT = 1.8;
/** Top of the antenna mast (m). */
export const TANK_MAST_TOP = 2.62;
/** v = 1 in the tank texture corresponds to this height (m). */
export const TANK_UV_HEIGHT = 2.0;

/**
 * Suggested tank paint (lavender grey), calibrated for the round-2 lighting so the lit flank
 * peaks near the reference (~140–185) and the shadow side is not crushed: use as the
 * MeshStandardMaterial colour/roughness/metalness together with `tankDetailMap`.
 */
export const TANK_PAINT = { color: 0xcbcad4, roughness: 0.42, metalness: 0.1 } as const;

/** Profile heights (m) shared with the texture painter. */
export const TANK_PROFILE = {
  footTop: 0.075,
  bodyTop: 1.36,
  bandTop: 1.5,
  collarTop: 1.565,
  capTop: TANK_HEIGHT,
  capTopRadius: 0.185,
} as const;

export function tankProfile(): THREE.Vector2[] {
  const R = TANK_RADIUS;
  const p = TANK_PROFILE;
  const pts: THREE.Vector2[] = [];
  const P = (x: number, y: number) => pts.push(new THREE.Vector2(x, y));
  P(0, 0);
  P(R + 0.014, 0);
  P(R + 0.014, p.footTop - 0.006);
  P(R + 0.004, p.footTop);
  P(R, p.footTop + 0.004);
  P(R, p.bodyTop - 0.012);
  P(R - 0.006, p.bodyTop);
  // ribbed (threaded) band, inset to ~0.84 R
  const rb = R * 0.84;
  P(rb, p.bodyTop + 0.004);
  const ridges = 5;
  const span = p.bandTop - p.bodyTop - 0.012;
  for (let k = 0; k < ridges; k++) {
    const y0 = p.bodyTop + 0.008 + (k / ridges) * span;
    const dy = span / ridges;
    P(rb, y0 + dy * 0.12);
    P(rb + 0.014, y0 + dy * 0.35);
    P(rb + 0.014, y0 + dy * 0.65);
    P(rb, y0 + dy * 0.88);
  }
  P(rb, p.bandTop);
  // overhanging collar
  P(R + 0.008, p.bandTop + 0.004);
  P(R + 0.012, p.bandTop + 0.012);
  P(R + 0.012, p.collarTop - 0.01);
  P(R + 0.002, p.collarTop);
  // truncated cone cap with a softened top edge and a flat top
  P(p.capTopRadius + 0.012, p.capTop - 0.006);
  P(p.capTopRadius, p.capTop);
  P(0, p.capTop);
  return pts;
}

function heightUV(g: THREE.BufferGeometry, uFixed?: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const old = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = uFixed ?? (old ? old.getX(i) : 0);
    uv[i * 2 + 1] = Math.min(0.999, pos.getY(i) / TANK_UV_HEIGHT);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

export function tankGeometry(lowPower: boolean): THREE.BufferGeometry {
  const lathe = new THREE.LatheGeometry(tankProfile(), lowPower ? 16 : 30).toNonIndexed();
  heightUV(lathe);
  const top = TANK_PROFILE.capTop;
  // neck: square-ish block with a thinner upper stage, then the mast
  const neckBase = heightUV(cylinderY(0, 0, top - 0.01, top + 0.07, 0.055, 8, 0.05), 0.5);
  const neck = heightUV(cylinderY(0, 0, top + 0.07, top + 0.19, 0.036, 8, 0.03), 0.5);
  const neckCap = heightUV(cylinderY(0, 0, top + 0.19, top + 0.215, 0.022, 6, 0.016), 0.5);
  const mast = heightUV(cylinderY(0, 0, top + 0.2, TANK_MAST_TOP, 0.0085, 5, 0.0055), 0.5);
  const parts = [lathe, neckBase, neck, neckCap, mast];
  if (!lowPower) {
    // two small side lugs on the neck base (t18.5)
    for (const s of [-1, 1]) parts.push(heightUV(cylinderY(s * 0.07, 0, top + 0.01, top + 0.06, 0.018, 6), 0.5));
  }
  const g = mergeAll(parts, { uv: true });
  g.computeBoundingSphere();
  return g;
}
