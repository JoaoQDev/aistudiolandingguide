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

/** Periodic Catmull-Rom interpolation of evenly spaced azimuth knots (az in radians, clockwise from North). */
export function azKnots(values: readonly number[], azRad: number): number {
  const n = values.length;
  let f = (azRad / (2 * Math.PI)) * n;
  f = ((f % n) + n) % n;
  const i1 = Math.floor(f);
  const t = f - i1;
  const p0 = values[(i1 - 1 + n) % n];
  const p1 = values[i1 % n];
  const p2 = values[(i1 + 1) % n];
  const p3 = values[(i1 + 2) % n];
  const t2 = t * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t);
}

/** Smooth azimuthal window: 1 inside [c - hw, c + hw], fading to 0 over `fade` (all degrees). */
function azWindow(azDeg: number, c: number, hw: number, fade: number): number {
  let d = Math.abs(azDeg - c) % 360;
  if (d > 180) d = 360 - d;
  return 1 - smooth(hw, hw + fade, d);
}

// ---------------------------------------------------------------------------------------------
// Large-scale layout (deterministic, so every site keeps the composition of the reference walk).
// The base cluster sits on a calm floor; the ground rises gently (3–6°) to a low crest toward the
// S/SW (the Sun/dome side for the default sky) and toward the E/NE, and dips toward the W/NW.
// Beyond the W/NW depression a broken far ridge turns steep faces toward the base: with a low Sun
// behind it those faces are self-shadowed (a dark band seen inside the depression), capped by
// gentler sunlit benches that read as thin bright rim lines. Illustrative scenery only.
// ---------------------------------------------------------------------------------------------

/** Knots every 30° from North (clockwise): crest height (m), rise start and crest radius (m). */
export const BOWL_HEIGHT = [-0.6, 1.0, 6.3, 6.2, 6.0, 6.3, 6.4, 6.8, 4.8, 6.0, 5.4, 1.8];
export const BOWL_RISE_START = [118, 128, 121, 98, 84, 64, 56, 60, 80, 40, 46, 70];
export const BOWL_CREST = [262, 250, 196, 180, 176, 165, 152, 158, 178, 104, 110, 150];

/**
 * Keep-flat pads (m) under prop clusters standing beyond the calm floor (the distant greenhouse
 * of propsLayout.ts): inside `r` the ground is levelled to the height at the pad centre, blending
 * back to the natural relief over PAD_BLEND metres. Harmless where nothing stands.
 */
export const BASE_PADS: ReadonlyArray<{ x: number; z: number; r: number }> = [
  { x: -324.2, z: 198.1, r: 46 },
];
const PAD_BLEND = 30;

interface FarRidge {
  /** Sector centre / half width / fade (degrees). */
  az: number;
  hw: number;
  fade: number;
  /** Crest radius (m) and its azimuthal wander amplitude. */
  r: number;
  wander: number;
  /** Face height (m), face width (m), bench width (m), bench height (m). */
  face: number;
  faceW: number;
  bench: number;
  benchH: number;
}

export const FAR_RIDGES: readonly FarRidge[] = [
  // Right of the Sun (as seen from the base): broken ridge beyond the W/NW depression.
  { az: 291, hw: 22, fade: 16, r: 1080, wander: 130, face: 46, faceW: 180, bench: 50, benchH: 6.5 },
];

// ---------------------------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------------------------

export function createHeightField(opts: HeightFieldOptions): HeightField {
  const layout = opts.lowPower ? TERRAIN_LAYOUT_LOW : TERRAIN_LAYOUT;
  const { s0, n, levels } = layout;
  const L0 = n * s0;
  const extent = L0 * 2 ** (levels - 1);
  const base = seedInt(opts.seed);
  const S = Array.from({ length: 20 }, (_, i) => hash2(base, i * 7919 + 13, 0x1234567));
  // Layout noise is seed-independent (the composition must not depend on the site).
  const SL = Array.from({ length: 8 }, (_, i) => hash2(0x2f1a, i * 104729 + 7, 0x7a11));

  // Subtle far-hill modulation from the site's skyline profile (illustrative only).
  const prof = opts.horizonElevDeg && opts.horizonElevDeg.length > 0 ? opts.horizonElevDeg : null;
  let profMax = 1;
  if (prof) for (const e of prof) if (Number.isFinite(e)) profMax = Math.max(profMax, e);
  const horizonFactor = (azDeg: number): number => {
    if (!prof) return 1;
    const f = (azDeg / 360) * prof.length;
    const i0 = Math.floor(f) % prof.length;
    const i1 = (i0 + 1) % prof.length;
    const w = f - Math.floor(f);
    const e = (Number.isFinite(prof[i0]) ? prof[i0] : 0) * (1 - w) + (Number.isFinite(prof[i1]) ? prof[i1] : 0) * w;
    return 0.8 + 0.4 * Math.min(1, Math.max(0, e / profMax));
  };

  /** Continuous counterpart of the ring spacing at radius r (used to band-limit features). */
  const spacingAt = (r: number): number => s0 * Math.max(1, (2 * r) / L0);
  /** Weight of a feature with wavelength `lambda` given local spacing `sc`. */
  const band = (lambda: number, sc: number): number => smooth(4 * sc, 8 * sc, lambda);

  /**
   * Cellular layer of round features (craters when `mound` is false, hummocks otherwise),
   * weighted by `gate(rc)` at the feature centre and band-limited by the local mesh spacing.
   */
  const featureLayer = (
    x: number,
    z: number,
    cell: number,
    prob: number,
    rMin: number,
    rMax: number,
    rel0: number,
    rel1: number,
    seedC: number,
    mound: boolean,
    gate: (px: number, pz: number) => number,
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
        const reach = mound ? 1.0 : 2.0;
        if (d2 >= reach * reach * R * R) continue;
        let w = gate(px, pz);
        if (w <= 0) continue;
        const rc = Math.sqrt(px * px + pz * pz);
        const scC = spacingAt(rc + R);
        w *= smooth(2 * scC, 4 * scC, R);
        if (w <= 0) continue;
        const h3 = hash2(i, j, seedC + 202);
        const amp = R * (rel0 + (rel1 - rel0) * ((h3 & 0xffff) / 65536));
        const t = Math.sqrt(d2) / R;
        if (mound) {
          const q = 1 - t * t;
          sum += w * amp * q * q;
        } else {
          sum += w * amp * craterProfile(t);
        }
      }
    }
    return sum;
  };

  const bowlWob = (x: number, z: number, sc: number): number =>
    14 * band(180, sc) * gnoise(x / 180 + 3.7, z / 180 - 1.3, SL[0]);
  const bowlRiseStart = (x: number, z: number, azR: number, sc: number): number =>
    azKnots(BOWL_RISE_START, azR) + 0.4 * bowlWob(x, z, sc);
  /** Bowl rim relief: 0 on the floor, rising to the crest, then easing back down. */
  const bowlAt = (x: number, z: number, r: number, azR: number, sc: number): number => {
    const wob = bowlWob(x, z, sc);
    const r0 = azKnots(BOWL_RISE_START, azR) + 0.4 * wob;
    const r1 = azKnots(BOWL_CREST, azR) + wob;
    const H = azKnots(BOWL_HEIGHT, azR) * (1 + 0.18 * gnoise(x / 260 - 5.5, z / 260 + 2.1, SL[1]));
    return H * (smooth(r0, r1, r) - 0.55 * smooth(r1, r1 + 260, r));
  };
  const azOf = (x: number, z: number): number => {
    const a = Math.atan2(x, -z);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  /** Pad weight (1 inside a pad, 0 beyond its blend ring) and index of the dominant pad. */
  let padNearest = 0;
  const padWeight = (x: number, z: number): number => {
    let w = 0;
    for (let i = 0; i < BASE_PADS.length; i++) {
      const p = BASE_PADS[i];
      const wi = 1 - smooth(p.r, p.r + PAD_BLEND, Math.hypot(x - p.x, z - p.z));
      if (wi > w) {
        w = wi;
        padNearest = i;
      }
    }
    return w;
  };

  /** Scratch: per far ridge, its sector weight then its crest radius (filled by `raw`). */
  const ridgeCrest = new Float64Array(2 * FAR_RIDGES.length);

  const rawCore = (x: number, z: number): number => {
    const r2 = x * x + z * z;
    const r = Math.sqrt(r2);
    const sc = spacingAt(r);
    let azDeg = (Math.atan2(x, -z) * 180) / Math.PI;
    if (azDeg < 0) azDeg += 360;
    const azR = (azDeg * Math.PI) / 180;
    const ux = r > 1e-6 ? x / r : 0;
    const uz = r > 1e-6 ? z / r : -1;
    let h = 0;

    // --- Calm floor of the base and the low bowl rim around it -----------------------------
    const r0 = bowlRiseStart(x, z, azR, sc);
    h += bowlAt(x, z, r, azR, sc);
    /** 0 on the calm floor (props), 1 beyond the start of the rim. */
    const rough = smooth(r0 - 8, r0 + 55, r);

    // Gentle metre-scale undulation everywhere (keeps the floor from looking ironed).
    h +=
      (0.5 + 0.5 * rough) *
      (0.5 * band(80, sc) * gnoise(x / 80, z / 80, S[0]) +
        0.26 * band(40, sc) * gnoise(x / 40 + 17.3, z / 40 - 4.1, S[1]) +
        0.11 * band(20, sc) * gnoise(x / 20 - 9.7, z / 20 + 3.3, S[2]));

    if (rough > 0) {
      // Rougher ground beyond the floor: lumpy swales, small soft craters and hummocks that
      // break the far plain into lit and shaded patches under the grazing Sun.
      const fr = rough * (1 - smooth(1800, 2600, r));
      h +=
        fr *
        (0.55 * band(56, sc) * gnoise(x / 56 + 1.1, z / 56 + 7.9, S[13]) +
          0.28 * band(27, sc) * gnoise(x / 27 - 3.4, z / 27 + 0.7, S[14]) +
          0.12 * band(13, sc) * gnoise(x / 13 + 8.8, z / 13 - 6.2, S[15]));
      const roughGate = (px: number, pz: number): number => {
        const rr = Math.sqrt(px * px + pz * pz);
        const rs = azKnots(BOWL_RISE_START, azOf(px, pz));
        return smooth(rs + 5, rs + 45, rr) * (1 - smooth(900, 1400, rr)) * (1 - padWeight(px, pz));
      };
      h += featureLayer(x, z, 34, 0.3, 3, 9, 0.1, 0.17, S[6], false, roughGate);
      h += featureLayer(x, z, 110, 0.4, 9, 26, 0.06, 0.11, S[7], false, roughGate);
      h += featureLayer(x, z, 60, 0.45, 8, 22, 0.08, 0.16, S[16], true, roughGate);
    }

    // Far ridge crest radii (per ridge) and the depression floor in front of their faces, where
    // the far swells/hummocks/hills are damped so the dark faces are seen whole from the base.
    let floorK = 0;
    const crest = ridgeCrest;
    if (r > 300) {
      for (let k = 0; k < FAR_RIDGES.length; k++) {
        const g = FAR_RIDGES[k];
        const sector = azWindow(azDeg, g.az, g.hw, g.fade);
        crest[k] = sector;
        if (sector <= 0) continue;
        const seedR = SL[2 + 2 * k];
        const rc =
          g.r +
          g.wander * gnoise(ux * 2.3 + 1.7 * k, uz * 2.3 - 0.9 * k, seedR) +
          0.13 * g.wander * gnoise(ux * 9.5 - 4.1, uz * 9.5 + 2.6, seedR + 2) +
          0.3 * g.wander * band(500, sc) * gnoise(x / 500, z / 500, seedR + 1);
        crest[FAR_RIDGES.length + k] = rc;
        const f0 = rc - g.faceW;
        floorK = Math.max(floorK, sector * smooth(f0 - 520, f0 - 220, r) * (1 - smooth(f0 + 0.3 * g.faceW, rc, r)));
      }
    }
    const keep = 1 - 0.85 * floorK;
    h -= 4 * floorK;

    // Broad swells of the plain beyond the base.
    const fM = smooth(160, 700, r) * keep;
    if (fM > 0) {
      h +=
        fM *
        (6 * gnoise(x / 520, z / 520, S[3]) +
          2.2 * band(260, sc) * gnoise(x / 260 + 5.1, z / 260 + 1.7, S[4]) +
          1.1 * band(130, sc) * gnoise(x / 130 - 2.9, z / 130 + 8.3, S[5]));
    }

    // Hummocks on the far plain and along the skyline (lit tops, shaded Sun-averted flanks).
    if (r > 250) {
      const farGate = (px: number, pz: number): number => {
        const rr = Math.sqrt(px * px + pz * pz);
        return smooth(300, 600, rr) * (1 - smooth(3600, 4600, rr)) * (1 - padWeight(px, pz));
      };
      h += keep * featureLayer(x, z, 230, 0.55, 28, 75, 0.07, 0.15, S[17], true, farGate);
      h += keep * featureLayer(x, z, 520, 0.5, 70, 180, 0.06, 0.12, S[18], true, farGate);
    }

    // Far low rolling hills on the horizon (modest: the skyline stays within ~2°).
    const fF = smooth(500, 1800, r) * (1 - smooth(4300, 5900, r)) * keep;
    if (fF > 0) {
      const an = vnoise(x / 2600 + 3.1, z / 2600 - 7.7, S[8]);
      const amp = (14 + 46 * an * an) * horizonFactor(azDeg);
      const b =
        0.5 * gnoise(x / 1700, z / 1700, S[9]) +
        0.3 * band(850, sc) * gnoise(x / 850 + 1.3, z / 850 - 2.2, S[10]) +
        0.18 * band(425, sc) * gnoise(x / 425 - 4.4, z / 425 + 6.1, S[11]) +
        0.1 * band(212, sc) * gnoise(x / 212 + 7.7, z / 212 + 0.6, S[12]);
      const ridge = 1 - Math.abs(gnoise(x / 900 + 11.1, z / 900 - 3.3, S[19]));
      h += fF * amp * (0.6 * (b + 0.5) + 0.4 * ridge * ridge);
    }

    // Broken far ridges facing the base (dark faces + bright rim benches when looking sunward).
    if (r > 500) {
      for (let k = 0; k < FAR_RIDGES.length; k++) {
        const g = FAR_RIDGES[k];
        const sector = crest[k];
        if (sector <= 0) continue;
        const rc = crest[FAR_RIDGES.length + k];
        const d = r - rc;
        if (d < -g.faceW - 10 || d > 900) continue;
        // Uneven height along the ridge (wavy crest line, never a flat-topped wall).
        const sel =
          0.8 +
          0.2 * gnoise(ux * 3.4 - 2.2 * k, uz * 3.4 + 3.3, SL[3 + 2 * k]) +
          0.12 * gnoise(ux * 11.3 + 1.9, uz * 11.3 - 7.4, SL[3 + 2 * k] + 3);
        const amp = sector * sel;
        const face = g.face * smooth(-g.faceW, -g.bench, d);
        // Rim benches of uneven width/height: the bright crest line thickens, thins and breaks.
        const benchVar = 0.25 + 1.3 * vnoise(ux * 15.0 + 3.3, uz * 15.0 - 1.1, SL[3 + 2 * k] + 5);
        const bench = g.benchH * benchVar * smooth(-g.bench, 0.25 * g.bench, d);
        const back = 0.6 * (g.face + g.benchH) * smooth(0.25 * g.bench, 0.25 * g.bench + 600, d);
        h += amp * (face + bench - back) * (1 - smooth(4300, 5900, r));
      }
    }

    // Lunar curvature drop (hides the mesh edge behind a natural horizon).
    h -= r2 / (2 * MOON_RADIUS_M);
    return h;
  };

  const padHeight = BASE_PADS.map((p) => rawCore(p.x, p.z));
  const raw = (x: number, z: number): number => {
    const h = rawCore(x, z);
    const w = padWeight(x, z);
    return w > 0 ? h + w * (padHeight[padNearest] - h) : h;
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
