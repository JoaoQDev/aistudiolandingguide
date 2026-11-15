import * as THREE from 'three';
import { applyUV, chamferBox, cylinderY, hull, lerp, mergeAll, V, worldUV } from './propsGeometry';

/**
 * The large landed ship (hero prop, t01/t05/t12–t18.5): a stack of chamfered convex blocks —
 * forward "head" block with tapered underside, recessed neck with window slots, long roof pod,
 * segmented spine, mid hull with a shadowed side groove, long lower skid on a front sled and a
 * curved swept rear section that slopes down into the ground.
 *
 * Local frame: +X from nose (x = -L/2) to tail (x = +L/2), +Y up (y = 0 is nominal ground),
 * +Z / -Z are the two flanks. Parts that touch the ground extend `groundDrop` metres below 0.
 */

const AUTHORED_LENGTH = 38.6;
const X_STRETCH = 1.07;
const Y_SCALE = 1.08;
export const SHIP_LENGTH = AUTHORED_LENGTH * X_STRETCH;
export const SHIP_HALF_WIDTH = 5.5;
const X0 = AUTHORED_LENGTH / 2; // geometry is authored with x from 0 (nose), shifted by -X0 then stretched

interface Sec {
  x: number;
  yB: number;
  yT: number;
  hw: number;
  cB?: number;
  cT?: number;
  /** Vertical drop of the top chamfer when it differs from its horizontal inset `cT` (flat bevels). */
  cTy?: number;
}

function ring(s: Sec): THREE.Vector3[] {
  const span = s.yT - s.yB;
  const cB = Math.min(s.cB ?? 0, s.hw * 0.9, span * 0.45);
  const cT = Math.min(s.cT ?? 0, s.hw * 0.9);
  const cTy = Math.min(s.cTy ?? cT, span * 0.45);
  const pts: THREE.Vector3[] = [];
  for (const sz of [-1, 1]) {
    pts.push(V(s.x, s.yB, sz * (s.hw - cB)));
    if (cB > 0) pts.push(V(s.x, s.yB + cB, sz * s.hw));
    if (cT > 0) pts.push(V(s.x, s.yT - cTy, sz * s.hw));
    pts.push(V(s.x, s.yT, sz * (s.hw - cT)));
  }
  return pts;
}

const loft = (secs: Sec[]) => hull(secs.flatMap(ring));

interface BlockOpts {
  x0: number;
  x1: number;
  yB: number;
  yT: number;
  hw: number;
  c?: number;
  cB?: number;
  cT?: number;
  /** Chamfer of the end faces (front / back). */
  e0?: number;
  e1?: number;
  yB1?: number;
  yT1?: number;
  hw1?: number;
}

function block(o: BlockOpts): THREE.BufferGeometry {
  const cB = o.cB ?? o.c ?? 0;
  const cT = o.cT ?? o.c ?? 0;
  const len = o.x1 - o.x0;
  const at = (x: number): Sec => {
    const t = (x - o.x0) / len;
    return { x, yB: lerp(o.yB, o.yB1 ?? o.yB, t), yT: lerp(o.yT, o.yT1 ?? o.yT, t), hw: lerp(o.hw, o.hw1 ?? o.hw, t), cB, cT };
  };
  const secs: Sec[] = [];
  const e0 = o.e0 ?? 0;
  const e1 = o.e1 ?? 0;
  if (e0 > 0) {
    const s = at(o.x0);
    secs.push({ ...s, yB: s.yB + e0, yT: s.yT - e0, hw: s.hw - e0 }, at(o.x0 + e0));
  } else secs.push(at(o.x0));
  if (e1 > 0) {
    const s = at(o.x1);
    secs.push(at(o.x1 - e1), { ...s, yB: s.yB + e1, yT: s.yT - e1, hw: s.hw - e1 });
  } else secs.push(at(o.x1));
  return loft(secs);
}

export interface ShipGeometry {
  hull: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  /** Recessed / shadowed surfaces (side groove, rib seams): mid-dark grey. */
  shade: THREE.BufferGeometry;
  /** Collider circles in local XZ (x along the hull). */
  colliders: { x: number; z: number; r: number }[];
}

export function buildShipGeometry(groundDrop: number): ShipGeometry {
  const G = -Math.max(0.5, groundDrop) / Y_SCALE;
  const H: THREE.BufferGeometry[] = [];
  const D: THREE.BufferGeometry[] = [];
  const S: THREE.BufferGeometry[] = [];

  // --- head block: vertical upper flanks, crease line, tapered (shadowed) underside
  H.push(
    hull([
      ...[0.75, 10.2].flatMap((x) => [V(x, 9.95, -4.25), V(x, 9.95, 4.25)]),
      ...[0.3, 10.4].flatMap((x) => [V(x, 9.55, -4.65), V(x, 9.55, 4.65)]),
      ...[0.0, 9.6].flatMap((x) => [V(x, 7.45, -4.65), V(x, 7.45, 4.65)]),
      ...[1.8, 7.7].flatMap((x) => [V(x, 4.1, -2.6), V(x, 4.1, 2.6)]),
    ]),
  );
  // head side intake plates
  for (const sz of [-1, 1]) H.push(chamferBox(1.6, 7.9, 7.75, 9.25, sz > 0 ? 4.6 : -4.78, sz > 0 ? 4.78 : -4.6, 0.05));
  // front visor band
  H.push(chamferBox(-0.12, 0.4, 7.25, 7.75, -4.2, 4.2, 0.08));

  // --- neck with window slots
  H.push(block({ x0: 8.9, x1: 12.4, yB: 4.5, yT: 9.0, hw: 3.45, c: 0.3 }));
  for (const sz of [-1, 1]) {
    const zIn = sz * 3.36;
    const zOut = sz * 3.95;
    const z0 = Math.min(zIn, zOut);
    const z1 = Math.max(zIn, zOut);
    H.push(chamferBox(9.6, 12.3, 5.7, 8.15, Math.min(sz * 3.3, sz * 3.5), Math.max(sz * 3.3, sz * 3.5)));
    for (const mx of [9.62, 10.24, 10.86, 11.48, 12.06]) D.push(chamferBox(mx, mx + 0.24, 5.65, 8.2, z0, z1, 0.03));
    D.push(chamferBox(9.0, 12.4, 5.45, 5.74, Math.min(sz * 3.3, sz * 4.05), Math.max(sz * 3.3, sz * 4.05), 0.05));
    D.push(chamferBox(9.5, 12.4, 8.1, 8.38, Math.min(sz * 3.3, sz * 4.0), Math.max(sz * 3.3, sz * 4.0), 0.05));
  }

  // --- overhang above the window slots (rear of the head) and segmented shoulder band under the pod (t05)
  H.push(block({ x0: 9.0, x1: 12.7, yB: 8.55, yT: 9.95, hw: 4.45, cT: 0.35, cB: 0.2 }));
  for (const [x0, x1] of [
    [0.9, 2.95],
    [3.05, 5.1],
    [5.2, 7.25],
    [7.35, 9.4],
    [9.5, 11.9],
  ]) {
    H.push(block({ x0, x1, yB: 9.35, yT: 10.18, hw: 4.85, cT: 0.45, cB: 0.12, e0: 0.12, e1: 0.12 }));
  }

  // --- upper spine: outboard beam protruding past the flanks, segmented with collars (t15–t18.5)
  H.push(block({ x0: 11.9, x1: 15.2, yB: 7.6, yT: 9.6, hw: 5.2, c: 0.3, e0: 0.45 }));
  H.push(block({ x0: 15.22, x1: 15.8, yB: 7.48, yT: 9.75, hw: 5.45, c: 0.25 }));
  H.push(block({ x0: 15.82, x1: 19.9, yB: 7.62, yT: 9.6, hw: 5.25, c: 0.3 }));
  H.push(block({ x0: 19.92, x1: 21.0, yB: 7.5, yT: 9.72, hw: 5.45, c: 0.25 }));
  H.push(block({ x0: 21.02, x1: 24.0, yB: 7.62, yT: 9.6, hw: 5.25, c: 0.3 }));
  H.push(block({ x0: 24.02, x1: 25.0, yB: 7.5, yT: 9.72, hw: 5.4, c: 0.25 }));
  H.push(block({ x0: 25.02, x1: 28.6, yB: 7.62, yT: 9.5, hw: 5.1, c: 0.3, e1: 0.75 }));

  // --- mid hull: plain front part, then upper band / recessed groove (sloping aft) / lower band
  H.push(block({ x0: 12.32, x1: 15.4, yB: 3.2, yT: 7.8, hw: 4.95, cT: 0.45, cB: 0.35 }));
  H.push(block({ x0: 15.42, x1: 27.0, yB: 5.5, yB1: 4.85, yT: 7.8, hw: 5.0, cT: 0.75, cB: 0.15 }));
  H.push(block({ x0: 15.42, x1: 27.0, yB: 3.6, yT: 5.7, hw: 4.3 }));
  H.push(block({ x0: 15.42, x1: 27.0, yB: 3.2, yT: 4.45, yT1: 3.85, hw: 4.75, cB: 0.35, cT: 0.08 }));
  for (const sz of [-1, 1]) {
    const zA = sz * 4.28;
    const zB = sz * 4.36;
    S.push(
      hull([
        ...[zA, zB].flatMap((z) => [V(15.6, 4.42, z), V(15.6, 5.52, z), V(26.9, 3.82, z), V(26.9, 4.9, z)]),
      ]),
    );
    // raised side plates on the upper band
    H.push(
      hull([
        ...[sz * 4.95, sz * 5.14].flatMap((z) => [V(16.0, 5.82, z), V(16.0, 7.35, z), V(26.3, 5.25, z), V(26.3, 7.35, z)]),
      ]),
    );
    // window at the end of the groove (t15)
    D.push(chamferBox(26.2, 26.85, 3.95, 6.5, Math.min(sz * 5.0, sz * 5.18), Math.max(sz * 5.0, sz * 5.18)));
    H.push(chamferBox(26.1, 26.95, 6.5, 6.7, Math.min(sz * 4.95, sz * 5.22), Math.max(sz * 4.95, sz * 5.22), 0.03));
  }

  // --- curved swept rear section, sloping into the ground
  const xs = [26.6, 28.4, 30.0, 31.5, 32.9, 34.1, 35.2, 36.2, 37.1, 37.9];
  const yT = [7.75, 7.65, 7.38, 7.0, 6.45, 5.8, 5.0, 4.1, 3.1, 2.2];
  const yB = [3.2, 1.6, G, G, G, G, G, G, G, G];
  const hw = [5.05, 5.05, 5.0, 4.95, 4.9, 4.82, 4.72, 4.62, 4.5, 4.38];
  const cT = [0.9, 1.25, 1.45, 1.55, 1.55, 1.5, 1.4, 1.25, 1.05, 0.8];
  const secs: Sec[] = xs.map((x, i) => ({ x, yB: yB[i], yT: yT[i], hw: hw[i], cT: cT[i], cTy: cT[i] * 0.42, cB: yB[i] > 0 ? 0.3 : 0 }));
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i];
    const b = { ...secs[i + 1], x: secs[i + 1].x - 0.04 };
    H.push(loft([a, b]));
  }
  // chisel tail tip
  H.push(loft([secs[secs.length - 1], { x: 38.6, yB: G, yT: 1.15, hw: 4.15, cT: 0.5, cTy: 0.25 }]));
  // rib seams wrapping the rear shell flanks (t01): thin recessed strips following the profile
  for (const xr of [29.2, 32.2, 35.0]) {
    const i = xs.findIndex((x) => x > xr);
    const t = (xr - xs[i - 1]) / (xs[i] - xs[i - 1]);
    const top = lerp(yT[i - 1], yT[i], t) - lerp(cT[i - 1], cT[i], t) * 0.42;
    const w = lerp(hw[i - 1], hw[i], t);
    for (const sz of [-1, 1]) S.push(chamferBox(xr, xr + 0.16, Math.max(0, lerp(yB[i - 1], yB[i], t)), top, Math.min(sz * (w - 0.02), sz * (w + 0.03)), Math.max(sz * (w - 0.02), sz * (w + 0.03))));
  }
  // low service blocks at the foot of the rear shell (t17)
  for (const sz of [-1, 1]) H.push(chamferBox(30.6, 33.4, G, 1.7, Math.min(sz * 4.7, sz * 5.25), Math.max(sz * 4.7, sz * 5.25), 0.12));

  // --- lower skid (segmented with collars)
  const skid = (x0: number, x1: number, e0 = 0, e1 = 0) =>
    H.push(block({ x0, x1, yB: 1.75, yT: 3.55, hw: 5.0, c: 0.4, e0, e1 }));
  const collar = (x0: number) => H.push(block({ x0, x1: x0 + 0.4, yB: 1.62, yT: 3.68, hw: 5.15, c: 0.32 }));
  skid(3.4, 8.0, 0.7);
  collar(8.0);
  skid(8.4, 13.4);
  collar(13.4);
  skid(13.8, 18.3);
  collar(18.3);
  skid(18.7, 22.0);
  collar(22.0);
  skid(22.4, 27.4, 0, 0.4);

  // --- front sled (resting on the ground)
  H.push(
    hull([
      ...[1.9, 14.5].flatMap((x) => [V(x, 1.78, -4.75), V(x, 1.78, 4.75)]),
      ...[2.15, 14.25].flatMap((x) => [V(x, 2.02, -4.5), V(x, 2.02, 4.5)]),
      V(2.4 - 0.25 * G, G, -4.4),
      V(2.4 - 0.25 * G, G, 4.4),
      V(12.1 + 1.2 * G, G, -4.4),
      V(12.1 + 1.2 * G, G, 4.4),
    ]),
  );

  // --- roof pod (front + tapered rear) on two pylons
  H.push(block({ x0: 1.9, x1: 8.1, yB: 10.2, yT: 12.5, hw: 3.3, cT: 0.35, cB: 0.3, e0: 0.7 }));
  H.push(block({ x0: 8.16, x1: 12.1, yB: 10.2, yT: 12.5, hw: 3.3, cT: 0.35, cB: 0.3 }));
  H.push(block({ x0: 12.16, x1: 18.4, yB: 10.25, yT: 12.45, hw: 3.25, yB1: 10.75, yT1: 11.6, hw1: 2.9, cT: 0.35, cB: 0.3, e1: 0.45 }));
  H.push(chamferBox(4.6, 11.4, 12.48, 12.68, -2.2, 2.2, 0.08));
  H.push(block({ x0: 3.2, x1: 4.8, yB: 9.5, yT: 10.4, hw: 2.2, c: 0.15 }));
  H.push(block({ x0: 13.8, x1: 15.4, yB: 9.4, yT: 10.5, hw: 2.0, c: 0.15 }));
  // pod side rails
  for (const sz of [-1, 1]) H.push(chamferBox(2.2, 17.0, 10.55, 10.95, Math.min(sz * 3.22, sz * 3.42), Math.max(sz * 3.22, sz * 3.42), 0.06));

  // --- top superstructure behind the pod, fin and masts (t01)
  H.push(block({ x0: 19.6, x1: 24.4, yB: 9.5, yT: 10.6, hw: 2.3, c: 0.25, e0: 0.3, e1: 0.3 }));
  H.push(block({ x0: 20.8, x1: 23.9, yB: 10.55, yT: 11.5, hw: 0.28, yT1: 10.75, c: 0.05 }));
  H.push(cylinderY(16.6, 1.6, 11.5, 13.9, 0.06, 8, 0.03));
  H.push(cylinderY(17.2, -1.2, 11.4, 12.9, 0.05, 8, 0.03));
  H.push(cylinderY(22.6, 1.4, 10.5, 12.2, 0.05, 8, 0.03));

  // shift so the hull is centred on the origin along X
  const shift = new THREE.Matrix4().makeScale(X_STRETCH, Y_SCALE, 1).multiply(new THREE.Matrix4().makeTranslation(-X0, 0, 0));
  const uv = worldUV(8);
  const hullParts = H.map((g) => applyUV(g.applyMatrix4(shift), uv));
  const darkParts = D.map((g) => g.applyMatrix4(shift));
  const shadeParts = S.map((g) => g.applyMatrix4(shift));

  const colliders: { x: number; z: number; r: number }[] = [];
  for (let x = 1.5; x <= 37.5; x += 4.5) colliders.push({ x: (x - X0) * X_STRETCH, z: 0, r: x > 33 ? 5.0 : 5.9 });

  return {
    hull: mergeAll(hullParts, { uv: true }),
    dark: mergeAll(darkParts, { uv: false }),
    shade: mergeAll(shadeParts, { uv: false }),
    colliders,
  };
}
