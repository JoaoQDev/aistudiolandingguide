import * as THREE from 'three';
import {
  angularSeparationDeg,
  BodySubPoints,
  moonMeToGlobeLocal,
  shortestAngleDeltaDeg,
  stepSubPointToward,
  subPointGapDeg,
  SubPoint,
  subPointToMoonMeUnit,
} from './orbitEphemeris';
import {
  ORBIT_EARTH_DISTANCE,
  ORBIT_EARTH_RADIUS,
  ORBIT_SUN_CORE_RADIUS,
  ORBIT_SUN_GLOW_RADIUS,
  sunDistanceForSeparation,
} from './orbitScreen';

/**
 * The Sun and the Earth of the Orbit 3D globe.
 *
 * Both are placed along their exact Moon-fixed directions for the current epoch (see
 * orbitEphemeris.ts) but at illustrative distances and sizes: they are not to scale. The Earth is
 * procedural artwork (no real geography) lit by the same Sun direction as the Moon, so its phase is
 * consistent with the terminator on the globe.
 *
 * The group is meant to be added to the globe's own group, i.e. positions are in the globe-local
 * frame of `latLonToSphereUnit`.
 */

// --- small deterministic value noise on the sphere (seamless, needs no canvas) ---
function latticeHash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smoothNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => latticeHash(xi + dx, yi + dy, zi + dz, seed);
  return mix(
    mix(mix(c(0, 0, 0), c(1, 0, 0), ux), mix(c(0, 1, 0), c(1, 1, 0), ux), uy),
    mix(mix(c(0, 0, 1), c(1, 0, 1), ux), mix(c(0, 1, 1), c(1, 1, 1), ux), uy),
    uz,
  );
}

function fractalNoise(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * smoothNoise(x * freq, y * freq, z * freq, seed + i * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

/**
 * Equirectangular RGBA8 (sRGB) Earth-like map: oceans, green/tan land, polar ice and cloud bands.
 * Procedural and illustrative (not real geography). Deterministic.
 */
export function buildOrbitEarthPixels(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const lat = ((row + 0.5) / height - 0.5) * Math.PI;
    const cosLat = Math.cos(lat);
    const sy = Math.sin(lat);
    const absLat = Math.abs(lat);
    for (let col = 0; col < width; col++) {
      const lon = ((col + 0.5) / width) * Math.PI * 2;
      const sx = cosLat * Math.cos(lon);
      const sz = cosLat * Math.sin(lon);

      const continents = fractalNoise(sx * 1.45 + 7.3, sy * 1.45 - 2.1, sz * 1.45 + 4.6, 503, 5);
      const arid = fractalNoise(sx * 3.1 - 1.2, sy * 3.1 + 5.4, sz * 3.1 + 9.9, 71, 3);
      const cloud = fractalNoise(sx * 2.6 + 13.7, sy * 4.6 - 6.2, sz * 2.6 - 3.3, 947, 5);

      // Ocean, lighter on the shelves next to land.
      let r = 10;
      let g = 46;
      let b = 108;
      const shore = continents - 0.535;
      if (shore > 0) {
        const t = Math.min(1, Math.max(0, (arid - 0.4) * 3.2));
        r = 52 + (158 - 52) * t;
        g = 98 + (132 - 98) * t;
        b = 46 + (84 - 46) * t;
      } else if (shore > -0.028) {
        r = 24;
        g = 84;
        b = 138;
      }
      // Polar ice with a ragged edge (a perfect white circle looks artificial from above the pole).
      const iceEdge = 1.16 + (arid - 0.5) * 0.5 + (continents - 0.5) * 0.35;
      const ice = Math.min(1, Math.max(0, (absLat - iceEdge) * 9)) * 0.94;
      r += (236 - r) * ice;
      g += (242 - g) * ice;
      b += (248 - b) * ice;

      const band = 0.84 + 0.28 * Math.cos(absLat * 3.3);
      const cover = Math.min(0.9, Math.max(0, (cloud * band - 0.47) * 3.6));
      r += (248 - r) * cover;
      g += (250 - g) * cover;
      b += (253 - b) * cover;

      const i = (row * width + col) * 4;
      data[i] = Math.round(r);
      data[i + 1] = Math.round(g);
      data[i + 2] = Math.round(b);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Brightness of the Sun sprite at a normalised radius (0 = centre, 1 = edge of the glow quad):
 * a saturated disc, a tight corona and a wide faint halo that reaches zero at the quad edge.
 */
export function sunGlowProfile(t: number): number {
  const core = ORBIT_SUN_CORE_RADIUS / ORBIT_SUN_GLOW_RADIUS;
  if (t <= core) return 1;
  if (t >= 1) return 0;
  const d = t - core;
  const corona = 0.7 * Math.exp(-d / 0.06);
  const halo = 0.3 * Math.pow(1 - d / (1 - core), 2.4);
  return Math.min(1, corona + halo);
}

/** RGBA8 sprite: colour in RGB, brightness in alpha (drawn with additive blending). */
export function buildSunGlowPixels(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  const core = ORBIT_SUN_CORE_RADIUS / ORBIT_SUN_GLOW_RADIUS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      // Anti-aliased disc edge: average the profile over about one texel.
      const e = 0.75 / half;
      const p = (sunGlowProfile(t - e) + 2 * sunGlowProfile(t) + sunGlowProfile(t + e)) / 4;
      // White-hot disc, warmer toward the outer halo.
      const warm = Math.min(1, Math.max(0, (t - core) / 0.5));
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(250 - 46 * warm);
      data[i + 2] = Math.round(236 - 112 * warm);
      data[i + 3] = Math.round(255 * p);
    }
  }
  return data;
}

const earthVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const earthFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDirW;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(vViewDirW);
    vec3 albedo = texture2D(uMap, vUv).rgb;
    float ndl = dot(n, uSunDirW);
    // Day side with a soft terminator; the night side keeps a faint fill so the disc stays readable.
    float day = smoothstep(-0.1, 0.2, ndl);
    vec3 col = albedo * (day * (0.3 + 1.25 * max(ndl, 0.0)) + 0.035);
    // Sun glint on the oceans (the darkest, bluest texels).
    float ocean = smoothstep(0.06, 0.0, albedo.g - albedo.b * 0.55);
    vec3 h = normalize(uSunDirW + v);
    col += ocean * pow(max(dot(n, h), 0.0), 48.0) * 0.4 * step(0.0, ndl);
    // Thin atmosphere on the sunlit limb.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6);
    col += vec3(0.22, 0.46, 1.0) * rim * smoothstep(-0.2, 0.3, ndl) * 0.7;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface OrbitBodies {
  /** Add this to the globe group. */
  readonly group: THREE.Group;
  /** Eased unit directions in the globe-local frame. */
  readonly sunDirLocal: THREE.Vector3;
  readonly earthDirLocal: THREE.Vector3;
  /** Eased positions of the drawn bodies in the globe-local frame. */
  readonly sunPosLocal: THREE.Vector3;
  readonly earthPosLocal: THREE.Vector3;
  /** Eased sub-points (what is currently drawn). */
  current(): BodySubPoints;
  /** Sets where the bodies should go. `snap` jumps there without easing. */
  setTarget(target: BodySubPoints, earthSpinDeg: number, snap: boolean): void;
  /** Advances the easing by `dtSeconds`. Returns true while the bodies are still moving. */
  step(dtSeconds: number): boolean;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const EASE_RATE_PER_S = 7;
const SETTLE_DEG = 0.004;
/** Illustrative axial tilt of the drawn Earth, degrees. */
const EARTH_TILT_DEG = 23.4;

export function createOrbitBodies(options: { lowPower: boolean }): OrbitBodies {
  const { lowPower } = options;
  const group = new THREE.Group();
  group.name = 'orbit-bodies';

  // --- Sun: camera-facing disc with a soft additive glow ---
  const sunSize = lowPower ? 128 : 256;
  const sunTexture = new THREE.DataTexture(buildSunGlowPixels(sunSize), sunSize, sunSize, THREE.RGBAFormat);
  sunTexture.colorSpace = THREE.SRGBColorSpace;
  sunTexture.magFilter = THREE.LinearFilter;
  sunTexture.minFilter = THREE.LinearMipmapLinearFilter;
  sunTexture.generateMipmaps = true;
  sunTexture.needsUpdate = true;
  const sunMaterial = new THREE.SpriteMaterial({
    map: sunTexture,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    fog: false,
  });
  const sun = new THREE.Sprite(sunMaterial);
  sun.name = 'orbit-sun';
  sun.scale.setScalar(ORBIT_SUN_GLOW_RADIUS * 2);
  sun.renderOrder = 3;
  group.add(sun);

  // --- Earth: small procedural sphere lit by the Sun direction ---
  const earthW = lowPower ? 128 : 256;
  const earthH = earthW / 2;
  const earthTexture = new THREE.DataTexture(
    buildOrbitEarthPixels(earthW, earthH),
    earthW,
    earthH,
    THREE.RGBAFormat,
  );
  earthTexture.colorSpace = THREE.SRGBColorSpace;
  earthTexture.wrapS = THREE.RepeatWrapping;
  earthTexture.wrapT = THREE.ClampToEdgeWrapping;
  earthTexture.magFilter = THREE.LinearFilter;
  earthTexture.minFilter = THREE.LinearMipmapLinearFilter;
  earthTexture.generateMipmaps = true;
  earthTexture.needsUpdate = true;
  const earthGeometry = new THREE.SphereGeometry(ORBIT_EARTH_RADIUS, lowPower ? 24 : 48, lowPower ? 16 : 32);
  const earthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: earthTexture },
      uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: earthVertexShader,
    fragmentShader: earthFragmentShader,
    toneMapped: false,
    fog: false,
  });
  const earth = new THREE.Mesh(earthGeometry, earthMaterial);
  earth.name = 'orbit-earth';
  earth.castShadow = false;
  earth.receiveShadow = false;
  group.add(earth);

  const sunDirLocal = new THREE.Vector3(1, 0, 0);
  const earthDirLocal = new THREE.Vector3(-1, 0, 0);
  const sunPosLocal = new THREE.Vector3();
  const earthPosLocal = new THREE.Vector3();

  let cur: BodySubPoints = { sun: { latDeg: 0, lonEastDeg: 90 }, earth: { latDeg: 0, lonEastDeg: 0 } };
  let tgt: BodySubPoints = cur;
  let curSpinDeg = 0;
  let tgtSpinDeg = 0;
  let needsApply = true;

  const tiltQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    (EARTH_TILT_DEG * Math.PI) / 180,
  );
  const spinQuat = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const worldQuat = new THREE.Quaternion();

  const dirFromSubPoint = (p: SubPoint, out: THREE.Vector3) => {
    const local = moonMeToGlobeLocal(subPointToMoonMeUnit(p.latDeg, p.lonEastDeg));
    return out.set(local.x, local.y, local.z);
  };

  const apply = () => {
    dirFromSubPoint(cur.sun, sunDirLocal);
    dirFromSubPoint(cur.earth, earthDirLocal);
    const separation = angularSeparationDeg(
      subPointToMoonMeUnit(cur.sun.latDeg, cur.sun.lonEastDeg),
      subPointToMoonMeUnit(cur.earth.latDeg, cur.earth.lonEastDeg),
    );
    sunPosLocal.copy(sunDirLocal).multiplyScalar(sunDistanceForSeparation(separation));
    earthPosLocal.copy(earthDirLocal).multiplyScalar(ORBIT_EARTH_DISTANCE);
    sun.position.copy(sunPosLocal);
    earth.position.copy(earthPosLocal);

    spinQuat.setFromAxisAngle(yAxis, (curSpinDeg * Math.PI) / 180);
    earth.quaternion.copy(tiltQuat).multiply(spinQuat);

    // Sunlight is parallel: light the Earth with the Sun *direction*, not with the vector between
    // the two illustrative positions, so its phase is the real one.
    group.getWorldQuaternion(worldQuat);
    (earthMaterial.uniforms.uSunDirW.value as THREE.Vector3).copy(sunDirLocal).applyQuaternion(worldQuat).normalize();
    needsApply = false;
  };

  return {
    group,
    sunDirLocal,
    earthDirLocal,
    sunPosLocal,
    earthPosLocal,
    current: () => cur,
    setTarget(target, earthSpinDeg, snap) {
      tgt = target;
      tgtSpinDeg = earthSpinDeg;
      if (snap) {
        cur = { sun: { ...target.sun }, earth: { ...target.earth } };
        curSpinDeg = earthSpinDeg;
        needsApply = true;
      }
    },
    step(dtSeconds) {
      const gap = Math.max(subPointGapDeg(cur.sun, tgt.sun), subPointGapDeg(cur.earth, tgt.earth));
      const spinGap = shortestAngleDeltaDeg(curSpinDeg, tgtSpinDeg);
      const moving = gap > SETTLE_DEG || Math.abs(spinGap) > 0.2;
      if (moving) {
        const alpha = 1 - Math.exp(-Math.max(0, dtSeconds) * EASE_RATE_PER_S);
        cur = {
          sun: stepSubPointToward(cur.sun, tgt.sun, alpha),
          earth: stepSubPointToward(cur.earth, tgt.earth, alpha),
        };
        curSpinDeg += spinGap * alpha;
        needsApply = true;
      } else if (gap > 0 || spinGap !== 0) {
        cur = { sun: { ...tgt.sun }, earth: { ...tgt.earth } };
        curSpinDeg = tgtSpinDeg;
        needsApply = true;
      }
      if (needsApply) apply();
      return moving;
    },
    setVisible(visible) {
      group.visible = visible;
    },
    dispose() {
      sunTexture.dispose();
      sunMaterial.dispose();
      earthTexture.dispose();
      earthGeometry.dispose();
      earthMaterial.dispose();
    },
  };
}
