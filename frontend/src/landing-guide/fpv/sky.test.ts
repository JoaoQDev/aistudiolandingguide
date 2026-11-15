import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  computeShadowBounds,
  createLunarSky,
  lightBasis,
  SHADOW_HALF_DEPTH,
  SHADOW_HALF_WIDTH,
  SHADOW_MAP_SIZE,
  snapToShadowTexels,
  SUN_INTENSITY,
} from './sky';
import { buildEarthTexture, EARTH_ANGULAR_DIAMETER_DEG } from './skyEarth';
import { envRadiance } from './skyEnv';
import { SUN_QUAD_RADIUS_PX, sunProfile } from './skySun';

const DEG = Math.PI / 180;
const dirOf = (azDeg: number, elDeg: number) =>
  new THREE.Vector3(
    Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG),
    Math.sin(elDeg * DEG),
    -Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG),
  );

describe('sun sprite profile', () => {
  it('has a small saturated core and a halo that fades to black', () => {
    expect(sunProfile(0)).toBe(1);
    expect(sunProfile(4)).toBeGreaterThan(0.8);
    // Halo right outside the ~10 px core sits around 90/255 like the reference frames.
    expect(sunProfile(6.5)).toBeGreaterThan(0.3);
    expect(sunProfile(6.5)).toBeLessThan(0.42);
    expect(sunProfile(30)).toBeGreaterThan(0.08);
    expect(sunProfile(30)).toBeLessThan(0.14);
    expect(sunProfile(75)).toBeLessThan(0.002);
    expect(sunProfile(SUN_QUAD_RADIUS_PX)).toBeLessThan(0.002);
  });

  it('decreases monotonically with radius', () => {
    let prev = Infinity;
    for (let r = 0; r <= SUN_QUAD_RADIUS_PX; r += 0.5) {
      const v = sunProfile(r);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('camera-following sun shadows', () => {
  it('sizes the light-space box from the sun elevation', () => {
    const low = computeShadowBounds(dirOf(252, 10));
    expect(low.right - low.left).toBeCloseTo(2 * SHADOW_HALF_WIDTH);
    // Ground footprint along the sun azimuth covers ±SHADOW_HALF_DEPTH.
    const sin10 = Math.sin(10 * DEG);
    expect(-low.bottom).toBeGreaterThanOrEqual(SHADOW_HALF_DEPTH * sin10);
    expect(low.top).toBeGreaterThan(SHADOW_HALF_DEPTH * sin10);
    // A low sun gives a much flatter box than a high one (resolution is not wasted).
    const high = computeShadowBounds(dirOf(252, 60));
    expect(low.top - low.bottom).toBeLessThan((high.top - high.bottom) / 2);
  });

  it('snaps the box centre to whole shadow-map texels', () => {
    const sunDir = dirOf(252, 10);
    const b = computeShadowBounds(sunDir);
    const tx = (b.right - b.left) / SHADOW_MAP_SIZE;
    const ty = (b.top - b.bottom) / SHADOW_MAP_SIZE;
    const bx = new THREE.Vector3();
    const by = new THREE.Vector3();
    lightBasis(sunDir, bx, by);
    for (const [x, z] of [
      [0.03, -0.07],
      [12.345, 98.76],
      [-301.2, 4.4],
    ]) {
      const c = snapToShadowTexels(new THREE.Vector3(x, 1.3, z), sunDir, tx, ty);
      const u = c.dot(bx) / tx;
      const v = c.dot(by) / ty;
      expect(Math.abs(u - Math.round(u))).toBeLessThan(1e-4);
      expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-4);
      // Moves by less than one texel diagonal.
      expect(c.distanceTo(new THREE.Vector3(x, 1.3, z))).toBeLessThan(Math.hypot(tx, ty));
    }
  });
});

describe('createLunarSky', () => {
  const fakeRenderer = {} as THREE.WebGLRenderer;

  it('builds a black sky with a sun light that follows the camera (lowPower: no shadows)', () => {
    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: true });
    expect((scene.background as THREE.Color).getHex()).toBe(0x000000);
    expect(scene.environment).toBeNull();
    expect(sky.sunLight.intensity).toBeCloseTo(SUN_INTENSITY);
    expect(sky.sunLight.castShadow).toBe(false);

    const sunDir = dirOf(252, 10);
    sky.setSunDirection(sunDir);
    sky.setEarthDirection(dirOf(100, -20));
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 6000);
    camera.position.set(40, 2.2, -15);
    camera.updateMatrixWorld();
    sky.update?.({ dt: 0.016, elapsed: 0, camera });

    const toLight = sky.sunLight.position.clone().sub(sky.sunLight.target.position).normalize();
    expect(toLight.dot(sunDir)).toBeGreaterThan(0.9999);
    // Earth below the horizon is not drawn; nothing in the sky group is a star field.
    const earth = sky.object.getObjectByName('earth');
    expect(earth?.visible).toBe(false);
    expect(sky.object.getObjectByName('sun-glow')).toBeTruthy();
    sky.dispose();
  });

  it('enables crisp camera-following shadows and survives a missing GPU environment', () => {
    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: false });
    expect(sky.sunLight.castShadow).toBe(true);
    expect(sky.sunLight.shadow.mapSize.x).toBeLessThanOrEqual(2048);
    sky.setSunDirection(dirOf(252, 10));
    const cam = sky.sunLight.shadow.camera;
    expect(cam.right - cam.left).toBeCloseTo(2 * SHADOW_HALF_WIDTH);
    // With a fake renderer PMREM fails; the module must fall back to light-based fill.
    expect(scene.environment).toBeNull();
    sky.dispose();
  });

  it('keeps the Earth at its true apparent size when above the horizon', () => {
    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: true });
    sky.setEarthDirection(dirOf(30, 25));
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 6000);
    camera.updateMatrixWorld();
    sky.update?.({ dt: 0.016, elapsed: 0, camera });
    const earth = sky.object.getObjectByName('earth') as THREE.Mesh;
    expect(earth.visible).toBe(true);
    const dist = earth.position.distanceTo(camera.position);
    const angularDiameter = (2 * Math.asin(earth.scale.x / dist)) / DEG;
    expect(angularDiameter).toBeCloseTo(EARTH_ANGULAR_DIAMETER_DEG, 2);
    sky.dispose();
  });
});

describe('sky textures', () => {
  it('lights the environment only from the ground (black sky)', () => {
    expect(envRadiance(0.3)).toEqual([0, 0, 0]);
    const g = envRadiance(-0.3);
    expect(g[0]).toBeGreaterThan(0.2);
    expect(g[0]).toBeLessThan(0.5);
  });

  it('builds a deterministic, varied Earth texture without a canvas', () => {
    const a = buildEarthTexture(64, 32);
    const b = buildEarthTexture(64, 32);
    const da = a.image.data as Uint8Array;
    const db = b.image.data as Uint8Array;
    expect(da.length).toBe(64 * 32 * 4);
    expect(Array.from(da.slice(0, 400))).toEqual(Array.from(db.slice(0, 400)));
    const blues = new Set<number>();
    for (let i = 2; i < da.length; i += 4) blues.add(da[i]);
    expect(blues.size).toBeGreaterThan(20);
    a.dispose();
    b.dispose();
  });
});
