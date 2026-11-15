import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CRATE_SPECS, containerLayout, crateGeometry, moduleLayout } from './propsCrates';
import { ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, ROVER_HEIGHT, ROVER_WHEEL_RADIUS, roverGeometry } from './propsRover';
import { TANK_HEIGHT, TANK_MAST_TOP, TANK_RADIUS, tankGeometry, tankProfile } from './propsTanks';
import { crateAtlas, crateMaps, tankDetailMap, type CrateStyle } from './propsTextures';

const STYLES: CrateStyle[] = ['hazard', 'row', 'dark'];
const EYE = 1.7;

function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!.clone();
}

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('props kit: crates', () => {
  it('builds each crate to its spec envelope (stacking height = h + rim)', () => {
    for (const style of STYLES) {
      const spec = CRATE_SPECS[style];
      const g = crateGeometry(spec);
      const b = bbox(g);
      const H = spec.h + (spec.lid?.t ?? 0);
      expect(b.min.y).toBeCloseTo(0, 3);
      expect(b.max.y).toBeLessThanOrEqual(H + 1e-3);
      expect(b.max.y).toBeGreaterThan(H - 0.02);
      expect(b.max.x - b.min.x).toBeCloseTo(spec.w, 2);
      expect(b.max.z - b.min.z).toBeCloseTo(spec.d, 2);
      g.dispose();
    }
  });

  it('keeps containers in proportion with the 1.7 m eye height', () => {
    for (const style of ['hazard', 'dark'] as const) {
      const s = CRATE_SPECS[style];
      expect(s.h + (s.lid?.t ?? 0)).toBeGreaterThan(0.55 * EYE);
      expect(s.h + (s.lid?.t ?? 0)).toBeLessThan(0.8 * EYE);
      expect(s.w / s.h).toBeGreaterThan(1.8);
    }
    const row = CRATE_SPECS.row;
    expect(row.h / TANK_HEIGHT).toBeGreaterThan(0.5);
    expect(row.h / TANK_HEIGHT).toBeLessThan(0.7);
  });

  it('has real relief: recessed panels and protruding corner blocks', () => {
    const spec = CRATE_SPECS.hazard;
    const L = containerLayout(spec, 'hazard');
    expect(L.rd).toBeGreaterThan(0.015);
    expect(L.pi).toBeGreaterThan(0.015);
    expect(L.win.x).toBeLessThan(L.m);
    expect(L.label.y0).toBeGreaterThan(L.win.y1);
    const M = moduleLayout(CRATE_SPECS.row);
    expect(M.px[2] + M.ps / 2).toBeLessThan(CRATE_SPECS.row.w / 2);
    // the front faces sit at several depths (corner block, plate, recess)
    const g = crateGeometry(spec);
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const depths = new Set<number>();
    for (let i = 0; i < pos.count; i++) if (nrm.getZ(i) > 0.99) depths.add(Math.round(pos.getZ(i) * 1000));
    expect(depths.size).toBeGreaterThanOrEqual(3);
    g.dispose();
  });

  it('maps every vertex inside the atlas and stays cheap', () => {
    for (const style of STYLES) {
      const g = crateGeometry(CRATE_SPECS[style]);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
        expect(uv.getX(i)).toBeLessThanOrEqual(1);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
        expect(uv.getY(i)).toBeLessThanOrEqual(1);
      }
      expect(tris(g)).toBeLessThan(2000);
      g.dispose();
    }
  });

  it('falls back to plain colours without a 2D canvas', () => {
    expect(crateAtlas('hazard', false, 1)).toBeNull();
    expect(crateMaps('dark', false, 1)).toBeNull();
    expect(tankDetailMap(false, 1)).toBeNull();
  });
});

describe('props kit: tanks', () => {
  it('stands ≈ 1.8 m to the cap top, ≈ 0.85 m wide, with a thin mast above', () => {
    const g = tankGeometry(false);
    const b = bbox(g);
    expect(b.min.y).toBeCloseTo(0, 3);
    expect(b.max.y).toBeCloseTo(TANK_MAST_TOP, 2);
    expect(b.max.x - b.min.x).toBeGreaterThan(0.82);
    expect(b.max.x - b.min.x).toBeLessThan(0.92);
    expect(TANK_HEIGHT).toBeGreaterThan(1.0 * EYE);
    expect(TANK_HEIGHT).toBeLessThan(1.12 * EYE);
    expect(2 * TANK_RADIUS).toBeCloseTo(0.85, 2);
    expect(tris(g)).toBeLessThan(4000);
    g.dispose();
  });

  it('has a collar, a truncated-cone cap with a flat top and a ribbed band', () => {
    const prof = tankProfile();
    const top = prof[prof.length - 1];
    expect(top.y).toBeCloseTo(TANK_HEIGHT, 5);
    // flat top: the last two points share the cap height, top radius well below the body radius
    const rim = prof[prof.length - 2];
    expect(rim.y).toBeCloseTo(TANK_HEIGHT, 5);
    expect(rim.x).toBeLessThan(TANK_RADIUS * 0.55);
    // collar overhangs the body; ribbed band is inset below it
    const maxR = Math.max(...prof.filter((p) => p.y > 1.3).map((p) => p.x));
    const minR = Math.min(...prof.filter((p) => p.y > 1.37 && p.y < 1.5).map((p) => p.x));
    expect(maxR).toBeGreaterThan(TANK_RADIUS);
    expect(minR).toBeLessThan(TANK_RADIUS * 0.9);
  });
});

describe('props kit: rover', () => {
  it('is a buggy with big wheels (Ø ≈ 45 % of its length) and two antennas', () => {
    const g = roverGeometry(false);
    const b = bbox(g);
    const length = b.max.x - b.min.x;
    expect((2 * ROVER_WHEEL_RADIUS) / length).toBeGreaterThan(0.4);
    expect((2 * ROVER_WHEEL_RADIUS) / length).toBeLessThan(0.5);
    expect(b.max.x).toBeLessThanOrEqual(ROVER_HALF_LENGTH + 0.05);
    expect(Math.max(-b.min.z, b.max.z)).toBeLessThanOrEqual(ROVER_HALF_WIDTH + 0.05);
    expect(b.max.y).toBeCloseTo(ROVER_HEIGHT, 1);
    expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(tris(g)).toBeLessThan(15000);
    g.dispose();
  });
});
