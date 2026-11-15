import * as THREE from 'three';
import { beam, chamferBox, colorize, cylinderY, hull, mergeAll, V } from './propsGeometry';

/**
 * Small 4-wheel rover/buggy (t01, t41.5, t43): four big chunky lugged wheels (Ø ≈ 45 % of the
 * overall length, almost touching front-to-back), a narrow open lower frame on swing arms and a
 * raised dark body box carrying lit white panels, a white instrument head and two thin antennas.
 * Vertex-coloured, one material. Local origin: ground centre; +X forward.
 */

export const ROVER_WHEEL_RADIUS = 0.55;
export const ROVER_WHEEL_WIDTH = 0.42;
/** Wheel centre offsets along X (wheelbase / 2) and Z (track / 2). */
export const ROVER_WHEEL_X = 0.68;
export const ROVER_WHEEL_Z = 0.76;
/** Half extents of the whole buggy footprint (wheels included). */
export const ROVER_HALF_LENGTH = ROVER_WHEEL_X + ROVER_WHEEL_RADIUS;
export const ROVER_HALF_WIDTH = ROVER_WHEEL_Z + ROVER_WHEEL_WIDTH / 2 + 0.07; // incl. hub caps
/** Height of the antenna tips. */
export const ROVER_HEIGHT = 2.0;
/** Small beacon on the tip of the rear antenna. */
export const ROVER_BEACON = V(-0.42, ROVER_HEIGHT + 0.012, 0.13);
export const ROVER_BEACON_RADIUS = 0.022;

const TYRE = 0x2a2a2e;
const LUG = 0x505056;
const HUB = 0x2f3034;
const RIM = 0x8c8e93;
const FRAME = 0x2a2b2f;
const BODY = 0x303136;
const PANEL = 0x45464c;
const LIGHT = 0xe4e4e0;
const DECK = 0xa9aaae;
const ACCENT = 0x121214;

function wheel(cx: number, cz: number, side: number, lowPower: boolean): THREE.BufferGeometry[] {
  const R = ROVER_WHEEL_RADIUS;
  const W = ROVER_WHEEL_WIDTH;
  const parts: THREE.BufferGeometry[] = [];
  // tyre: lathe around the axle with rounded shoulders (profile x = radius, y = across width)
  const prof: THREE.Vector2[] = [];
  const P = (r: number, y: number) => prof.push(new THREE.Vector2(r, y));
  P(0.3, -W / 2);
  P(R - 0.1, -W / 2);
  P(R - 0.06, -W / 2 + 0.015);
  P(R - 0.03, -W / 2 + 0.05);
  P(R - 0.03, W / 2 - 0.05);
  P(R - 0.06, W / 2 - 0.015);
  P(R - 0.1, W / 2);
  P(0.3, W / 2);
  const tyre = new THREE.LatheGeometry(prof, lowPower ? 12 : 22).toNonIndexed();
  tyre.deleteAttribute('uv');
  tyre.rotateX(Math.PI / 2);
  tyre.translate(cx, R, cz);
  parts.push(colorize(tyre, TYRE));
  // chunky staggered lugs (chevron tread)
  const lugs = lowPower ? 10 : 16;
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    for (const half of [-1, 1]) {
      const z0 = half < 0 ? -W / 2 + 0.01 : 0.01;
      const z1 = half < 0 ? -0.01 : W / 2 - 0.01;
      const g = chamferBox(-0.055, 0.055, R - 0.05, R + 0.004, z0, z1, 0.018);
      g.rotateZ(a + (half > 0 ? Math.PI / lugs : 0));
      g.translate(cx, R, cz);
      parts.push(colorize(g, LUG));
    }
  }
  // hub disc, light rim ring, cap (outer side only)
  const hub = new THREE.CylinderGeometry(0.31, 0.31, W - 0.02, lowPower ? 10 : 16, 1).toNonIndexed();
  hub.deleteAttribute('uv');
  hub.rotateX(Math.PI / 2);
  hub.translate(cx, R, cz);
  parts.push(colorize(hub, HUB));
  const ring = new THREE.CylinderGeometry(0.24, 0.24, 0.03, lowPower ? 10 : 16, 1).toNonIndexed();
  ring.deleteAttribute('uv');
  ring.rotateX(Math.PI / 2);
  ring.translate(cx, R, cz + side * (W / 2 - 0.0));
  parts.push(colorize(ring, RIM));
  const cap = new THREE.CylinderGeometry(0.09, 0.12, 0.08, 8, 1).toNonIndexed();
  cap.deleteAttribute('uv');
  cap.rotateX((side * Math.PI) / 2);
  cap.translate(cx, R, cz + side * (W / 2 + 0.03));
  parts.push(colorize(cap, FRAME));
  return parts;
}

export function roverGeometry(lowPower: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wx = ROVER_WHEEL_X;
  const wz = ROVER_WHEEL_Z;
  const R = ROVER_WHEEL_RADIUS;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(...wheel(sx * wx, sz * wz, sz, lowPower));

  // open lower frame: central spine + two axle cross-beams, swing arms and shocks to the hubs
  parts.push(colorize(chamferBox(-0.78, 0.78, 0.5, 0.72, -0.2, 0.2, 0.03), FRAME));
  for (const sx of [-1, 1]) {
    parts.push(colorize(chamferBox(sx * wx - 0.07, sx * wx + 0.07, R - 0.06, R + 0.06, -0.24, 0.24, 0.02), FRAME));
    for (const sz of [-1, 1]) {
      parts.push(colorize(beam(V(sx * wx, R, sz * 0.2), V(sx * wx, R, sz * (wz - ROVER_WHEEL_WIDTH / 2 + 0.02)), 0.1, 0.12), FRAME));
      // shock absorber from the hub carrier up to the body
      parts.push(colorize(beam(V(sx * wx * 0.92, R + 0.05, sz * 0.36), V(sx * 0.42, 1.14, sz * 0.3), 0.06), HUB));
      parts.push(colorize(beam(V(sx * wx * 0.9, R + 0.12, sz * 0.36), V(sx * 0.56, 0.98, sz * 0.32), 0.035), RIM));
    }
  }
  // posts from the spine up to the raised body (see-through frame between the wheels)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(colorize(cylinderY(sx * 0.3, sz * 0.13, 0.7, 1.13, 0.035, 6), FRAME));
  parts.push(colorize(chamferBox(-0.12, 0.12, 0.72, 1.12, -0.09, 0.09, 0.02), BODY));

  // raised body box (dark) with a light deck plate and lit white panels front and rear
  parts.push(colorize(chamferBox(-0.62, 0.6, 1.12, 1.52, -0.44, 0.44, 0.05), BODY));
  parts.push(colorize(chamferBox(-0.6, 0.55, 1.52, 1.56, -0.4, 0.4, 0.015), DECK));
  parts.push(colorize(chamferBox(-0.58, 0.58, 1.08, 1.13, -0.4, 0.4, 0.015), PANEL));
  for (const sz of [-1, 1]) {
    // side recess panels
    parts.push(colorize(chamferBox(-0.45, 0.35, 1.2, 1.44, sz > 0 ? 0.43 : -0.455, sz > 0 ? 0.455 : -0.43, 0.01), PANEL));
    for (const k of [0, 1]) {
      const z0 = sz * (0.18 + k * 0.13);
      // rear pair of white lit squares (t41.5 rear view)
      parts.push(colorize(chamferBox(-0.635, -0.6, 1.27, 1.43, z0 - 0.055, z0 + 0.055, 0.008), LIGHT));
      // front pair
      parts.push(colorize(chamferBox(0.58, 0.615, 1.29, 1.41, z0 - 0.05, z0 + 0.05, 0.008), LIGHT));
    }
  }
  parts.push(colorize(chamferBox(-0.64, -0.61, 1.2, 1.24, -0.38, 0.38), ACCENT));
  // white instrument head on the front of the deck, sloped toward the front (lit in t01)
  parts.push(
    colorize(
      hull([
        ...[-0.32, 0.32].flatMap((z) => [V(0.12, 1.56, z), V(0.6, 1.56, z), V(0.12, 1.78, z * 0.92), V(0.42, 1.76, z * 0.92)]),
      ]),
      LIGHT,
    ),
  );
  parts.push(colorize(chamferBox(0.43, 0.47, 1.6, 1.72, -0.24, 0.24, 0.01), ACCENT));
  // camera head on a short post
  parts.push(colorize(cylinderY(0.28, 0, 1.78, 1.88, 0.03, 6), FRAME));
  parts.push(colorize(chamferBox(0.2, 0.38, 1.88, 1.97, -0.1, 0.1, 0.02), BODY));
  parts.push(colorize(chamferBox(0.37, 0.39, 1.9, 1.95, -0.06, 0.06), LIGHT));
  // rear equipment block and the two thin antennas
  parts.push(colorize(chamferBox(-0.56, -0.2, 1.56, 1.66, -0.26, 0.26, 0.02), PANEL));
  for (const sz of [-1, 1]) {
    parts.push(colorize(cylinderY(-0.42, sz * 0.13, 1.6, 1.7, 0.025, 6), FRAME));
    parts.push(colorize(cylinderY(-0.42, sz * 0.13, 1.66, ROVER_HEIGHT, 0.011, 5, 0.007), FRAME));
  }
  // front and rear bumper bars
  for (const sx of [-1, 1]) parts.push(colorize(chamferBox(sx > 0 ? 0.74 : -0.84, sx > 0 ? 0.84 : -0.74, 0.55, 0.68, -0.32, 0.32, 0.02), FRAME));
  return mergeAll(parts, { uv: false, color: true });
}
