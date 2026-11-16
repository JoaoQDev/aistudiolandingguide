import * as THREE from 'three';

/**
 * Subtle star field for the lunar night: a procedural point field (illustrative — not a star
 * catalogue) with a denser band across the sky. It follows the camera, is depth-tested (terrain,
 * props and the Earth hide it), does not twinkle (no atmosphere) and is switched off entirely in
 * daylight, where the eye and the camera are dazzled by the sunlit ground.
 * The field turns about the vertical with the Sun's azimuth, as the sky does at the pole.
 */

export const STAR_COUNT = 2200;
export const STAR_COUNT_LOW = 800;
/** Stars are generated down to this elevation (deg) so walking up a knoll never shows an empty rim. */
const MIN_ELEVATION_DEG = -14;
/** Pole of the dense band (unit vector, arbitrary but fixed). */
const BAND_POLE: [number, number, number] = [0.42, 0.52, 0.744];
const BAND_HALF_WIDTH = 0.3; // in sin(latitude from the band)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StarData {
  /** Unit directions (x, y, z per star). */
  positions: Float32Array;
  /** Per star: display brightness 0..1, point diameter in reference px, colour temperature 0 (warm) … 1 (blue). */
  attrs: Float32Array;
  count: number;
}

/** Deterministic star directions and magnitudes. Exported for tests. */
export function buildStarData(count: number, seed = 20261115): StarData {
  const rand = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const attrs = new Float32Array(count * 3);
  const minY = Math.sin((MIN_ELEVATION_DEG * Math.PI) / 180);
  const poleLen = Math.hypot(BAND_POLE[0], BAND_POLE[1], BAND_POLE[2]);
  let n = 0;
  let guard = 0;
  while (n < count && guard++ < count * 60) {
    // Uniform on the sphere above the minimum elevation.
    const y = minY + (1 - minY) * rand();
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const x = r * Math.cos(phi);
    const z = r * Math.sin(phi);
    // Denser toward the band's great circle.
    const lat = (x * BAND_POLE[0] + y * BAND_POLE[1] + z * BAND_POLE[2]) / poleLen;
    const band = Math.exp(-(lat * lat) / (BAND_HALF_WIDTH * BAND_HALF_WIDTH));
    if (rand() > 0.3 + 0.7 * band) continue;
    positions[n * 3] = x;
    positions[n * 3 + 1] = y;
    positions[n * 3 + 2] = z;
    // Many faint stars, a few bright ones.
    const m = rand();
    const mag = m * m * m;
    attrs[n * 3] = 0.2 + 0.8 * mag;
    attrs[n * 3 + 1] = 1.25 + 1.6 * mag;
    attrs[n * 3 + 2] = rand();
    n++;
  }
  return { positions: positions.subarray(0, n * 3), attrs: attrs.subarray(0, n * 3), count: n };
}

const vertexShader = /* glsl */ `
  attribute vec3 aStar;
  uniform float uDist;
  uniform float uPixelScale;
  uniform float uGain;
  varying vec3 vColor;
  void main() {
    // Direction only: the stars are at infinity and follow the camera.
    vec3 dirW = mat3( modelMatrix ) * position;
    vec4 clip = projectionMatrix * vec4( mat3( viewMatrix ) * dirW * uDist, 1.0 );
    gl_Position = clip;
    float size = aStar.y * uPixelScale;
    gl_PointSize = max( size, 1.0 );
    // Points smaller than a pixel keep their energy by getting dimmer instead.
    float coverage = min( 1.0, size * size );
    vec3 tint = mix( vec3( 1.0, 0.9, 0.78 ), vec3( 0.8, 0.88, 1.0 ), aStar.z );
    vColor = tint * ( aStar.x * uGain * coverage );
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = 1.0 - smoothstep( 0.35, 1.0, length( p ) );
    // Display values straight to the sRGB canvas (no tone mapping), additive like the Sun sprite.
    gl_FragColor = vec4( vColor * a, 1.0 );
  }
`;

export interface StarField {
  points: THREE.Points;
  /** 0 = hidden (daylight, not drawn) … 1 = full night. */
  setGain(gain: number): void;
  /** Turns the field about the vertical (radians, clockwise from North seen from above). */
  setAzimuth(azRad: number): void;
  /** `viewportHeightPx` = drawing-buffer height, so stars keep their size on any screen. */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void;
  dispose(): void;
}

export function createStarField(lowPower: boolean): StarField {
  const data = buildStarData(lowPower ? STAR_COUNT_LOW : STAR_COUNT);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('aStar', new THREE.BufferAttribute(data.attrs, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uDist: { value: 5000 },
      uPixelScale: { value: 1 },
      uGain: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'stars';
  points.frustumCulled = false;
  points.visible = false;
  // Behind the Sun sprite and every other transparent object.
  points.renderOrder = -20;

  return {
    points,
    setGain(gain) {
      const g = THREE.MathUtils.clamp(gain, 0, 1);
      material.uniforms.uGain.value = g;
      points.visible = g > 0.002;
    },
    setAzimuth(azRad) {
      points.rotation.y = -azRad;
    },
    update(camera, viewportHeightPx) {
      material.uniforms.uDist.value = camera.far * 0.985;
      // Reference: 940 px tall viewport (as the Sun sprite); never below one device pixel.
      material.uniforms.uPixelScale.value = Math.max(0.75, viewportHeightPx / 940);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
