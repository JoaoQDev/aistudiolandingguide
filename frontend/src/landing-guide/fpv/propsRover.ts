import * as THREE from 'three';
import { beam, chamferBox, colorize, cylinderY, hull, mergeAll, V } from './propsGeometry';

/**
 * Small 4-wheel rover/buggy (t01, t05, t41.5): big dark lugged wheels on swing arms, an open
 * dark chassis with a light deck, a front sensor head and a rear double antenna mast.
 * Vertex-coloured, one material. Local origin: ground centre; +X forward.
 */

export const ROVER_HALF_LENGTH = 1.55;
export const ROVER_HALF_WIDTH = 1.2;
export const ROVER_BEACON = V(-0.95, 2.12, 0.28);
export const ROVER_BEACON_RADIUS = 0.028;

const TYRE = 0x1b1b1e;
const HUB = 0x74767b;
const FRAME = 0x2b2c30;
const BODY = 0x36373c;
const DECK = 0x4a4b51;
const LIGHT = 0xb9babd;
const ACCENT = 0x111113;

function wheel(cx: number, cz: number, lowPower: boolean): THREE.BufferGeometry[] {
  const R = 0.48;
  const Wd = 0.42;
  const parts: THREE.BufferGeometry[] = [];
  const tyre = new THREE.CylinderGeometry(R - 0.04, R - 0.04, Wd, lowPower ? 12 : 20, 1).toNonIndexed();
  tyre.rotateX(Math.PI / 2);
  tyre.translate(cx, R, cz);
  parts.push(colorize(tyre, TYRE));
  const lugs = lowPower ? 8 : 14;
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    const g = chamferBox(-0.07, 0.07, R - 0.08, R + 0.005, -Wd / 2 - 0.01, Wd / 2 + 0.01, 0.02);
    g.rotateZ(a);
    g.translate(cx, R, cz);
    parts.push(colorize(g, TYRE));
  }
  const hub = new THREE.CylinderGeometry(0.2, 0.2, Wd + 0.04, 10, 1).toNonIndexed();
  hub.rotateX(Math.PI / 2);
  hub.translate(cx, R, cz);
  parts.push(colorize(hub, FRAME));
  const cap = new THREE.CylinderGeometry(0.11, 0.13, Wd + 0.08, 8, 1).toNonIndexed();
  cap.rotateX(Math.PI / 2);
  cap.translate(cx, R, cz);
  parts.push(colorize(cap, HUB));
  return parts;
}

export function roverGeometry(lowPower: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wx = 1.05;
  const wz = 0.92;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(...wheel(sx * wx, sz * wz, lowPower));
  // swing arms + shocks
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      parts.push(colorize(beam(V(sx * wx, 0.48, sz * 0.66), V(sx * 0.55, 0.72, sz * 0.42), 0.09), FRAME));
      parts.push(colorize(beam(V(sx * wx, 0.62, sz * 0.66), V(sx * 0.7, 1.0, sz * 0.45), 0.06), HUB));
    }
  // chassis rails and cross members
  for (const sz of [-1, 1]) parts.push(colorize(chamferBox(-1.25, 1.2, 0.6, 0.78, sz * 0.5 - 0.08, sz * 0.5 + 0.08, 0.02), FRAME));
  for (const x of [-1.0, 0, 0.95]) parts.push(colorize(chamferBox(x - 0.07, x + 0.07, 0.62, 0.76, -0.55, 0.55, 0.02), FRAME));
  // body tub
  parts.push(
    colorize(
      hull([
        ...[-0.95, 0.85].flatMap((x) => [V(x, 0.95, -0.62), V(x, 0.95, 0.62)]),
        ...[-0.85, 0.7].flatMap((x) => [V(x, 0.66, -0.5), V(x, 0.66, 0.5)]),
      ]),
      BODY,
    ),
  );
  // dark deck with light edge trims and vent stripes, side fairings
  parts.push(colorize(chamferBox(-1.15, 0.75, 0.95, 1.04, -0.74, 0.74, 0.03), DECK));
  for (const sz of [-1, 1]) parts.push(colorize(chamferBox(-0.9, 0.6, 0.72, 0.94, sz > 0 ? 0.6 : -0.66, sz > 0 ? 0.66 : -0.6, 0.02), BODY));
  for (let k = 0; k < 5; k++) parts.push(colorize(chamferBox(0.3 + k * 0.08, 0.34 + k * 0.08, 1.04, 1.05, -0.5, 0.5), ACCENT));
  parts.push(colorize(chamferBox(-1.15, 0.75, 1.0, 1.06, -0.77, -0.7), LIGHT));
  parts.push(colorize(chamferBox(-1.15, 0.75, 1.0, 1.06, 0.7, 0.77), LIGHT));
  // raised flat cargo plate on four struts (t05)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(colorize(cylinderY(-0.25 + sx * 0.55, sz * 0.5, 1.04, 1.36, 0.03, 6), FRAME));
  parts.push(colorize(chamferBox(-1.0, 0.45, 1.36, 1.43, -0.7, 0.7, 0.03), BODY));
  parts.push(colorize(chamferBox(-0.98, 0.43, 1.43, 1.445, -0.66, 0.66), ACCENT));
  // front bumper / nose
  parts.push(
    colorize(
      hull([
        ...[0.8, 1.32].flatMap((x) => [V(x, x > 1 ? 0.62 : 0.55, -0.56), V(x, x > 1 ? 0.62 : 0.55, 0.56)]),
        ...[0.8, 1.18].flatMap((x) => [V(x, 0.98, -0.56), V(x, 0.98, 0.56)]),
      ]),
      FRAME,
    ),
  );
  // front sensor head on a post
  parts.push(colorize(cylinderY(0.55, 0, 1.04, 1.4, 0.05, 8), FRAME));
  parts.push(colorize(chamferBox(0.52, 0.8, 1.45, 1.64, -0.3, 0.3, 0.04), BODY));
  parts.push(colorize(chamferBox(0.79, 0.82, 1.49, 1.6, -0.24, 0.24), ACCENT));
  parts.push(colorize(cylinderY(0.55, 0, 1.4, 1.46, 0.05, 8), FRAME));
  // rear antenna mast pair
  for (const sz of [-1, 1]) parts.push(colorize(cylinderY(-0.95, sz * 0.28, 1.04, 2.1, 0.025, 6, 0.015), FRAME));
  parts.push(colorize(chamferBox(-1.02, -0.88, 1.6, 1.68, -0.32, 0.32, 0.01), FRAME));
  parts.push(colorize(chamferBox(-1.06, -0.84, 1.68, 1.8, -0.1, 0.1, 0.03), LIGHT));
  return mergeAll(parts, { uv: false, color: true });
}
