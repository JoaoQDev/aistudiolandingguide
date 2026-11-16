import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildOrbitEarthPixels,
  buildSunGlowPixels,
  createOrbitBodies,
  sunGlowProfile,
} from './orbitBodies';
import { BodySubPoints, moonMeToGlobeLocal, subPointToMoonMeUnit } from './orbitEphemeris';
import {
  ORBIT_EARTH_DISTANCE,
  ORBIT_SUN_ALIGNMENT_PUSH,
  ORBIT_SUN_CORE_RADIUS,
  ORBIT_SUN_DISTANCE,
  ORBIT_SUN_GLOW_RADIUS,
} from './orbitScreen';

const localDir = (latDeg: number, lonEastDeg: number) => {
  const g = moonMeToGlobeLocal(subPointToMoonMeUnit(latDeg, lonEastDeg));
  return new THREE.Vector3(g.x, g.y, g.z);
};

describe('procedural textures', () => {
  it('builds a deterministic Earth map with oceans, land, ice and clouds', () => {
    const w = 64;
    const h = 32;
    const a = buildOrbitEarthPixels(w, h);
    const b = buildOrbitEarthPixels(w, h);
    expect(a).toHaveLength(w * h * 4);
    expect(Array.from(a)).toEqual(Array.from(b));
    let ocean = 0;
    let land = 0;
    let bright = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i + 3]).toBe(255);
      const [r, g, bl] = [a[i], a[i + 1], a[i + 2]];
      if (bl > r + 40 && bl > g) ocean++;
      else if (g > bl && g >= r - 30) land++;
      if (r > 200 && g > 200 && bl > 200) bright++;
    }
    const n = w * h;
    expect(ocean / n).toBeGreaterThan(0.25);
    expect(land / n).toBeGreaterThan(0.08);
    expect(bright / n).toBeGreaterThan(0.02);
    // Both polar rows are mostly ice.
    for (const row of [0, h - 1]) {
      let white = 0;
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4;
        if (a[i] > 190 && a[i + 1] > 190 && a[i + 2] > 190) white++;
      }
      expect(white / w).toBeGreaterThan(0.8);
    }
  });

  it('gives the Sun a saturated disc and a glow that fades to nothing at the quad edge', () => {
    const core = ORBIT_SUN_CORE_RADIUS / ORBIT_SUN_GLOW_RADIUS;
    expect(sunGlowProfile(0)).toBe(1);
    expect(sunGlowProfile(core * 0.99)).toBe(1);
    expect(sunGlowProfile(core + 0.02)).toBeLessThan(0.95);
    expect(sunGlowProfile(core + 0.02)).toBeGreaterThan(0.4);
    expect(sunGlowProfile(0.6)).toBeGreaterThan(0.01);
    expect(sunGlowProfile(0.6)).toBeLessThan(0.12);
    expect(sunGlowProfile(1)).toBe(0);
    let prev = 1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const p = sunGlowProfile(t);
      expect(p).toBeLessThanOrEqual(prev + 1e-12);
      prev = p;
    }

    const size = 64;
    const px = buildSunGlowPixels(size);
    expect(px).toHaveLength(size * size * 4);
    const alphaAt = (x: number, y: number) => px[(y * size + x) * 4 + 3];
    expect(alphaAt(size / 2, size / 2)).toBe(255);
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(size - 1, size / 2)).toBeLessThan(3);
  });
});

describe('orbit bodies', () => {
  const target: BodySubPoints = {
    sun: { latDeg: -1.5, lonEastDeg: 114.4 },
    earth: { latDeg: 3.6, lonEastDeg: 357.4 },
  };

  it('places both bodies along their exact directions when snapped', () => {
    const bodies = createOrbitBodies({ lowPower: true });
    bodies.setTarget(target, 0, true);
    expect(bodies.step(0.016)).toBe(false);

    const sunDir = localDir(-1.5, 114.4);
    const earthDir = localDir(3.6, 357.4);
    expect(bodies.sunDirLocal.angleTo(sunDir)).toBeLessThan(1e-9);
    expect(bodies.earthDirLocal.angleTo(earthDir)).toBeLessThan(1e-9);
    expect(bodies.sunPosLocal.length()).toBeCloseTo(ORBIT_SUN_DISTANCE, 9);
    expect(bodies.earthPosLocal.length()).toBeCloseTo(ORBIT_EARTH_DISTANCE, 9);
    expect(bodies.sunPosLocal.clone().normalize().angleTo(sunDir)).toBeLessThan(1e-9);

    const sun = bodies.group.getObjectByName('orbit-sun')!;
    const earth = bodies.group.getObjectByName('orbit-earth') as THREE.Mesh;
    expect(sun.position.distanceTo(bodies.sunPosLocal)).toBeLessThan(1e-12);
    expect(earth.position.distanceTo(bodies.earthPosLocal)).toBeLessThan(1e-12);
    bodies.dispose();
  });

  it('lights the Earth with the Sun direction in world space (correct phase)', () => {
    const globe = new THREE.Group();
    globe.rotation.x = Math.PI; // same flip as the viewport's globe group
    const bodies = createOrbitBodies({ lowPower: true });
    globe.add(bodies.group);
    globe.updateMatrixWorld(true);
    bodies.setTarget(target, 0, true);
    bodies.step(0);

    const earth = bodies.group.getObjectByName('orbit-earth') as THREE.Mesh;
    const uniform = (earth.material as THREE.ShaderMaterial).uniforms.uSunDirW.value as THREE.Vector3;
    const expected = localDir(-1.5, 114.4).applyQuaternion(globe.quaternion);
    expect(uniform.angleTo(expected)).toBeLessThan(1e-6);
    expect(uniform.length()).toBeCloseTo(1, 9);
    bodies.dispose();
  });

  it('eases toward a new epoch, stays near the equator and settles exactly', () => {
    const bodies = createOrbitBodies({ lowPower: true });
    bodies.setTarget(target, 0, true);
    bodies.step(0.016);

    const next: BodySubPoints = {
      sun: { latDeg: -1.4, lonEastDeg: 295 }, // almost opposite longitude
      earth: { latDeg: -5.7, lonEastDeg: 354.1 },
    };
    bodies.setTarget(next, 3000, false);
    let frames = 0;
    let moving = true;
    let lastGap = Number.POSITIVE_INFINITY;
    while (moving && frames < 600) {
      moving = bodies.step(1 / 60);
      frames++;
      const cur = bodies.current();
      expect(Math.abs(cur.sun.latDeg)).toBeLessThan(1.6);
      const gap = bodies.sunDirLocal.angleTo(localDir(-1.4, 295));
      expect(gap).toBeLessThanOrEqual(lastGap + 1e-9);
      lastGap = gap;
    }
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(240);
    expect(bodies.current().sun).toEqual(next.sun);
    expect(bodies.current().earth).toEqual(next.earth);
    expect(bodies.sunDirLocal.angleTo(localDir(-1.4, 295))).toBeLessThan(1e-9);
    // Once settled it stops asking for frames.
    expect(bodies.step(1 / 60)).toBe(false);
    bodies.dispose();
  });

  it('draws the Sun farther away than the Earth when the two line up', () => {
    const bodies = createOrbitBodies({ lowPower: true });
    bodies.setTarget(
      { sun: { latDeg: -1.5, lonEastDeg: 0 }, earth: { latDeg: 2, lonEastDeg: 359 } },
      0,
      true,
    );
    bodies.step(0);
    expect(bodies.sunPosLocal.length()).toBeGreaterThan(ORBIT_SUN_DISTANCE + ORBIT_SUN_ALIGNMENT_PUSH * 0.9);
    expect(bodies.sunPosLocal.distanceTo(bodies.earthPosLocal)).toBeGreaterThan(0.25);
    // The direction itself is untouched.
    expect(bodies.sunPosLocal.clone().normalize().angleTo(localDir(-1.5, 0))).toBeLessThan(1e-9);
    bodies.dispose();
  });

  it('can be hidden for the hero backdrop', () => {
    const bodies = createOrbitBodies({ lowPower: true });
    bodies.setVisible(false);
    expect(bodies.group.visible).toBe(false);
    bodies.setVisible(true);
    expect(bodies.group.visible).toBe(true);
    bodies.dispose();
  });
});
