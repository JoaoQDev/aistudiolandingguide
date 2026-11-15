/**
 * Pure (three.js-free) height field for the first-person lunar ground.
 *
 * The rendered ground is a static set of nested square LOD rings centred on the origin
 * (level k has spacing s0·2^k and half-extent n·s0·2^k). Vertex heights come from a
 * band-limited analytic function; the outer border of each ring is stitched to the next
 * coarser ring so there are no cracks. `heightAt` interpolates the very same triangles,
 * so feet and props agree with the rendered surface exactly (up to float rounding).
 *
 * Everything here is illustrative scenery: no real topography is implied.
 */

export interface TerrainLayout {
  /** Spacing of the innermost ring (m). */
  s0: number;
  /** Half-extent of every ring in cells (even). */
  n: number;
  /** Number of rings. */
  levels: number;
}

export const TERRAIN_LAYOUT: TerrainLayout = { s0: 2, n: 96, levels: 6 };
export const TERRAIN_LAYOUT_LOW: TerrainLayout = { s0: 4, n: 48, levels: 6 };

const MOON_RADIUS_M = 1_737_400;

export interface HeightFieldOptions {
  seed: number;
  lowPower: boolean;
  horizonElevDeg?: number[];
}

export interface TerrainMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
}

export interface HeightField {
  layout: TerrainLayout;
  /** Band-limited analytic surface (before triangulation). */
  analytic(x: number, z: number): number;
  /** Height of the rendered mesh at world x/z (exact triangle interpolation). */
  heightAt(x: number, z: number): number;
  /** Builds the LOD ring mesh whose triangles `heightAt` reproduces. */
  buildMesh(): TerrainMeshData;
  /** Half-extent (m) of the outermost ring. */
  extent: number;
}

// ---------------------------------------------------------------------------------------------
// Noise helpers
// ---------------------------------------------------------------------------------------------

export function hash2(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ s) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const GRAD_X = new Float64Array(256);
const GRAD_Y = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const a = ((i + 0.5) / 256) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/** 2D gradient noise, roughly in [-1, 1]. */
export function gnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const h00 = hash2(xi, yi, s) & 255;
  const h10 = hash2(xi + 1, yi, s) & 255;
  const h01 = hash2(xi, yi + 1, s) & 255;
  const h11 = hash2(xi + 1, yi + 1, s) & 255;
  const n00 = GRAD_X[h00] * xf + GRAD_Y[h00] * yf;
  const n10 = GRAD_X[h10] * (xf - 1) + GRAD_Y[h10] * yf;
  const n01 = GRAD_X[h01] * xf + GRAD_Y[h01] * (yf - 1);
  const n11 = GRAD_X[h11] * (xf - 1) + GRAD_Y[h11] * (yf - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.41;
}

/** 2D value noise in [0, 1]. */
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const k = 1 / 4294967296;
  const a = hash2(xi, yi, s) * k;
  const b = hash2(xi + 1, yi, s) * k;
  const c = hash2(xi, yi + 1, s) * k;
  const d = hash2(xi + 1, yi + 1, s) * k;
  const ab = a + u * (b - a);
  const cd = c + u * (d - c);
  return ab + v * (cd - ab);
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Soft-rimmed shallow crater profile; t = distance / radius, zero beyond t = 2. */
function craterProfile(t: number): number {
  const bowl = t < 1.1 ? -(1 - smooth(0, 1.1, t)) : 0;
  const r = (t - 1.05) / 0.32;
  return bowl + 0.24 * Math.exp(-r * r);
}

function seedInt(seed: number): number {
  const s = Number.isFinite(seed) ? seed : 0;
  return hash2(Math.floor(s) | 0, Math.floor((s % 1) * 1e6) | 0, 0x5eed);
}

// ---------------------------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------------------------

export function createHeightField(opts: HeightFieldOptions): HeightField {
  const layout = opts.lowPower ? TERRAIN_LAYOUT_LOW : TERRAIN_LAYOUT;
  const { s0, n, levels } = layout;
  const L0 = n * s0;
  const extent = L0 * 2 ** (levels - 1);
  const base = seedInt(opts.seed);
  const S = Array.from({ length: 16 }, (_, i) => hash2(base, i * 7919 + 13, 0x1234567));

  // Subtle far-hill modulation from the site's skyline profile (illustrative only).
  const prof = opts.horizonElevDeg && opts.horizonElevDeg.length > 0 ? opts.horizonElevDeg : null;
  let profMax = 1;
  if (prof) for (const e of prof) if (Number.isFinite(e)) profMax = Math.max(profMax, e);
  const horizonFactor = (x: number, z: number): number => {
    if (!prof) return 1;
    let az = (Math.atan2(x, -z) * 180) / Math.PI;
    if (az < 0) az += 360;
    const f = (az / 360) * prof.length;
    const i0 = Math.floor(f) % prof.length;
    const i1 = (i0 + 1) % prof.length;
    const w = f - Math.floor(f);
    const e = (Number.isFinite(prof[i0]) ? prof[i0] : 0) * (1 - w) + (Number.isFinite(prof[i1]) ? prof[i1] : 0) * w;
    return 0.75 + 0.5 * Math.min(1, Math.max(0, e / profMax));
  };

  /** Continuous counterpart of the ring spacing at radius r (used to band-limit features). */
  const spacingAt = (r: number): number => s0 * Math.max(1, (2 * r) / L0);
  /** Weight of a feature with wavelength `lambda` given local spacing `sc`. */
  const band = (lambda: number, sc: number): number => smooth(4 * sc, 8 * sc, lambda);

  const craterLayer = (
    x: number,
    z: number,
    cell: number,
    prob: number,
    rMin: number,
    rMax: number,
    rIn0: number,
    rIn1: number,
    seedC: number,
  ): number => {
    const ci = Math.floor(x / cell);
    const cj = Math.floor(z / cell);
    let sum = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        const h1 = hash2(i, j, seedC);
        if ((h1 & 0xffff) > prob * 65536) continue;
        const h2 = hash2(i, j, seedC + 101);
        const u = (h1 >>> 16) / 65536;
        const R = rMin + (rMax - rMin) * u * u;
        const px = (i + (h2 & 0xffff) / 65536) * cell;
        const pz = (j + (h2 >>> 16) / 65536) * cell;
        const dx = x - px;
        const dz = z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= 4 * R * R) continue;
        const rc = Math.sqrt(px * px + pz * pz);
        let w = smooth(rIn0, rIn1, rc) * (1 - smooth(620, 820, rc));
        if (w <= 0) continue;
        const scC = spacingAt(rc + R);
        w *= smooth(2 * scC, 4 * scC, R);
        if (w <= 0) continue;
        const h3 = hash2(i, j, seedC + 202);
        const depth = R * (0.1 + 0.08 * ((h3 & 0xffff) / 65536));
        sum += w * depth * craterProfile(Math.sqrt(d2) / R);
      }
    }
    return sum;
  };

  const raw = (x: number, z: number): number => {
    const r2 = x * x + z * z;
    const r = Math.sqrt(r2);
    const sc = spacingAt(r);
    let h = 0;

    // Gentle metre-scale undulation, calmer around the base.
    const fN = 0.3 + 0.7 * smooth(60, 260, r);
    h +=
      fN *
      (0.55 * band(80, sc) * gnoise(x / 80, z / 80, S[0]) +
        0.28 * band(40, sc) * gnoise(x / 40 + 17.3, z / 40 - 4.1, S[1]) +
        0.12 * band(20, sc) * gnoise(x / 20 - 9.7, z / 20 + 3.3, S[2]));

    // Broad swells beyond the base.
    const fM = smooth(160, 700, r);
    if (fM > 0) {
      h +=
        fM *
        (8 * gnoise(x / 520, z / 520, S[3]) +
          2.5 * band(260, sc) * gnoise(x / 260 + 5.1, z / 260 + 1.7, S[4]) +
          1.0 * band(130, sc) * gnoise(x / 130 - 2.9, z / 130 + 8.3, S[5]));
    }

    // Sparse shallow soft-rimmed craters, kept away from the base.
    if (r > 60 && r < 880) {
      h += craterLayer(x, z, 40, 0.25, 4, 10, 110, 160, S[6]);
      h += craterLayer(x, z, 120, 0.35, 10, 28, 160, 240, S[7]);
    }

    // Far low rolling hills / ridges on the horizon.
    const fF = smooth(380, 1600, r) * (1 - smooth(4300, 5900, r));
    if (fF > 0) {
      const an = vnoise(x / 2600 + 3.1, z / 2600 - 7.7, S[8]);
      const amp = (30 + 140 * an * an * an) * horizonFactor(x, z);
      const b =
        0.5 * gnoise(x / 1700, z / 1700, S[9]) +
        0.3 * band(850, sc) * gnoise(x / 850 + 1.3, z / 850 - 2.2, S[10]) +
        0.15 * band(425, sc) * gnoise(x / 425 - 4.4, z / 425 + 6.1, S[11]) +
        0.07 * band(212, sc) * gnoise(x / 212 + 7.7, z / 212 + 0.6, S[12]);
      const ridge = 1 - Math.abs(gnoise(x / 1300 + 11.1, z / 1300 - 3.3, S[13]));
      h += fF * amp * (0.55 * (b + 0.5) + 0.45 * ridge * ridge * ridge);
    }

    // Broken distant escarpment (like an old degraded crater wall) whose steep face looks
    // toward the base: self-shadowed (dark band) when looking sunward, lit when looking away.
    if (r > 1200) {
      const ux = x / r;
      const uz = z / r;
      const sel = vnoise(ux * 2.6 + 4.2, uz * 2.6 - 1.9, S[14]);
      const he = 115 * smooth(0.44, 0.82, sel);
      if (he > 0.01) {
        const re = 1850 + 900 * vnoise(ux * 1.7 - 6.3, uz * 1.7 + 2.4, S[15]);
        const rise = smooth(re - 260, re, r);
        const fall = smooth(re, re + 1100, r);
        const wob = 1 + 0.15 * band(300, sc) * gnoise(x / 300 + 2.2, z / 300 - 9.1, S[12] ^ 0x77);
        h += he * horizonFactor(x, z) * (rise - 0.7 * fall) * wob * (1 - smooth(4300, 5900, r));
      }
    }

    // Lunar curvature drop (hides the mesh edge behind a natural horizon).
    h -= r2 / (2 * MOON_RADIUS_M);
    return h;
  };

  const h0 = raw(0, 0);
  const analytic = (x: number, z: number): number => raw(x, z) - h0;

  const spacing = (k: number) => s0 * 2 ** k;
  const half = (k: number) => n * spacing(k);
  const N = 2 * n; // cells per side

  /** Height of vertex (i, j) of ring k, with outer-border stitching to ring k + 1. */
  const vertexHeight = (k: number, i: number, j: number): number => {
    const s = spacing(k);
    const L = half(k);
    const x = -L + i * s;
    const z = -L + j * s;
    if (k < levels - 1) {
      if ((i === 0 || i === N) && (j & 1) === 1) {
        return 0.5 * (analytic(x, z - s) + analytic(x, z + s));
      }
      if ((j === 0 || j === N) && (i & 1) === 1) {
        return 0.5 * (analytic(x - s, z) + analytic(x + s, z));
      }
    }
    return analytic(x, z);
  };

  const levelOf = (x: number, z: number): number => {
    const rho = Math.max(Math.abs(x), Math.abs(z));
    if (rho <= L0) return 0;
    const k = Math.ceil(Math.log2(rho / L0) - 1e-12);
    return Math.min(levels - 1, Math.max(0, k));
  };

  const heightAt = (x: number, z: number): number => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const rho = Math.max(Math.abs(x), Math.abs(z));
    if (rho >= extent) return analytic(x, z);
    const k = levelOf(x, z);
    const s = spacing(k);
    const L = half(k);
    const gx = (x + L) / s;
    const gz = (z + L) / s;
    const i = Math.min(N - 1, Math.max(0, Math.floor(gx)));
    const j = Math.min(N - 1, Math.max(0, Math.floor(gz)));
    const fx = gx - i;
    const fz = gz - j;
    const h00 = vertexHeight(k, i, j);
    const h11 = vertexHeight(k, i + 1, j + 1);
    if (fz >= fx) {
      const h01 = vertexHeight(k, i, j + 1);
      return h00 + fz * (h01 - h00) + fx * (h11 - h01);
    }
    const h10 = vertexHeight(k, i + 1, j);
    return h00 + fx * (h10 - h00) + fz * (h11 - h10);
  };

  const buildMesh = (): TerrainMeshData => {
    const V = N + 1;
    const perLevel = V * V;
    const positions = new Float32Array(perLevel * levels * 3);
    const normals = new Float32Array(perLevel * levels * 3);
    const quarter = n / 2;
    const inHoleCell = (k: number, i: number, j: number) =>
      k > 0 && i >= quarter && i < N - quarter && j >= quarter && j < N - quarter;
    const vertexUsed = (k: number, i: number, j: number) =>
      k === 0 || i <= quarter || i >= N - quarter || j <= quarter || j >= N - quarter;
    let triCount = 0;
    for (let k = 0; k < levels; k++) {
      const cells = k === 0 ? N * N : N * N - n * n;
      triCount += cells * 2;
    }
    const indices = new Uint32Array(triCount * 3);
    let ip = 0;
    const hg = new Float64Array(perLevel);

    for (let k = 0; k < levels; k++) {
      const s = spacing(k);
      const L = half(k);
      const off = k * perLevel;
      hg.fill(0);
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          if (!vertexUsed(k, i, j)) continue;
          hg[j * V + i] = vertexHeight(k, i, j);
        }
      }
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          if (!vertexUsed(k, i, j)) continue;
          const x = -L + i * s;
          const z = -L + j * s;
          const idx = off + j * V + i;
          positions[idx * 3] = x;
          positions[idx * 3 + 1] = hg[j * V + i];
          positions[idx * 3 + 2] = z;

          const outer = i === 0 || i === N || j === 0 || j === N;
          const inner =
            k > 0 &&
            ((i === quarter || i === N - quarter) && j >= quarter && j <= N - quarter ||
              (j === quarter || j === N - quarter) && i >= quarter && i <= N - quarter);
          let dhx: number;
          let dhz: number;
          if (outer || inner) {
            // Shared border vertices: same analytic stencil on both rings -> no shading seam.
            const e = outer && k < levels - 1 ? 2 * s : s;
            dhx = (analytic(x + e, z) - analytic(x - e, z)) / (2 * e);
            dhz = (analytic(x, z + e) - analytic(x, z - e)) / (2 * e);
          } else {
            dhx = (hg[j * V + i + 1] - hg[j * V + i - 1]) / (2 * s);
            dhz = (hg[(j + 1) * V + i] - hg[(j - 1) * V + i]) / (2 * s);
          }
          const inv = 1 / Math.sqrt(dhx * dhx + 1 + dhz * dhz);
          normals[idx * 3] = -dhx * inv;
          normals[idx * 3 + 1] = inv;
          normals[idx * 3 + 2] = -dhz * inv;
        }
      }
      // Stitched odd border vertices take the average normal of their even neighbours.
      if (k < levels - 1) {
        const avg = (a: number, b: number, c: number) => {
          let nx = normals[b * 3] + normals[c * 3];
          let ny = normals[b * 3 + 1] + normals[c * 3 + 1];
          let nz = normals[b * 3 + 2] + normals[c * 3 + 2];
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          normals[a * 3] = nx;
          normals[a * 3 + 1] = ny;
          normals[a * 3 + 2] = nz;
        };
        for (let t = 1; t < N; t += 2) {
          avg(off + t * V, off + (t - 1) * V, off + (t + 1) * V);
          avg(off + t * V + N, off + (t - 1) * V + N, off + (t + 1) * V + N);
          avg(off + t, off + t - 1, off + t + 1);
          avg(off + N * V + t, off + N * V + t - 1, off + N * V + t + 1);
        }
      }
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          if (inHoleCell(k, i, j)) continue;
          const v00 = off + j * V + i;
          const v10 = v00 + 1;
          const v01 = v00 + V;
          const v11 = v01 + 1;
          indices[ip++] = v00;
          indices[ip++] = v01;
          indices[ip++] = v11;
          indices[ip++] = v00;
          indices[ip++] = v11;
          indices[ip++] = v10;
        }
      }
    }
    return { positions, normals, indices, triangleCount: triCount };
  };

  return { layout, analytic, heightAt, buildMesh, extent };
}
