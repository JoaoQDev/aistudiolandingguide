import * as THREE from 'three';
import { applyUV, chamferBox, mergeAll, type UVMapper } from './propsGeometry';
import type { CrateStyle } from './propsTextures';

/**
 * Cargo containers / crates. Each style is one geometry whose faces map into a single atlas
 * texture (see propsTextures.ts for the atlas layout) so a whole family renders as one
 * InstancedMesh. Local origin: centre of the bottom face; long axis along +X.
 */

export interface CrateSpec {
  w: number;
  h: number;
  d: number;
  chamfer: number;
  /** Corner posts (dark crates): square section and how far they stand proud of the faces. */
  post?: { size: number; protrude: number };
  /** Raised lid plate on top. */
  lid?: { inset: number; t: number };
  /** Plain colour used when canvas textures are unavailable. */
  fallbackColor: number;
  roughness: number;
  metalness: number;
}

export const CRATE_SPECS: Record<CrateStyle, CrateSpec> = {
  // white hazard containers next to the ship (t15–t18.5)
  hazard: { w: 2.6, h: 1.6, d: 1.5, chamfer: 0.06, lid: { inset: 0.5, t: 0.035 }, fallbackColor: 0xd6d6d2, roughness: 0.55, metalness: 0.05 },
  // white modular containers with diagonal panels (t15 right side, t41.5 row)
  row: { w: 2.5, h: 1.2, d: 1.2, chamfer: 0.15, fallbackColor: 0xd9dad7, roughness: 0.5, metalness: 0.05 },
  // dark charcoal crates with chipped white edges and hazard corner posts (t01, t39–t43)
  dark: {
    w: 2.5,
    h: 1.3,
    d: 1.45,
    chamfer: 0.04,
    post: { size: 0.2, protrude: 0.035 },
    lid: { inset: 0.32, t: 0.05 },
    fallbackColor: 0x2a2b2e,
    roughness: 0.48,
    metalness: 0.15,
  },
};

const clamp01 = (v: number) => Math.min(0.994, Math.max(0.006, v));
// atlas regions in UV space (canvas flipped: v = 1 - y/1024)
const front = (s: number, t: number): [number, number] => [clamp01(s), 0.5 + 0.5 * clamp01(t)];
const end = (s: number, t: number): [number, number] => [0.5 * clamp01(s), 0.5 * clamp01(t)];
const top = (s: number, t: number): [number, number] => [0.5 + 0.5 * clamp01(s), 0.25 + 0.25 * clamp01(t)];
const strip = (along: number, across: number): [number, number] => [0.5 + 0.5 * clamp01(along), 0.25 * clamp01(across)];

function crateMapper(w: number, h: number, d: number): UVMapper {
  return (p, _n, axis, sign) => {
    const sx = (p.x + w / 2) / w;
    const sz = (p.z + d / 2) / d;
    const t = p.y / h;
    if (axis === 2) return front(sign > 0 ? sx : 1 - sx, t);
    if (axis === 0) return end(sign > 0 ? 1 - sz : sz, t);
    return top(sx, 1 - sz);
  };
}

export function crateGeometry(spec: CrateSpec): THREE.BufferGeometry {
  const { w, h, d } = spec;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(applyUV(chamferBox(-w / 2, w / 2, 0, h, -d / 2, d / 2, spec.chamfer), crateMapper(w, h, d)));
  if (spec.lid) {
    const { inset, t } = spec.lid;
    parts.push(applyUV(chamferBox(-w / 2 + inset, w / 2 - inset, h - 0.01, h + t, -d / 2 + inset * 0.7, d / 2 - inset * 0.7, t * 0.6), crateMapper(w, h + t, d)));
  }
  if (spec.post) {
    const { size, protrude } = spec.post;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const xo = sx * (w / 2 + protrude);
        const zo = sz * (d / 2 + protrude);
        const x0 = Math.min(xo, xo - sx * size);
        const x1 = Math.max(xo, xo - sx * size);
        const z0 = Math.min(zo, zo - sz * size);
        const z1 = Math.max(zo, zo - sz * size);
        const g = chamferBox(x0, x1, 0, h + 0.012, z0, z1, 0.025);
        parts.push(
          applyUV(g, (p, _n, axis) => {
            const along = p.y / h;
            if (axis === 0) return strip(along, (p.z - z0) / (z1 - z0));
            if (axis === 2) return strip(along, (p.x - x0) / (x1 - x0));
            return strip(0.995, 0.5);
          }),
        );
      }
  }
  return mergeAll(parts, { uv: true });
}

export interface CratePlacement {
  style: CrateStyle;
  matrix: THREE.Matrix4;
  tint: number;
}
