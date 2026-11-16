import * as THREE from 'three';
import { EasedDirection, EasedScalar, EasedSun } from './skyEase';
import { createEarth } from './skyEarth';
import { createLunarEnvironment, type LunarEnvironment } from './skyEnv';
import {
  createEarthshineLight,
  createHelmetLamp,
  earthshineIntensity,
  groundBounce,
  nightFactor,
  NIGHT_HEMI_GROUND,
  NIGHT_HEMI_SKY,
  shadowFade,
  starGain,
  sunGlowGain,
} from './skyNight';
import { createStarField } from './skyStars';
import { createSunSprite, SUN_CORE_RADIUS_RAD } from './skySun';
import { discVisibleFraction, findGroundHeight, skylineElevation, type HeightFn } from './terrainSkyline';
import { EYE_HEIGHT_M, type FrameContext, type SkyModule, type SkyOptions } from './types';

/**
 * Sky & lighting for the first-person lunar walk.
 *
 * Lighting convention (other modules may rely on it):
 * - Renderer: Khronos PBR Neutral tone mapping at exposure SKY_EXPOSURE (0.88). Between ~0.09 and
 *   ~0.9 linear the output is `0.88 · input − 0.04`; below that the toe goes quadratic
 *   (≈ 6.25 · x²), which is what makes shadowed faces fall steeply toward black.
 * - Sun: DirectionalLight with intensity SUN_INTENSITY = π at full illumination, i.e. a white
 *   Lambertian surface facing the Sun receives linear 1.0 before exposure (three.js diffuse =
 *   albedo · intensity · cosθ / π). Screen value of a sunlit matte face ≈ sRGB( 0.88 · albedoLinear · cosθ − 0.04 ).
 * - Fill: PMREM environment (black sky, sunlit regolith below the horizon) at ENV_INTENSITY plus a
 *   weak hemisphere light. Calibrated so faces turned away from the Sun land at sRGB ≈ 15–35
 *   (dark but not black), like the reference frames; there is no local bounce between props.
 * - Sky: pure black. Sun = constant-angular-size disc + halo sprite. Earth = small sphere at its
 *   dataset direction.
 *
 * Mission conditions (see missionSky.ts): the Sun and the Earth arrive at their real azimuth and
 * a drawn elevation of −9°…+12° / +24°, plus the fraction `f` of the solar disc above the real
 * terrain horizon. Every Sun-driven term (light, shadows, environment, hemisphere fill, disc and
 * halo) scales with `f`; the daylight look was tuned at 10° and is unchanged at and above it.
 * At f = 0 it is night at the site: no sunlight at all, and the night look of skyNight.ts takes
 * over (helmet lamp, earthshine when the Earth is up, dim ambient, stars). Directions and `f`
 * are eased in `update` (skyEase.ts) so time playback looks continuous.
 * The lighting is illustrative; nothing here is a measurement.
 */

export const SKY_TONE_MAPPING = THREE.NeutralToneMapping;
/** Tone-mapping exposure. 0.88 brings sunlit regolith and prop flanks to the reference levels. */
export const SKY_EXPOSURE = 0.88;
/** Sun DirectionalLight intensity: π ⇒ unit irradiance on a surface facing the Sun. */
export const SUN_INTENSITY = Math.PI;
/**
 * Strength of the regolith-bounce environment (diffuse + specular) on PBR materials. The ground's
 * own shader barely sees it (its normals face the black sky); it mostly fills shadowed prop faces.
 */
export const ENV_INTENSITY = 0.4;

// Shadow volume (metres). The box follows the camera, is pushed forward along the view, and is
// snapped to shadow-map texels so shadows do not swim. Light-space width is SHADOW_HALF_WIDTH
// across the Sun azimuth; along it the ground footprint is ±SHADOW_HALF_DEPTH. The light-space
// height is derived from the Sun elevation so a low Sun does not waste resolution.
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_HALF_WIDTH = 150;
export const SHADOW_HALF_DEPTH = 170;
const SHADOW_FORWARD_OFFSET = 55;
const SHADOW_MAX_CASTER_HEIGHT = 18;
const SHADOW_RELIEF_MARGIN = 6;
const SHADOW_LIGHT_DISTANCE = 450;

export function configureRenderer(renderer: THREE.WebGLRenderer, lowPower: boolean): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = SKY_TONE_MAPPING;
  renderer.toneMappingExposure = SKY_EXPOSURE;
  renderer.shadowMap.enabled = !lowPower;
  // PCF with a Vogel-disk kernel (PCFSoft was removed in r18x); radius is set on the light.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 1);
}

export interface ShadowBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Orthographic shadow-camera bounds for a given Sun direction. Light-space +Y is "camera up":
 * ground toward the Sun maps to −Y and tall casters to +Y, so the box is asymmetric.
 */
export function computeShadowBounds(sunDir: THREE.Vector3, out: ShadowBounds = { left: 0, right: 0, top: 0, bottom: 0 }): ShadowBounds {
  const sinEl = THREE.MathUtils.clamp(sunDir.y, 0.02, 1);
  const cosEl = Math.sqrt(Math.max(0, 1 - sinEl * sinEl));
  const groundY = SHADOW_HALF_DEPTH * sinEl;
  out.left = -SHADOW_HALF_WIDTH;
  out.right = SHADOW_HALF_WIDTH;
  out.bottom = -(groundY + SHADOW_RELIEF_MARGIN * cosEl + 1);
  out.top = groundY + SHADOW_MAX_CASTER_HEIGHT * cosEl + SHADOW_RELIEF_MARGIN * cosEl;
  return out;
}

const _up = new THREE.Vector3(0, 1, 0);
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();

/** Same basis as `Object3D.lookAt` gives the shadow camera (z = toward the Sun). */
export function lightBasis(sunDir: THREE.Vector3, outX: THREE.Vector3, outY: THREE.Vector3): void {
  outX.crossVectors(_up, sunDir);
  if (outX.lengthSq() < 1e-8) outX.set(1, 0, 0);
  outX.normalize();
  outY.crossVectors(sunDir, outX).normalize();
}

/** Moves `center` (in place) so its light-space X/Y fall exactly on shadow-map texel corners. */
export function snapToShadowTexels(center: THREE.Vector3, sunDir: THREE.Vector3, texelX: number, texelY: number): THREE.Vector3 {
  lightBasis(sunDir, _bx, _by);
  const u = center.dot(_bx);
  const v = center.dot(_by);
  const du = Math.round(u / texelX) * texelX - u;
  const dv = Math.round(v / texelY) * texelY - v;
  return center.addScaledVector(_bx, du).addScaledVector(_by, dv);
}

export function createLunarSky(opts: SkyOptions): SkyModule {
  const { scene, lowPower, renderer } = opts;
  scene.background = new THREE.Color(0x000000);
  const group = new THREE.Group();
  group.name = 'lunar-sky';

  // --- Sun light + camera-following shadows ---
  const sunLight = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
  sunLight.name = 'sun';
  sunLight.castShadow = !lowPower;
  if (!lowPower) {
    const shadow = sunLight.shadow;
    shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    shadow.camera.near = 1;
    shadow.camera.far = SHADOW_LIGHT_DISTANCE + SHADOW_HALF_DEPTH + 250;
    shadow.bias = -0.00004;
    shadow.normalBias = 0.09;
    shadow.radius = 0.5; // small Vogel kernel: crisp edges, no IGN stipple in tight penumbrae
  }
  group.add(sunLight);
  group.add(sunLight.target);

  // --- Fill: environment (regolith bounce) or, in lowPower, an equivalent hemisphere light ---
  let env: LunarEnvironment | null = null;
  if (!lowPower) {
    env = createLunarEnvironment(renderer);
    if (env) {
      scene.environment = env.texture;
      scene.environmentIntensity = ENV_INTENSITY;
    }
  }
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  hemi.name = 'fill';
  // Daylight: weak neutral light from above (scatter stand-in) so upward shadowed ground is not 0;
  // without an environment the hemisphere light carries the regolith bounce instead.
  const daySky: readonly [number, number, number] = [0.1, 0.1, 0.1];
  const dayGround: readonly [number, number, number] = env ? [0.03, 0.03, 0.03] : [0.49, 0.475, 0.475];
  group.add(hemi);

  // --- Night: helmet lamp, earthshine, stars (all exactly off in daylight) ---
  const lamp = createHelmetLamp();
  group.add(lamp.light);
  group.add(lamp.light.target);
  const earthshine = createEarthshineLight();
  group.add(earthshine);
  group.add(earthshine.target);
  const stars = createStarField(lowPower);
  group.add(stars.points);

  // --- Sun disc/halo and Earth ---
  const sun = createSunSprite();
  group.add(sun.mesh);
  const earth = createEarth(lowPower);
  group.add(earth.mesh);

  // Eased mission state. The ground eases its own copy identically (same calls, same dt).
  const sunState = new EasedSun(new THREE.Vector3(0, 0.17, -1));
  const earthDir = new EasedDirection(new THREE.Vector3(0.5, -0.3, -1));
  const sunDir = sunState.direction;
  // Share of the Sun's disc clear of the illustrative terrain (1 until a ground is found).
  const sunClear = new EasedScalar(1, 0.12);
  let heightAt: HeightFn | null = null;
  let heightLookups = 0;
  let skylineValid = false;
  let skylineAge = 0;
  /** Camera position (x, y, z) and Sun azimuth (w) of the last skyline scan. */
  const skylineAt = new THREE.Vector4();

  const bounds = computeShadowBounds(sunDir);
  const center = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const bufferSize = new THREE.Vector2(1, 940);

  const applyShadowBounds = () => {
    if (!sunLight.castShadow) return;
    computeShadowBounds(sunDir, bounds);
    const cam = sunLight.shadow.camera;
    cam.left = bounds.left;
    cam.right = bounds.right;
    cam.top = bounds.top;
    cam.bottom = bounds.bottom;
    cam.updateProjectionMatrix();
  };

  /** Pushes the eased state into every light, sprite and fill. Cheap; runs every frame. */
  const applyLighting = () => {
    const f = sunState.illumination;
    const night = nightFactor(f);
    const bounce = f * groundBounce(sunDir.y);

    sunLight.intensity = SUN_INTENSITY * f;
    if (sunLight.castShadow) {
      const k = shadowFade(sunDir.y);
      sunLight.shadow.intensity = k;
      // No Sun, no shadow pass (the light stays in the scene so no material recompiles).
      sunLight.shadow.autoUpdate = f > 0 && k > 0;
    }
    applyShadowBounds();
    sunLight.position.copy(sunLight.target.position).addScaledVector(sunDir, SHADOW_LIGHT_DISTANCE);

    if (env) scene.environmentIntensity = ENV_INTENSITY * bounce;
    hemi.color.setRGB(
      daySky[0] * bounce + NIGHT_HEMI_SKY[0] * night,
      daySky[1] * bounce + NIGHT_HEMI_SKY[1] * night,
      daySky[2] * bounce + NIGHT_HEMI_SKY[2] * night,
    );
    hemi.groundColor.setRGB(
      dayGround[0] * bounce + NIGHT_HEMI_GROUND[0] * night,
      dayGround[1] * bounce + NIGHT_HEMI_GROUND[1] * night,
      dayGround[2] * bounce + NIGHT_HEMI_GROUND[2] * night,
    );

    lamp.setGain(night);
    earthshine.intensity = earthshineIntensity(f, sunDir, earthDir.value);
    earthshine.position.copy(earthDir.value);
    stars.setGain(starGain(f));
    stars.setAzimuth(Math.atan2(sunDir.x, -sunDir.z));

    const glow = sunGlowGain(f);
    sun.setGain(glow, glow * sunClear.value);
    sun.setDirection(sunDir);
    earth.setSunDirection(sunDir);
    earth.setDirection(earthDir.value);
  };
  applyLighting();

  /** Refreshes the share of the Sun's disc above the terrain skyline (throttled: ~100 height lookups). */
  const updateSunClearance = (dt: number) => {
    if (!heightAt && heightLookups < 20) {
      heightLookups++;
      heightAt = findGroundHeight(scene);
    }
    if (!heightAt || sunState.illumination <= 0) {
      sunClear.set(1, true);
      skylineValid = false;
      return;
    }
    skylineAge += dt;
    const az = Math.atan2(sunDir.x, -sunDir.z);
    const moved =
      Math.abs(camPos.x - skylineAt.x) + Math.abs(camPos.z - skylineAt.z) > 0.4 ||
      Math.abs(camPos.y - skylineAt.y) > 0.04 ||
      Math.abs(az - skylineAt.w) > 0.003;
    if (!skylineValid || moved || skylineAge > 0.5) {
      skylineAt.set(camPos.x, camPos.y, camPos.z, az);
      skylineAge = 0;
      const h = Math.hypot(sunDir.x, sunDir.z) || 1;
      const skyline = skylineElevation(heightAt, camPos.x, camPos.y, camPos.z, sunDir.x / h, sunDir.z / h);
      const elevation = Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1));
      // Snap the first value (and after a night), ease the rest so the halo never pops.
      sunClear.set(discVisibleFraction(elevation, SUN_CORE_RADIUS_RAD, skyline), !skylineValid);
      skylineValid = true;
    }
    sunClear.step(dt);
  };

  return {
    object: group,
    sunLight,
    setSunDirection(dir) {
      sunState.setDirection(dir);
      applyLighting();
    },
    setEarthDirection(dir) {
      earthDir.set(dir);
      applyLighting();
    },
    setSunIllumination(fraction) {
      sunState.setIllumination(fraction);
      applyLighting();
    },
    update(frame: FrameContext) {
      const camera = frame.camera;
      sunState.step(frame.dt);
      earthDir.step(frame.dt);

      // Shadow box centre: ground under the player, pushed forward along the view direction.
      camera.getWorldPosition(camPos);
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() > 1e-6) forward.normalize();
      center.copy(camPos);
      center.y -= EYE_HEIGHT_M;
      center.addScaledVector(forward, SHADOW_FORWARD_OFFSET);
      if (sunLight.castShadow) {
        computeShadowBounds(sunDir, bounds);
        const texelX = (bounds.right - bounds.left) / SHADOW_MAP_SIZE;
        const texelY = (bounds.top - bounds.bottom) / SHADOW_MAP_SIZE;
        snapToShadowTexels(center, sunDir, texelX, texelY);
      }
      sunLight.target.position.copy(center);

      updateSunClearance(frame.dt);
      applyLighting();
      sunLight.target.updateMatrixWorld();
      sunLight.updateMatrixWorld();

      lamp.update(camera);
      sun.update(camera);
      earth.update(camera);
      if (stars.points.visible) {
        if (typeof renderer.getDrawingBufferSize === 'function') renderer.getDrawingBufferSize(bufferSize);
        stars.update(camera, bufferSize.y);
      }
    },
    dispose() {
      sun.dispose();
      earth.dispose();
      stars.dispose();
      lamp.dispose();
      earthshine.dispose();
      sunLight.dispose();
      hemi.dispose();
      if (env) {
        if (scene.environment === env.texture) scene.environment = null;
        env.dispose();
      }
    },
  };
}
