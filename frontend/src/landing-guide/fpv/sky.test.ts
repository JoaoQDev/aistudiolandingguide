import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  computeShadowBounds,
  configureRenderer,
  createLunarSky,
  ENV_INTENSITY,
  lightBasis,
  SHADOW_HALF_DEPTH,
  SHADOW_HALF_WIDTH,
  SHADOW_MAP_SIZE,
  SKY_EXPOSURE,
  snapToShadowTexels,
  SUN_INTENSITY,
} from './sky';
import { EasedDirection, EasedScalar, EasedSun, easeAlpha, LIGHT_EASE_TAU_S, LIGHT_SNAP_ANGLE_DEG } from './skyEase';
import { buildEarthTexture, EARTH_ANGULAR_DIAMETER_DEG, EARTH_DRAWN_DIAMETER_DEG, EARTH_DRAWN_SIZE_FACTOR } from './skyEarth';
import { envRadiance } from './skyEnv';
import {
  earthLitFraction,
  earthshineIntensity,
  groundBounce,
  HELMET_LAMP_INTENSITY,
  HELMET_LAMP_REACH_M,
  lowSunFactor,
  nightFactor,
  NIGHT_HEMI_SKY,
  shadowFade,
  starGain,
  sunGate,
  sunGlowGain,
} from './skyNight';
import { buildStarData } from './skyStars';
import { SUN_QUAD_RADIUS_PX, sunProfile } from './skySun';
import { discVisibleFraction, findGroundHeight, GROUND_OBJECT_NAME, registerGroundHeight, skylineElevation } from './terrainSkyline';

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
    // Halo right outside the ~10 px core sits around 95/255 like the reference frames.
    expect(sunProfile(6.5)).toBeGreaterThan(0.3);
    expect(sunProfile(6.5)).toBeLessThan(0.42);
    expect(sunProfile(30)).toBeGreaterThan(0.08);
    expect(sunProfile(30)).toBeLessThan(0.14);
    // Long, faint tail (reference: still ~5/255 at 60 px), gone before the quad edge.
    expect(sunProfile(60)).toBeGreaterThan(0.01);
    expect(sunProfile(60)).toBeLessThan(0.035);
    expect(sunProfile(100)).toBeLessThan(0.002);
  });

  it('matches the measured reference halo along screen directions', () => {
    // Median display values (×255) measured on the reference frames t08/t12/t21/t30.
    const ref: Record<string, [number, number][]> = {
      right: [[25, 46], [40, 26], [60, 10]],
      left: [[25, 33], [40, 16], [60, 3]],
      up: [[25, 38], [40, 16], [60, 5]],
      down: [[25, 48], [40, 26], [60, 12]],
    };
    const dirs: Record<string, [number, number]> = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] };
    for (const [name, samples] of Object.entries(ref)) {
      const [dx, dy] = dirs[name];
      for (const [r, v] of samples) expect(Math.abs(sunProfile(r, dx, dy) * 255 - v)).toBeLessThan(5);
    }
    // The tail is longer toward the lower right, as in the reference.
    expect(sunProfile(40, 1, 0)).toBeGreaterThan(sunProfile(40, -1, 0) * 1.5);
    expect(sunProfile(40, 0, -1)).toBeGreaterThan(sunProfile(40, 0, 1) * 1.3);
  });

  it('keeps the inner shoulder at the level measured around the core centroid', () => {
    // Radial means (×255) around the centroid of the saturated core on the full-res reference frames
    // t08/t21/t30/t47 (min–max over the four frames). Single-row samples from a centroid polluted by
    // other bright pixels read much higher (138–229 at r 8) and are not a property of the halo.
    const ref: [number, number, number][] = [
      [7, 92, 109],
      [8, 86, 105],
      [10, 75, 93],
      [12, 65, 81],
      [16, 54, 66],
    ];
    for (const [r, lo, hi] of ref) {
      const v = sunProfile(r) * 255;
      expect(v).toBeGreaterThanOrEqual(lo - 3);
      expect(v).toBeLessThanOrEqual(hi + 3);
    }
  });

  it('decreases monotonically with radius and fits inside the quad in every direction', () => {
    for (let a = 0; a < 360; a += 15) {
      const dx = Math.cos((a * Math.PI) / 180);
      const dy = Math.sin((a * Math.PI) / 180);
      let prev = Infinity;
      for (let r = 0; r <= SUN_QUAD_RADIUS_PX; r += 0.5) {
        const v = sunProfile(r, dx, dy);
        expect(v).toBeLessThanOrEqual(prev + 1e-9);
        prev = v;
      }
      expect(sunProfile(SUN_QUAD_RADIUS_PX, dx, dy)).toBeLessThan(0.0015);
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

describe('exposure and fill calibration', () => {
  // Khronos PBR Neutral below the compression knee (three.js NeutralToneMapping), grey input.
  const neutral = (x: number) => {
    const e = x * SKY_EXPOSURE;
    return e - (e < 0.08 ? e - 6.25 * e * e : 0.04);
  };
  const toSrgb255 = (l: number) => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);

  it('configures the renderer with the calibrated exposure and a black clear colour', () => {
    let clear = -1;
    const renderer = {
      shadowMap: { enabled: false, type: 0 },
      setClearColor: (c: number) => {
        clear = c;
      },
    } as unknown as THREE.WebGLRenderer;
    configureRenderer(renderer, false);
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.toneMappingExposure).toBe(SKY_EXPOSURE);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(clear).toBe(0x000000);
    configureRenderer(renderer, true);
    expect(renderer.shadowMap.enabled).toBe(false);
  });

  it('keeps sunlit faces in the linear range and shadowed faces dark but not black', () => {
    expect(SKY_EXPOSURE).toBeGreaterThan(0.8);
    expect(SKY_EXPOSURE).toBeLessThan(0.95);
    // A neutral 0.5-albedo face lit at 60° lands mid-grey, well below the compression knee.
    const lit = toSrgb255(neutral(0.5 * Math.cos(60 * DEG)));
    expect(lit).toBeGreaterThan(110);
    expect(lit).toBeLessThan(140);
    // Vertical 0.5-albedo face turned away from the Sun: it sees half of the regolith environment
    // (radiance ≈ 0.33 · ENV_INTENSITY) plus the weak hemisphere fill (≈ 0.02).
    const groundRadiance = envRadiance(-0.4)[1];
    const shade = toSrgb255(neutral(0.5 * (0.5 * groundRadiance * ENV_INTENSITY + 0.02)));
    expect(shade).toBeGreaterThan(8);
    expect(shade).toBeLessThan(40);
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
    // Drawn at most twice its true size, and the factor is exported for the UI to mention.
    expect(EARTH_DRAWN_SIZE_FACTOR).toBeGreaterThanOrEqual(1);
    expect(EARTH_DRAWN_SIZE_FACTOR).toBeLessThanOrEqual(2);
    expect(EARTH_DRAWN_DIAMETER_DEG).toBeCloseTo(EARTH_ANGULAR_DIAMETER_DEG * EARTH_DRAWN_SIZE_FACTOR, 6);
    expect(angularDiameter).toBeCloseTo(EARTH_DRAWN_DIAMETER_DEG, 2);
    // Sinking: still drawn while part of the disc can clear the horizon, gone well below it.
    sky.setEarthDirection(dirOf(30, 1));
    sky.setEarthDirection(dirOf(30, -1));
    for (let i = 0; i < 100; i++) sky.update?.({ dt: 0.05, elapsed: 0, camera });
    expect(earth.visible).toBe(true);
    sky.setEarthDirection(dirOf(30, -9));
    for (let i = 0; i < 100; i++) sky.update?.({ dt: 0.05, elapsed: 0, camera });
    expect(earth.visible).toBe(false);
    sky.dispose();
  });
});

describe('lighting easing', () => {
  it('is frame-rate independent for directions and scalars', () => {
    const run = (steps: number, total: number) => {
      const d = new EasedDirection(dirOf(252, 10));
      d.set(dirOf(252, 10));
      d.set(dirOf(240, 2));
      const s = new EasedScalar(1);
      s.set(1);
      s.set(0.2);
      for (let i = 0; i < steps; i++) {
        d.step(total / steps);
        s.step(total / steps);
      }
      return { dir: d.value.clone(), scalar: s.value, left: d.value.angleTo(d.target) };
    };
    const a = run(1, 0.3);
    const b = run(18, 0.3);
    const c = run(77, 0.3);
    expect(a.dir.angleTo(b.dir)).toBeLessThan(1e-6);
    expect(a.dir.angleTo(c.dir)).toBeLessThan(1e-6);
    expect(a.scalar).toBeCloseTo(b.scalar, 9);
    expect(a.scalar).toBeCloseTo(c.scalar, 9);
    // After one time constant 1/e of the way is left, whatever the frame time.
    const start = dirOf(252, 10).angleTo(dirOf(240, 2));
    expect(run(24, LIGHT_EASE_TAU_S).left / start).toBeCloseTo(Math.exp(-1), 4);
    expect(easeAlpha(0)).toBe(0);
    expect(easeAlpha(-1)).toBe(0);
    expect(easeAlpha(Number.NaN)).toBe(0);
    expect(LIGHT_EASE_TAU_S).toBeGreaterThanOrEqual(0.3);
    expect(LIGHT_EASE_TAU_S).toBeLessThanOrEqual(0.5);
  });

  it('snaps on the first value and on big jumps, eases small steps', () => {
    const d = new EasedDirection(dirOf(0, 45));
    // First call: applied at once, however far it is.
    expect(d.set(dirOf(252, 10))).toBe(true);
    expect(d.value.angleTo(dirOf(252, 10))).toBeLessThan(1e-9);
    // Playback step (0.5° of azimuth): eased.
    expect(d.set(dirOf(251.5, 10))).toBe(false);
    expect(d.value.angleTo(dirOf(252, 10))).toBeLessThan(1e-9);
    d.step(0.016);
    const moved = d.value.angleTo(dirOf(252, 10));
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.5 * DEG);
    for (let i = 0; i < 400; i++) d.step(0.016);
    expect(d.value.angleTo(dirOf(251.5, 10))).toBeLessThan(1e-4);
    expect(d.value.length()).toBeCloseTo(1, 9);
    // Site switch: more than the snap angle away.
    expect(d.set(dirOf(251.5 + LIGHT_SNAP_ANGLE_DEG + 3, 10))).toBe(true);
    expect(d.value.angleTo(d.target)).toBe(0);
    // Garbage is ignored.
    expect(d.set(new THREE.Vector3(Number.NaN, 0, 0))).toBe(false);
    expect(d.set(new THREE.Vector3(0, 0, 0))).toBe(false);
    expect(Number.isFinite(d.value.x)).toBe(true);
  });

  it('snaps the illumination together with a direction jump', () => {
    const sun = new EasedSun(dirOf(0, 10));
    sun.setDirection(dirOf(252, 11.6));
    sun.setIllumination(1);
    expect(sun.illumination).toBe(1);
    // Playback: the new fraction is eased.
    sun.setDirection(dirOf(251.5, 11.5));
    sun.setIllumination(0.4);
    expect(sun.illumination).toBe(1);
    sun.step(0.1);
    expect(sun.illumination).toBeLessThan(1);
    expect(sun.illumination).toBeGreaterThan(0.4);
    // Site switch (Sun 90° away): direction and illumination change at once.
    sun.setDirection(dirOf(160, -9));
    sun.setIllumination(0);
    expect(sun.illumination).toBe(0);
    expect(sun.direction.angleTo(dirOf(160, -9))).toBeLessThan(1e-9);
    // Out-of-range fractions are clamped.
    sun.setIllumination(7);
    for (let i = 0; i < 400; i++) sun.step(0.016);
    expect(sun.illumination).toBe(1);
  });
});

describe('mission illumination', () => {
  const fakeRenderer = {} as THREE.WebGLRenderer;
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 6000);
  camera.position.set(3, 1.7, 4);
  camera.updateMatrixWorld();
  const settle = (sky: ReturnType<typeof createLunarSky>) => {
    for (let i = 0; i < 200; i++) sky.update?.({ dt: 0.05, elapsed: i * 0.05, camera });
  };

  it('keeps every night term exactly off in daylight', () => {
    expect(nightFactor(1)).toBe(0);
    expect(starGain(1)).toBe(0);
    expect(sunGlowGain(1)).toBe(1);
    expect(sunGate(1)).toBe(1);
    expect(groundBounce(Math.sin(10 * DEG))).toBe(1);
    expect(groundBounce(Math.sin(11.6 * DEG))).toBe(1);
    expect(lowSunFactor(Math.sin(10 * DEG))).toBe(0);
    expect(lowSunFactor(Math.sin(11.6 * DEG))).toBe(0);
    expect(shadowFade(Math.sin(11.6 * DEG))).toBe(1);

    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: true });
    sky.setSunDirection(dirOf(252, 11.6));
    sky.setEarthDirection(dirOf(135, 12));
    sky.setSunIllumination?.(1);
    settle(sky);
    expect(sky.sunLight.intensity).toBeCloseTo(SUN_INTENSITY, 9);
    const lamp = sky.object.getObjectByName('helmet-lamp') as THREE.SpotLight;
    const earthshine = sky.object.getObjectByName('earthshine') as THREE.DirectionalLight;
    const hemi = sky.object.getObjectByName('fill') as THREE.HemisphereLight;
    // The lamp and the earthshine stay in the scene (no shader recompiles) but give no light at all.
    expect(lamp.visible).toBe(true);
    expect(lamp.intensity).toBe(0);
    expect(earthshine.intensity).toBe(0);
    expect(sky.object.getObjectByName('stars')?.visible).toBe(false);
    expect(sky.object.getObjectByName('sun-glow')?.visible).toBe(true);
    // The tuned daylight fill, untouched.
    expect(hemi.color.r).toBeCloseTo(0.1, 9);
    expect(hemi.groundColor.r).toBeCloseTo(0.49, 9);
    sky.dispose();
  });

  it('scales everything Sun-driven to zero at night and brings in the night look', () => {
    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: true });
    sky.setSunDirection(dirOf(285, -5.7));
    sky.setEarthDirection(dirOf(325, 12.4));
    sky.setSunIllumination?.(0);
    // The first state is applied at once (no fade from a default daylight).
    expect(sky.sunLight.intensity).toBe(0);
    settle(sky);
    expect(sky.sunLight.intensity).toBe(0);
    expect(sky.object.getObjectByName('sun-glow')?.visible).toBe(false);
    const hemi = sky.object.getObjectByName('fill') as THREE.HemisphereLight;
    // No Sun bounce left in the fill: only the dim night ambient.
    expect(hemi.color.r).toBeCloseTo(NIGHT_HEMI_SKY[0], 9);
    expect(hemi.groundColor.r).toBeLessThan(0.1);
    const lamp = sky.object.getObjectByName('helmet-lamp') as THREE.SpotLight;
    expect(lamp.intensity).toBeCloseTo(HELMET_LAMP_INTENSITY, 9);
    expect(lamp.distance).toBe(HELMET_LAMP_REACH_M);
    expect(lamp.distance).toBeGreaterThanOrEqual(20);
    expect(lamp.distance).toBeLessThanOrEqual(30);
    expect(lamp.castShadow).toBe(false);
    // Cool white, and it follows the camera.
    expect(lamp.color.b).toBeGreaterThan(lamp.color.r);
    expect(lamp.position.distanceTo(camera.position)).toBeLessThan(0.5);
    expect(sky.object.getObjectByName('stars')?.visible).toBe(true);
    // Earth above the horizon: a weak bluish fill from its direction.
    const earthshine = sky.object.getObjectByName('earthshine') as THREE.DirectionalLight;
    expect(earthshine.intensity).toBeGreaterThan(0);
    expect(earthshine.intensity).toBeLessThan(SUN_INTENSITY * 0.25);
    expect(earthshine.color.b).toBeGreaterThan(earthshine.color.r);
    expect(earthshine.position.clone().normalize().dot(dirOf(325, 12.4))).toBeGreaterThan(0.9999);
    // Earth below the horizon (permanently shadowed floor): no earthshine, the lamp stays.
    sky.setEarthDirection(dirOf(325, -9));
    settle(sky);
    expect(earthshine.intensity).toBe(0);
    expect(lamp.intensity).toBeCloseTo(HELMET_LAMP_INTENSITY, 9);
    sky.dispose();
  });

  it('fades between day and night over a few tenths of a second', () => {
    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: true });
    sky.setSunDirection(dirOf(303, 0.6));
    sky.setSunIllumination?.(1);
    sky.setSunDirection(dirOf(302.5, 0.4));
    sky.setSunIllumination?.(0);
    // Nothing jumps when the new state arrives...
    expect(sky.sunLight.intensity).toBeCloseTo(SUN_INTENSITY, 9);
    sky.update?.({ dt: 0.1, elapsed: 0.1, camera });
    // ...it moves a little every frame...
    expect(sky.sunLight.intensity).toBeLessThan(SUN_INTENSITY);
    expect(sky.sunLight.intensity).toBeGreaterThan(SUN_INTENSITY * 0.5);
    const lamp = sky.object.getObjectByName('helmet-lamp') as THREE.SpotLight;
    expect(lamp.intensity).toBe(0);
    // ...and gets there.
    settle(sky);
    expect(sky.sunLight.intensity).toBe(0);
    expect(lamp.intensity).toBeCloseTo(HELMET_LAMP_INTENSITY, 9);
    const toLight = sky.sunLight.position.clone().sub(sky.sunLight.target.position).normalize();
    expect(toLight.dot(dirOf(302.5, 0.4))).toBeGreaterThan(0.999999);
    sky.dispose();
  });

  it('fades the cast shadows out before the Sun reaches the horizon (full shadows from ~2° up)', () => {
    expect(shadowFade(Math.sin(4 * DEG))).toBe(1);
    expect(shadowFade(Math.sin(1.2 * DEG))).toBeGreaterThan(0);
    expect(shadowFade(Math.sin(1.2 * DEG))).toBeLessThan(1);
    expect(shadowFade(0)).toBe(0);
    expect(shadowFade(Math.sin(-9 * DEG))).toBe(0);
    const scene = new THREE.Scene();
    const sky = createLunarSky({ renderer: fakeRenderer, scene, lowPower: false });
    sky.setSunDirection(dirOf(252, 8));
    sky.setSunIllumination?.(1);
    expect(sky.sunLight.shadow.intensity).toBe(1);
    expect(sky.sunLight.shadow.autoUpdate).toBe(true);
    // Sun on / under the horizon: the shadow box stays sane and the shadow pass is skipped.
    for (const el of [1.5, 0, -0.5, -9]) {
      const b = computeShadowBounds(dirOf(252, el));
      expect(Number.isFinite(b.top) && Number.isFinite(b.bottom)).toBe(true);
      expect(b.top - b.bottom).toBeGreaterThan(20);
      expect(b.top - b.bottom).toBeLessThan(60);
    }
    sky.setSunDirection(dirOf(160, -9));
    sky.setSunIllumination?.(0);
    expect(sky.sunLight.castShadow).toBe(true);
    expect(sky.sunLight.shadow.intensity).toBe(0);
    expect(sky.sunLight.shadow.autoUpdate).toBe(false);
    sky.dispose();
  });

  it('gives a fuller Earth more earthshine and none by day', () => {
    const sunBehind = dirOf(140, -5);
    const earth = dirOf(320, 15);
    expect(earthLitFraction(sunBehind, earth)).toBeGreaterThan(0.9);
    expect(earthLitFraction(dirOf(322, 0), earth)).toBeLessThan(0.05);
    expect(earthshineIntensity(0, sunBehind, earth)).toBeGreaterThan(earthshineIntensity(0, dirOf(322, 0), earth));
    expect(earthshineIntensity(1, sunBehind, earth)).toBe(0);
    expect(earthshineIntensity(0, sunBehind, dirOf(320, -4))).toBe(0);
  });
});

describe('star field and Sun clearance', () => {
  it('builds a deterministic set of unit directions above the minimum elevation', () => {
    const a = buildStarData(500);
    const b = buildStarData(500);
    expect(a.count).toBe(500);
    expect(Array.from(a.positions.slice(0, 60))).toEqual(Array.from(b.positions.slice(0, 60)));
    let bright = 0;
    for (let i = 0; i < a.count; i++) {
      const x = a.positions[i * 3];
      const y = a.positions[i * 3 + 1];
      const z = a.positions[i * 3 + 2];
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
      expect(y).toBeGreaterThan(Math.sin(-15 * DEG));
      if (a.attrs[i * 3] > 0.7) bright++;
    }
    // Mostly faint stars.
    expect(bright).toBeLessThan(a.count * 0.2);
    expect(bright).toBeGreaterThan(0);
  });

  it('measures how much of the Sun disc clears the terrain skyline', () => {
    // A ridge 100 m away, 5 m above the eye: its crest stands at atan(5/100) ≈ 2.86°.
    const ridge = (x: number, _z: number) => (x > 100 && x < 140 ? 6.7 : 0);
    const skyline = skylineElevation(ridge, 0, 1.7, 0, 1, 0);
    expect(skyline / DEG).toBeGreaterThan(2.3);
    expect(skyline / DEG).toBeLessThan(2.9);
    // Looking the other way the plain is at the horizon (just below the eye level).
    const flat = skylineElevation(ridge, 0, 1.7, 0, -1, 0);
    expect(flat / DEG).toBeLessThan(0);
    expect(flat / DEG).toBeGreaterThan(-0.1);
    const r = 0.35 * DEG;
    expect(discVisibleFraction(10 * DEG, r, skyline)).toBe(1);
    expect(discVisibleFraction(1 * DEG, r, skyline)).toBe(0);
    const half = discVisibleFraction(skyline, r, skyline);
    expect(half).toBeCloseTo(0.5, 6);

    // The sky finds the ground's height function through the scene graph.
    const scene = new THREE.Scene();
    expect(findGroundHeight(scene)).toBeNull();
    const ground = new THREE.Object3D();
    ground.name = GROUND_OBJECT_NAME;
    scene.add(ground);
    expect(findGroundHeight(scene)).toBeNull();
    registerGroundHeight(ground, ridge);
    expect(findGroundHeight(scene)).toBe(ridge);
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
