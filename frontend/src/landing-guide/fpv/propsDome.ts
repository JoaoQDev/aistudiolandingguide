import * as THREE from 'three';
import { colorize, makeRng, mergeAll } from './propsGeometry';

/**
 * Greenhouse (t21/t30): a clear glass hemisphere with a bright fresnel rim, filled with dark
 * green vegetation, standing on a raised platform (the crate ring around it is placed by
 * props.ts with the shared crate meshes). Local origin: ground centre; the dome base sits at
 * `baseY`.
 */

export interface Greenhouse {
  object: THREE.Group;
  glass: THREE.ShaderMaterial;
  setSunDirection(dir: THREE.Vector3): void;
  dispose(): void;
}

const GLASS_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GLASS_FRAG = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uSun;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float f = pow(1.0 - ndv, 1.7);
  float rim = smoothstep(0.62, 0.97, 1.0 - ndv);
  vec3 sunH = normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-4);
  float sunSide = 0.12 + 0.88 * smoothstep(-0.25, 0.75, dot(normalize(vec3(N.x, 0.0, N.z) + 1e-4), sunH));
  vec3 R = reflect(-V, N);
  float spec = pow(max(dot(R, uSun), 0.0), 80.0) * 4.0;
  float sky = 0.04 * (N.y * 0.5 + 0.5);
  vec3 col = uTint * (0.06 + sky) + vec3(1.0) * (f * 0.5 + rim * 2.6) * sunSide + vec3(spec);
  float a = clamp(0.04 + f * 0.25 + rim * 0.85 * sunSide + spec * 0.5, 0.0, 0.95);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createGreenhouse(radius: number, baseY: number, lowPower: boolean, seed: number): Greenhouse {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  // platform + soil
  const platformGeo = mergeAll(
    [
      colorize(new THREE.CylinderGeometry(radius + 0.05, radius + 0.2, baseY + 1.0, 40, 1).translate(0, (baseY - 1.0) / 2, 0), 0x3b3c40),
      colorize(new THREE.CylinderGeometry(radius - 0.05, radius - 0.05, 0.12, 40, 1).translate(0, baseY + 0.06, 0), 0x2a2618),
      colorize(new THREE.TorusGeometry(radius + 0.02, 0.09, 6, 64).rotateX(Math.PI / 2).translate(0, baseY + 0.08, 0), 0xc4c4c8),
    ],
    { uv: false, color: true },
  );
  const platformMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1 });
  const platform = new THREE.Mesh(platformGeo, platformMat);
  platform.castShadow = !lowPower;
  platform.receiveShadow = !lowPower;
  group.add(platform);
  disposables.push(platformGeo, platformMat);

  // vegetation: many small dark flat-shaded leaf clusters filling the dome, plus tiny bright
  // "sunlit leaf tip" specks that give the sparkly canopy seen through the glass (t12, t21)
  const rand = makeRng(seed ^ 0x51ed);
  const area = Math.min(4, (radius / 4.6) ** 2);
  const count = Math.round((lowPower ? 260 : 900) * area);
  const leafGeo = new THREE.IcosahedronGeometry(1, 0);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x030602, roughness: 0.85, metalness: 0, flatShading: true });
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, count);
  const greens = [0x0a1408, 0x0e1a0b, 0x13220e, 0x182a12, 0x1e3416, 0x2a4019, 0x44521f, 0x5e6226];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  /** Random point inside the dome, biased toward the canopy (upper part / glass). */
  const canopyPoint = (out: THREE.Vector3, shell: number) => {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const elev = Math.asin(Math.pow(Math.abs(u), 0.7));
    const r = radius * (shell + (1 - shell) * Math.pow(rand(), 0.5)) * 0.9;
    out.set(Math.cos(th) * Math.cos(elev) * r, baseY + Math.sin(elev) * r, Math.sin(th) * Math.cos(elev) * r);
    return out;
  };
  for (let i = 0; i < count; i++) {
    canopyPoint(p, i < count * 0.6 ? 0.55 : 0.1);
    const size = (0.25 + rand() * 0.55) * Math.max(0.8, radius / 5.5);
    p.y = Math.max(p.y, baseY + size * 0.5);
    e.set(rand() * 3, rand() * 3, rand() * 3);
    q.setFromEuler(e);
    s.set(size * (0.8 + rand() * 0.5), size * (0.6 + rand() * 0.5), size * (0.8 + rand() * 0.5));
    m.compose(p, q, s);
    leaves.setMatrixAt(i, m);
    const high = (p.y - baseY) / radius;
    c.setHex(greens[Math.min(greens.length - 1, Math.floor(rand() * (high > 0.5 ? 8 : 5)))]);
    leaves.setColorAt(i, c);
  }
  leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  leaves.computeBoundingSphere();
  leaves.castShadow = false;
  leaves.receiveShadow = !lowPower;
  group.add(leaves);
  disposables.push(leafGeo, leafMat);

  const speckCount = Math.round((lowPower ? 400 : 1500) * area);
  const speckGeo = new THREE.OctahedronGeometry(1, 0);
  const speckMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const specks = new THREE.InstancedMesh(speckGeo, speckMat, speckCount);
  const speckColors = [0xc2bd78, 0xdedaa0, 0xa3a866, 0xf0ecc8, 0x8a9450];
  for (let i = 0; i < speckCount; i++) {
    const th = rand() * Math.PI * 2;
    const elev = Math.asin(Math.pow(rand(), 0.55));
    const r = radius * (0.84 + 0.1 * rand());
    p.set(Math.cos(th) * Math.cos(elev) * r, baseY + Math.sin(elev) * r, Math.sin(th) * Math.cos(elev) * r);
    const size = 0.035 + rand() * 0.06;
    e.set(rand() * 3, rand() * 3, rand() * 3);
    q.setFromEuler(e);
    s.set(size * (1 + rand()), size, size * (1 + rand()));
    m.compose(p, q, s);
    specks.setMatrixAt(i, m);
    c.setHex(speckColors[Math.floor(rand() * speckColors.length)]).multiplyScalar(0.55 + 0.45 * rand());
    specks.setColorAt(i, c);
  }
  specks.instanceMatrix.needsUpdate = true;
  if (specks.instanceColor) specks.instanceColor.needsUpdate = true;
  specks.computeBoundingSphere();
  group.add(specks);
  disposables.push(speckGeo, speckMat);
  // a few trunks
  const trunkGeo = mergeAll(
    Array.from({ length: lowPower ? 6 : 14 }, () => {
      const rr = radius * 0.6 * Math.sqrt(rand());
      const th = rand() * Math.PI * 2;
      const h = 0.8 + rand() * (radius * 0.5);
      return colorize(new THREE.CylinderGeometry(0.06, 0.12, h, 6).translate(Math.cos(th) * rr, baseY + h / 2, Math.sin(th) * rr), 0x3a2f20);
    }),
    { uv: false, color: true },
  );
  const trunks = new THREE.Mesh(trunkGeo, platformMat);
  group.add(trunks);
  disposables.push(trunkGeo);

  // glass shell
  const glassGeo = new THREE.SphereGeometry(radius, lowPower ? 32 : 56, lowPower ? 12 : 20, 0, Math.PI * 2, 0, Math.PI / 2);
  glassGeo.translate(0, baseY, 0);
  const glass = new THREE.ShaderMaterial({
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    uniforms: {
      uTint: { value: new THREE.Color(0x9fb4bc) },
      uSun: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const shell = new THREE.Mesh(glassGeo, glass);
  shell.renderOrder = 2;
  group.add(shell);
  disposables.push(glassGeo, glass);

  return {
    object: group,
    glass,
    setSunDirection(dir) {
      (glass.uniforms.uSun.value as THREE.Vector3).copy(dir).normalize();
    },
    dispose() {
      for (const d of disposables) d.dispose();
      leaves.dispose();
      specks.dispose();
    },
  };
}
