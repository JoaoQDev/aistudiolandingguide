import * as THREE from 'three';
import { cylinderY, mergeAll } from './propsGeometry';

/**
 * Vertical storage tank (t18.5): wider base skirt, long body, ribbed ring bands below a rounded
 * shoulder, small cap and a thin antenna mast. ~2.55 m tall body, ~1.15 m diameter.
 * Local origin at the bottom centre.
 */

export const TANK_RADIUS = 0.6;
export const TANK_HEIGHT = 2.55;
const SCALE = 1.12;

export function tankGeometry(lowPower: boolean): THREE.BufferGeometry {
  const r = 0.5;
  const pts: THREE.Vector2[] = [];
  const P = (x: number, y: number) => pts.push(new THREE.Vector2(x, y));
  P(0, 0);
  P(0.5, 0);
  P(0.53, 0.02);
  P(0.53, 0.14);
  P(0.512, 0.16);
  P(0.512, 0.33);
  P(r, 0.35);
  P(r, 1.6);
  for (let k = 0; k < 4; k++) {
    const y = 1.62 + k * 0.055;
    P(r, y);
    P(r + 0.016, y + 0.01);
    P(r + 0.016, y + 0.034);
    P(r, y + 0.044);
  }
  P(r, 1.88);
  const steps = lowPower ? 4 : 7;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    P(0.16 + (r - 0.16) * Math.cos(a), 1.88 + 0.34 * Math.sin(a));
  }
  P(0.16, 2.25);
  P(0.11, 2.28);
  P(0, 2.28);
  const lathe = new THREE.LatheGeometry(pts, lowPower ? 16 : 28);
  const knob = cylinderY(0.07, 0.05, 2.24, 2.38, 0.04, 8);
  const mast = cylinderY(0.07, 0.05, 2.36, 3.25, 0.013, 6, 0.008);
  const g = mergeAll([lathe, knob, mast], { uv: true });
  g.scale(SCALE, SCALE, SCALE);
  g.computeBoundingSphere();
  return g;
}
