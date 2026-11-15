import * as THREE from 'three';
import { createHeightField } from './terrainHeight';
import { applyRegolithShader, type RegolithScale, type RegolithUniforms } from './terrainShader';
import { generateRegolithTexture } from './terrainTexture';
import type { GroundModule, GroundOptions } from './types';

/**
 * Lunar ground for the first-person walk: nested LOD rings reaching ~6 km (dense around the
 * walk area), gentle undulation, sparse soft craters, far rolling hills, and a procedural
 * regolith material with multi-scale detail and a sunward forward-scatter sheen.
 * Purely illustrative scenery.
 */

const SCALES: RegolithScale[] = [
  { tile: 1.15, angle: 0.37, offset: [0.13, 0.71], slope: 0.5, cavity: 0.35, albedo: 0.12, fade: [18, 45] },
  { tile: 6.3, angle: 1.91, offset: [0.57, 0.29], slope: 0.5, cavity: 0.75, albedo: 0.25, fade: [120, 320] },
  { tile: 37, angle: 4.13, offset: [0.83, 0.41], slope: 0.3, cavity: 0.55, albedo: 0.4, fade: [900, 2400] },
  { tile: 230, angle: 2.71, offset: [0.21, 0.93], slope: 0.12, cavity: 0.3, albedo: 0.6, fade: null },
];

const REGOLITH_SRGB: [number, number, number] = [158, 153, 158];

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
    uDiffuseGain: { value: 1.12 },
    uPhotK: { value: 0.35 },
    uSheenLobe: { value: 0.5 },
    uSheenColumn: { value: 2.3 },
    uFill: { value: 0.09 },
    uShadeTint: { value: new THREE.Color(0.98, 0.96, 1.04) },
    uAmbientGain: { value: 1.0 },
  };
  const scales = opts.lowPower ? SCALES.slice(1) : SCALES;
  applyRegolithShader(mat, uniforms, { scales }, opts.lowPower ? 'lunar-regolith-low-v1' : 'lunar-regolith-v1');

  const ground = new THREE.Mesh(geo, mat);
  ground.name = 'lunar-ground';
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.frustumCulled = false;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();

  return {
    object: ground,
    heightAt: field.heightAt,
    setSunDirection(dir: THREE.Vector3) {
      uniforms.uSunDirW.value.copy(dir).normalize();
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      detail.dispose();
    },
  };
}
