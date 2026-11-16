import * as THREE from 'three';
import { EasedSun } from './skyEase';
import { lowSunFactor, nightFactor, NIGHT_REGOLITH_AMBIENT, REGOLITH_PHOT_K, sunGate } from './skyNight';
import { createHeightField } from './terrainHeight';
import { applyRegolithShader, type RegolithScale, type RegolithUniforms } from './terrainShader';
import { GROUND_OBJECT_NAME, registerGroundHeight, unregisterGroundHeight } from './terrainSkyline';
import { generateRegolithTexture } from './terrainTexture';
import type { FrameContext, GroundModule, GroundOptions } from './types';

/**
 * Lunar ground for the first-person walk: nested LOD rings reaching ~6 km (dense around the
 * walk area), gentle undulation, sparse soft craters, far rolling hills, and a procedural
 * regolith material with multi-scale detail and a sunward forward-scatter sheen.
 * The Sun direction and illumination follow the mission state, eased exactly like the sky's
 * (skyEase.ts), so the shader, the light and the Sun disc always agree.
 * Purely illustrative scenery.
 */

const SCALES: RegolithScale[] = [
  { tile: 1.15, angle: 0.37, offset: [0.13, 0.71], slope: 0.62, cavity: 0.3, albedo: 0.12, fade: [8, 22] },
  { tile: 6.3, angle: 1.91, offset: [0.57, 0.29], slope: 0.65, cavity: 0.5, albedo: 0.22, fade: [40, 130], damp: [3, 16, 0.22] },
  // Coarse scale: chunky pits and clods at the feet, stronger relief toward the mid field.
  { tile: 37, angle: 4.13, offset: [0.83, 0.41], slope: 0.4, cavity: 0.35, albedo: 0.35, fade: [900, 2400], damp: [4, 24, 1.0], tintFadeIn: [3, 15] },
  { tile: 230, angle: 2.71, offset: [0.21, 0.93], slope: 0.05, cavity: 0.2, albedo: 0.5, fade: null, damp: [25, 140, 4.4], tintFadeIn: [25, 110] },
];

const REGOLITH_SRGB: [number, number, number] = [158, 153, 158];

/**
 * Received (prop) shadows on the regolith: strength near the camera, and the distances (m) over
 * which it drops to the given factor. `TUNED` is the daylight look (no long wedges across the
 * plain); `LOW_SUN` lets a Sun near the horizon throw long shadows.
 */
export const GROUND_SHADOW_TUNED = { strength: 0.32, fadeStart: 4, fadeEnd: 14, farFactor: 0.12 };
export const GROUND_SHADOW_LOW_SUN = { strength: 0.9, fadeStart: 45, fadeEnd: 240, farFactor: 0.45 };

export interface GroundShadowLook {
  strength: number;
  fadeStart: number;
  fadeEnd: number;
  farFactor: number;
}

/** Received-shadow look for a Sun at `sinEl` (sine of its drawn elevation). */
export function groundShadowLook(sinEl: number, out: GroundShadowLook = { ...GROUND_SHADOW_TUNED }): GroundShadowLook {
  const t = lowSunFactor(sinEl);
  const a = GROUND_SHADOW_TUNED;
  const b = GROUND_SHADOW_LOW_SUN;
  // Exact at both ends (t = 0 keeps the tuned numbers bit for bit).
  const mix = (x: number, y: number) => x * (1 - t) + y * t;
  out.strength = mix(a.strength, b.strength);
  out.fadeStart = mix(a.fadeStart, b.fadeStart);
  out.fadeEnd = mix(a.fadeEnd, b.fadeEnd);
  out.farFactor = mix(a.farFactor, b.farFactor);
  return out;
}

export function createLunarGround(opts: GroundOptions): GroundModule {
  const field = createHeightField(opts);
  const mesh = field.buildMesh();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geo.computeBoundingSphere();

  const texSize = opts.lowPower ? 512 : 2048;
  const seed = (Math.floor(Math.abs(opts.seed)) ^ 0x51ed) >>> 0;
  const tex = generateRegolithTexture(texSize, seed);
  const detail = new THREE.DataTexture(tex.data, tex.size, tex.size, THREE.RGBAFormat, THREE.UnsignedByteType);
  detail.wrapS = THREE.RepeatWrapping;
  detail.wrapT = THREE.RepeatWrapping;
  detail.magFilter = THREE.LinearFilter;
  detail.minFilter = THREE.LinearMipmapLinearFilter;
  detail.generateMipmaps = true;
  detail.anisotropy = 16; // clamped to the GPU maximum by three.js
  detail.colorSpace = THREE.NoColorSpace;
  detail.needsUpdate = true;

  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  mat.color.setRGB(REGOLITH_SRGB[0] / 255, REGOLITH_SRGB[1] / 255, REGOLITH_SRGB[2] / 255, THREE.SRGBColorSpace);

  const uniforms: RegolithUniforms = {
    uDetail: { value: detail },
    uSunDirW: { value: new THREE.Vector3(0, Math.sin(0.1745), -Math.cos(0.1745)) },
    uDiffuseGain: { value: 0.97 },
    uPhotK: { value: REGOLITH_PHOT_K },
    uSheenLobe: { value: 0.45 },
    uSheenFar: { value: new THREE.Vector2(0.5, 4) },
    uSheenTail: { value: new THREE.Vector2(1.0, 1.35) },
    uSheenColumn: { value: 4.6 },
    uSheenFall: { value: 1.9 },
    uSheenSharp: { value: new THREE.Vector2(26, 10) },
    uFill: { value: 0.15 },
    uShadeTint: { value: new THREE.Color(0.98, 0.96, 1.04) },
    uAmbientGain: { value: 1.0 },
    uCavityFloor: { value: 0.35 },
    uCavityEdge: { value: new THREE.Vector2(0.78, 0.95) },
    uCavityFade: { value: new THREE.Vector3(15, 40, 80) },
    uIsoK: { value: new THREE.Vector2(0.45, 0.85) },
    uShadowStrength: { value: 0.32 },
    uShadowFade: { value: new THREE.Vector3(4, 14, 0.12) },
    // Near-field fill on the valley walls' self-shadowed faces (gameplay only): gone by ~150 m,
    // so the ridge band of the valley views (≥ 160 m away) stays black.
    uWallFill: { value: new THREE.Vector3(0.095, 60, 150) },
    uSunOn: { value: 1 },
    uNightAmbient: { value: new THREE.Color(0, 0, 0) },
  };
  const scales = opts.lowPower ? SCALES.slice(1) : SCALES;
  applyRegolithShader(mat, uniforms, { scales }, opts.lowPower ? 'lunar-regolith-low-v6' : 'lunar-regolith-v6');

  const ground = new THREE.Mesh(geo, mat);
  ground.name = GROUND_OBJECT_NAME;
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.frustumCulled = false;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();

  // Lets the sky find the terrain skyline (how much of the Sun's disc the ground hides).
  registerGroundHeight(ground, field.heightAt);

  // Eased mission state: same calls and same frame dt as the sky's copy.
  const sunState = new EasedSun(uniforms.uSunDirW.value);
  const shadowLook = groundShadowLook(uniforms.uSunDirW.value.y);
  const applyLighting = () => {
    const dir = sunState.direction;
    const f = sunState.illumination;
    uniforms.uSunDirW.value.copy(dir);
    uniforms.uSunOn.value = sunGate(f);
    const night = nightFactor(f);
    uniforms.uNightAmbient.value.setRGB(
      NIGHT_REGOLITH_AMBIENT[0] * night,
      NIGHT_REGOLITH_AMBIENT[1] * night,
      NIGHT_REGOLITH_AMBIENT[2] * night,
    );
    groundShadowLook(dir.y, shadowLook);
    uniforms.uShadowStrength.value = shadowLook.strength;
    uniforms.uShadowFade.value.set(shadowLook.fadeStart, shadowLook.fadeEnd, shadowLook.farFactor);
  };
  applyLighting();

  return {
    object: ground,
    heightAt: field.heightAt,
    setSunDirection(dir: THREE.Vector3) {
      sunState.setDirection(dir);
      applyLighting();
    },
    setSunIllumination(fraction: number) {
      sunState.setIllumination(fraction);
      applyLighting();
    },
    update(frame: FrameContext) {
      if (sunState.step(frame.dt)) applyLighting();
    },
    dispose() {
      unregisterGroundHeight(ground);
      geo.dispose();
      mat.dispose();
      detail.dispose();
    },
  };
}
