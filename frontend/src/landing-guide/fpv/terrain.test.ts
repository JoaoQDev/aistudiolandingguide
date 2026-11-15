import { describe, expect, it } from 'vitest';
import { createHeightField } from './terrainHeight';
import { generateRegolithTexture } from './terrainTexture';

/** Height of the mesh triangle under (x, z) computed directly from the built mesh data. */
function meshHeight(
  mesh: ReturnType<ReturnType<typeof createHeightField>['buildMesh']>,
  x: number,
  z: number,
): number | null {
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const minX = Math.min(p[a], p[b], p[c]);
    const maxX = Math.max(p[a], p[b], p[c]);
    const minZ = Math.min(p[a + 2], p[b + 2], p[c + 2]);
    const maxZ = Math.max(p[a + 2], p[b + 2], p[c + 2]);
    if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
    const v0x = p[b] - p[a];
    const v0z = p[b + 2] - p[a + 2];
    const v1x = p[c] - p[a];
    const v1z = p[c + 2] - p[a + 2];
    const v2x = x - p[a];
    const v2z = z - p[a + 2];
    const den = v0x * v1z - v1x * v0z;
    const u = (v2x * v1z - v1x * v2z) / den;
    const v = (v0x * v2z - v2x * v0z) / den;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    return p[a + 1] + u * (p[b + 1] - p[a + 1]) + v * (p[c + 1] - p[a + 1]);
  }
  return null;
}

describe('lunar ground height field', () => {
  it('is deterministic and finite', () => {
    const a = createHeightField({ seed: 42, lowPower: false });
    const b = createHeightField({ seed: 42, lowPower: false });
    for (let i = 0; i < 400; i++) {
      const x = Math.sin(i * 12.9898) * 3000;
      const z = Math.cos(i * 78.233) * 3000;
      const h = a.heightAt(x, z);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBe(b.heightAt(x, z));
    }
    expect(Number.isFinite(a.heightAt(Number.NaN, 0))).toBe(true);
    expect(Number.isFinite(a.heightAt(1e7, -1e7))).toBe(true);
  });

  it('keeps the base area nearly flat', () => {
    const f = createHeightField({ seed: 7, lowPower: false });
    expect(Math.abs(f.heightAt(0, 0))).toBeLessThan(0.05);
    let min = Infinity;
    let max = -Infinity;
    let maxSlope = 0;
    for (let x = -100; x <= 100; x += 2.5) {
      for (let z = -100; z <= 100; z += 2.5) {
        const h = f.heightAt(x, z);
        min = Math.min(min, h);
        max = Math.max(max, h);
        const s = Math.hypot(f.heightAt(x + 1, z) - h, f.heightAt(x, z + 1) - h);
        maxSlope = Math.max(maxSlope, s);
      }
    }
    expect(max - min).toBeLessThan(1.2);
    expect(maxSlope).toBeLessThan(0.09); // < ~5°
  });

  it('raises distant hills above the plain', () => {
    const f = createHeightField({ seed: 3, lowPower: false });
    let far = -Infinity;
    for (let a = 0; a < 360; a += 3) {
      const r = 2400;
      far = Math.max(far, f.heightAt(Math.sin((a * Math.PI) / 180) * r, -Math.cos((a * Math.PI) / 180) * r));
    }
    expect(far).toBeGreaterThan(15);
  });

  it('heightAt matches the rendered triangles (low-power mesh)', () => {
    const f = createHeightField({ seed: 11, lowPower: true });
    const mesh = f.buildMesh();
    expect(mesh.triangleCount).toBe(mesh.indices.length / 3);
    const pts: Array<[number, number]> = [
      [0.3, 0.7],
      [13.1, -57.9],
      [191.7, 3.2], // ring border (stitched)
      [-192.2, 100.5],
      [250.4, -300.6],
      [-383.9, 384.1],
      [700.2, -10.5],
    ];
    for (const [x, z] of pts) {
      const hm = meshHeight(mesh, x, z);
      expect(hm).not.toBeNull();
      expect(Math.abs(f.heightAt(x, z) - (hm as number))).toBeLessThan(0.01);
    }
  });

  it('builds a mesh within the triangle budget', () => {
    const f = createHeightField({ seed: 1, lowPower: false });
    const t0 = performance.now();
    const mesh = f.buildMesh();
    const dt = performance.now() - t0;
    expect(mesh.triangleCount).toBeLessThan(400_000);
    expect(f.extent).toBeGreaterThan(3000);
    for (let i = 0; i < mesh.positions.length; i += 997) expect(Number.isFinite(mesh.positions[i])).toBe(true);
    console.info(`terrain mesh: ${mesh.triangleCount} tris in ${dt.toFixed(0)} ms`);
  });
});

describe('regolith detail texture', () => {
  it('is deterministic RGBA with neutral mean slope', () => {
    const t0 = performance.now();
    const a = generateRegolithTexture(512, 5);
    const dt = performance.now() - t0;
    const b = generateRegolithTexture(512, 5);
    expect(a.data.length).toBe(512 * 512 * 4);
    expect(a.data).toEqual(b.data);
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      sx += a.data[i] - 128;
      sy += a.data[i + 1] - 128;
    }
    const n = a.data.length / 4;
    expect(Math.abs(sx / n)).toBeLessThan(2);
    expect(Math.abs(sy / n)).toBeLessThan(2);
    console.info(`regolith 512: ${dt.toFixed(0)} ms`);
  });
});
