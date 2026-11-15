import * as THREE from 'three';
import { CRATE_SPECS, crateGeometry } from './propsCrates';
import { createGreenhouse } from './propsDome';
import { groundFrame, makeRng, yawForAzimuth } from './propsGeometry';
import { ROVER_BEACON, ROVER_BEACON_RADIUS, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, roverGeometry } from './propsRover';
import { buildShipGeometry, SHIP_HALF_WIDTH, SHIP_LENGTH } from './propsShip';
import { TANK_RADIUS, tankGeometry } from './propsTanks';
import { crateAtlas, hullPanelMaps, tankDetailMap, type CrateStyle } from './propsTextures';
import type { CircleCollider, FrameContext, PropsModule, PropsOptions, SpawnPose } from './types';

/**
 * Procedural moonbase seen in the reference walk: landed ship with tanks and white hazard
 * containers, a rover and a row of dark crates near the start, a second container row + tank
 * group, a backlit tank/crate group toward the Sun and a greenhouse dome on a crate ring far
 * off. Everything is generated in code (geometry + canvas textures) and drawn with a handful of
 * merged / instanced meshes.
 *
 * Layout is authored for the illustrative Sun at azimuth ≈ 252° (WSW), elevation 10°: the
 * spawn faces ENE with the Sun behind-left so the ship's flank and the containers are lit.
 */

const DEG = Math.PI / 180;

/** Horizontal point at `bearingDeg` (clockwise from North/-Z) and `dist` metres from (ox, oz). */
function polar(bearingDeg: number, dist: number, ox = 0, oz = 0): { x: number; z: number } {
  return { x: ox + Math.sin(bearingDeg * DEG) * dist, z: oz - Math.cos(bearingDeg * DEG) * dist };
}

export const MOONBASE_SPAWN: SpawnPose = { x: 0, z: 0, yawDeg: 50, pitchDeg: -4 };

// Ship placement (hero): centre ~64 m ahead-right of the spawn, long axis (nose → tail) toward
// azimuth 148°, so its +Z flank faces the spawn and the Sun.
const SHIP_CENTER = polar(54, 58);
const SHIP_AXIS_AZ = 128;

/** Viewpoint the second container row is composed around (reproduces t41.5). */
export const T41_VIEW: SpawnPose = { x: 70, z: -70, yawDeg: 42, pitchDeg: -3 };
/** Viewpoint facing the Sun (t12): backlit tank pair + container stack, greenhouse dome beyond. */
export const T12_VIEW: SpawnPose = { x: 6, z: -4, yawDeg: 262, pitchDeg: -2 };

// Greenhouse far off roughly toward the illustrative Sun (azimuth ≈ 252°), so it sits in the glare (t21, t30).
const GREENHOUSE_CENTER = polar(248, 118);
const GREENHOUSE_RADIUS = 6.6;

type CrateItem = [dx: number, dz: number, level: number, dyawDeg: number];

interface CrateGroup {
  style: CrateStyle;
  x: number;
  z: number;
  yawDeg: number;
  items: CrateItem[];
  tilt?: number;
}

interface TankGroup {
  x: number;
  z: number;
  yawDeg: number;
  items: [dx: number, dz: number][];
}

export function createMoonbase(opts: PropsOptions): PropsModule {
  const { heightAt, lowPower } = opts;
  const rand = makeRng((opts.seed ^ 0x6d6f6f6e) >>> 0);
  const group = new THREE.Group();
  group.name = 'moonbase';
  const disposables: { dispose(): void }[] = [];
  const colliders: CircleCollider[] = [];
  const shadows = !lowPower;

  // ------------------------------------------------------------------ ship (local → world)
  const shipYaw = yawForAzimuth(SHIP_AXIS_AZ);
  const axis = new THREE.Vector3(Math.cos(shipYaw), 0, -Math.sin(shipYaw));
  const flank = new THREE.Vector3(Math.sin(shipYaw), 0, Math.cos(shipYaw));
  const shipLocal = (lx: number, lz: number) => ({
    x: SHIP_CENTER.x + axis.x * lx + flank.x * lz,
    z: SHIP_CENTER.z + axis.z * lx + flank.z * lz,
  });

  let hSum = 0;
  let hMin = Infinity;
  let hN = 0;
  for (let i = 0; i <= 12; i++)
    for (let j = 0; j <= 4; j++) {
      const p = shipLocal(-SHIP_LENGTH / 2 + (SHIP_LENGTH * i) / 12, -SHIP_HALF_WIDTH + (2 * SHIP_HALF_WIDTH * j) / 4);
      const h = heightAt(p.x, p.z);
      hSum += h;
      hMin = Math.min(hMin, h);
      hN++;
    }
  const shipBase = hSum / hN - 0.15;
  const ship = buildShipGeometry(shipBase - hMin + 1.0);
  const panelMaps = hullPanelMaps(lowPower, 0x5a17);
  const hullMat = new THREE.MeshStandardMaterial({
    color: panelMaps ? 0xc6c5d1 : 0xb9b8c4,
    map: panelMaps?.map ?? null,
    bumpMap: panelMaps?.bump ?? null,
    bumpScale: 1.6,
    roughness: 0.74,
    metalness: 0.08,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1c21, roughness: 0.32, metalness: 0.55 });
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x4a4952, roughness: 0.85, metalness: 0.05 });
  const shipHull = new THREE.Mesh(ship.hull, hullMat);
  const shipDark = new THREE.Mesh(ship.dark, darkMat);
  const shipShade = new THREE.Mesh(ship.shade, shadeMat);
  for (const m of [shipHull, shipDark, shipShade]) {
    m.position.set(SHIP_CENTER.x, shipBase, SHIP_CENTER.z);
    m.rotation.y = shipYaw;
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    group.add(m);
  }
  disposables.push(ship.hull, ship.dark, ship.shade, hullMat, darkMat, shadeMat);
  if (panelMaps) disposables.push(panelMaps.map, panelMaps.bump);
  for (const c of ship.colliders) {
    const p = shipLocal(c.x, c.z);
    colliders.push({ x: p.x, z: p.z, radius: c.r });
  }

  // ------------------------------------------------------------------ crates
  const crateMatrices: Record<CrateStyle, THREE.Matrix4[]> = { hazard: [], row: [], dark: [] };
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();

  const addCrateGroup = (g: CrateGroup) => {
    const spec = CRATE_SPECS[g.style];
    const lift = spec.h + (spec.lid?.t ?? 0) + 0.005;
    let halfX = 0;
    let halfZ = 0;
    for (const [dx, dz, level] of g.items)
      if (level === 0) {
        halfX = Math.max(halfX, Math.abs(dx) + spec.w / 2);
        halfZ = Math.max(halfZ, Math.abs(dz) + spec.d / 2);
      }
    const frame = groundFrame({ heightAt, x: g.x, z: g.z, yawDeg: g.yawDeg, halfX, halfZ, maxTilt: g.tilt ?? 0.08, sink: 0.06, nx: Math.ceil(halfX / 1.2) });
    const cos = Math.cos(yawForAzimuth(g.yawDeg));
    const sin = Math.sin(yawForAzimuth(g.yawDeg));
    for (const [dx, dz, level, dyaw] of g.items) {
      rot.makeRotationY(dyaw * DEG);
      tmp.makeTranslation(dx, level * lift, dz).multiply(rot);
      crateMatrices[g.style].push(frame.clone().multiply(tmp));
      if (level === 0) {
        colliders.push({ x: g.x + dx * cos + dz * sin, z: g.z - dx * sin + dz * cos, radius: Math.hypot(spec.w, spec.d) * 0.46 });
      }
    }
  };

  // tanks
  const tankMatrices: THREE.Matrix4[] = [];
  const addTank = (x: number, z: number, yawDeg: number, onTopOf?: THREE.Matrix4) => {
    if (onTopOf) {
      tankMatrices.push(onTopOf);
      return;
    }
    const m = groundFrame({ heightAt, x, z, yawDeg, halfX: TANK_RADIUS, halfZ: TANK_RADIUS, maxTilt: 0, sink: 0.06 });
    tankMatrices.push(m);
    colliders.push({ x, z, radius: TANK_RADIUS + 0.2 });
  };
  const addTankGroup = (g: TankGroup) => {
    const cos = Math.cos(yawForAzimuth(g.yawDeg));
    const sin = Math.sin(yawForAzimuth(g.yawDeg));
    for (const [dx, dz] of g.items) addTank(g.x + dx * cos + dz * sin, g.z - dx * sin + dz * cos, g.yawDeg + rand() * 360);
  };

  // (A) white hazard containers at the foot of the ship's head (t01, t05)
  {
    const p1 = shipLocal(-14.2, 8.6);
    addCrateGroup({ style: 'hazard', x: p1.x, z: p1.z, yawDeg: SHIP_AXIS_AZ + 2, items: [[-1.35, 0, 0, 0], [1.35, 0, 0, 180], [0.3, 0.05, 1, 4]] });
    const p2 = shipLocal(-9.6, 9.4);
    addCrateGroup({ style: 'hazard', x: p2.x, z: p2.z, yawDeg: SHIP_AXIS_AZ - 6, items: [[0, 0, 0, 0], [-0.2, -0.04, 1, -3]] });
  }
  // (B) tanks + white hazard containers beside the ship's mid/rear flank (t15–t18.5)
  {
    const t = shipLocal(6.3, 8.4);
    addTankGroup({ x: t.x, z: t.z, yawDeg: SHIP_AXIS_AZ, items: [[-0.7, 0.7], [0.7, 0.74], [-0.45, -0.66], [0.95, -0.6]] });
    const c = shipLocal(10.6, 8.3);
    const items: CrateItem[] = [[-1.37, 0.1, 0, 0], [1.37, -0.12, 0, 180]];
    addCrateGroup({ style: 'hazard', x: c.x, z: c.z, yawDeg: SHIP_AXIS_AZ + 1, items });
    // tank standing on the right-hand container
    const crates = crateMatrices.hazard;
    const base = crates[crates.length - 1];
    const spec = CRATE_SPECS.hazard;
    tankMatrices.push(base.clone().multiply(new THREE.Matrix4().makeTranslation(-0.72, spec.h + (spec.lid?.t ?? 0), 0)));
  }
  // (C) white modular containers stacked near the tail (t15/t17 right side)
  {
    const p = shipLocal(18.5, 17.5);
    addCrateGroup({ style: 'row', x: p.x, z: p.z, yawDeg: SHIP_AXIS_AZ + 8, items: [[-1.3, 0, 0, 0], [1.3, 0.1, 0, 180], [1.32, -1.3, 0, 0], [0.9, -0.55, 1, 2]] });
  }
  // (D) dark crate row in front-left of the spawn (t01)
  {
    const p = polar(9, 14.8);
    addCrateGroup({
      style: 'dark',
      x: p.x,
      z: p.z,
      yawDeg: 99,
      items: [[-3.95, 0, 0, 0], [-1.32, 0, 0, 180], [1.32, 0.05, 0, 0], [-3.3, 0, 1, 1], [-0.66, 0.02, 1, 179]],
    });
  }
  // (E) second white container row + tank cluster, composed around the t41.5 viewpoint: rover
  // centre-left, a short row receding to the right toward its tanks, a dark crate close by.
  {
    const v = T41_VIEW;
    const L = polar(v.yawDeg + 12, 14.5, v.x, v.z);
    const R = polar(v.yawDeg + 32, 19.5, v.x, v.z);
    const rowAz = (Math.atan2(R.x - L.x, -(R.z - L.z)) * 180) / Math.PI;
    const span = Math.hypot(R.x - L.x, R.z - L.z);
    const along = (t: number) => polar(rowAz, t, L.x, L.z);
    const c = along(span * 0.5);
    addCrateGroup({ style: 'row', x: c.x, z: c.z, yawDeg: rowAz, tilt: 0.14, items: [[-2.56, 0, 0, 0], [0, 0, 0, 180], [2.56, 0, 0, 0]] });
    const t = along(span * 0.5 + 5.6);
    addTankGroup({ x: t.x, z: t.z, yawDeg: rowAz, items: [[-0.68, 0.68], [0.68, 0.68], [-0.68, -0.68], [0.68, -0.68]] });
    const d = polar(v.yawDeg + 50, 3.7, v.x, v.z);
    addCrateGroup({ style: 'dark', x: d.x, z: d.z, yawDeg: v.yawDeg + 78, items: [[0.6, 0, 0, 0], [3.2, 0.1, 0, 180], [3.0, 0.05, 1, 2]] });
  }
  // (F) backlit tank pair + container stack toward the Sun (t08, t12)
  {
    const v = T12_VIEW;
    const t = polar(v.yawDeg - 2, 41, v.x, v.z);
    addTankGroup({ x: t.x, z: t.z, yawDeg: v.yawDeg + 90, items: [[-0.7, 0], [0.7, 0.15]] });
    const c = polar(v.yawDeg + 7, 38, v.x, v.z);
    addCrateGroup({
      style: 'row',
      x: c.x,
      z: c.z,
      yawDeg: v.yawDeg + 95,
      items: [[-2.6, 0, 0, 0], [0, 0, 0, 180], [2.6, 0.1, 0, 0], [-1.25, 0.05, 1, 2], [1.3, 0, 1, 178], [0.4, -1.3, 0, 0]],
    });
  }

  // (G) greenhouse dome on a two-tier ring of crates, off toward the Sun (t12, t21, t30)
  const ringSpec = CRATE_SPECS.row;
  const ringLift = ringSpec.h + (ringSpec.lid?.t ?? 0) + 0.005;
  const domeBaseY = 2 * ringLift - 0.02;
  let domeGround = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r = GREENHOUSE_RADIUS + 1.2;
    domeGround = Math.min(domeGround, heightAt(GREENHOUSE_CENTER.x + Math.cos(a) * r, GREENHOUSE_CENTER.z + Math.sin(a) * r));
  }
  domeGround = Math.min(domeGround, heightAt(GREENHOUSE_CENTER.x, GREENHOUSE_CENTER.z)) - 0.08;
  const greenhouse = createGreenhouse(GREENHOUSE_RADIUS, domeBaseY, lowPower, opts.seed);
  greenhouse.object.position.set(GREENHOUSE_CENTER.x, domeGround, GREENHOUSE_CENTER.z);
  group.add(greenhouse.object);
  disposables.push(greenhouse);
  {
    const rc = GREENHOUSE_RADIUS + 0.3;
    const n = Math.floor((2 * Math.PI * rc) / (ringSpec.w + 0.16));
    for (let tier = 0; tier < 2; tier++) {
      for (let i = 0; i < n; i++) {
        const a = ((i + tier * 0.5) / n) * Math.PI * 2;
        const m = new THREE.Matrix4()
          .makeTranslation(GREENHOUSE_CENTER.x + Math.cos(a) * rc, domeGround + tier * ringLift, GREENHOUSE_CENTER.z + Math.sin(a) * rc)
          .multiply(new THREE.Matrix4().makeRotationY(-a - Math.PI / 2));
        crateMatrices.row.push(m);
      }
    }
    colliders.push({ x: GREENHOUSE_CENTER.x, z: GREENHOUSE_CENTER.z, radius: rc + 1.0 });
    // angle (x = cos, z = sin) pointing at the spawn; as seen from there, left = +90°, right = -90°
    const towardSpawn = Math.atan2(-GREENHOUSE_CENTER.z, -GREENHOUSE_CENTER.x);
    for (let k = 0; k < 3; k++) {
      const a = towardSpawn + 0.62 + k * 0.21;
      const r = rc + 1.7;
      addTank(GREENHOUSE_CENTER.x + Math.cos(a) * r, GREENHOUSE_CENTER.z + Math.sin(a) * r, rand() * 360);
    }
    // a short extra row of crates in front-right of the ring (t30)
    const ar = towardSpawn - 0.42;
    const rowAt = { x: GREENHOUSE_CENTER.x + Math.cos(ar) * (rc + 1.9), z: GREENHOUSE_CENTER.z + Math.sin(ar) * (rc + 1.9) };
    const radialAz = (Math.atan2(Math.cos(ar), -Math.sin(ar)) * 180) / Math.PI; // azimuth of (cos a, sin a)
    addCrateGroup({ style: 'row', x: rowAt.x, z: rowAt.z, yawDeg: radialAz + 90, items: [[-1.3, 0, 0, 0], [1.3, 0, 0, 180], [0, 0.05, 1, 0]] });
  }

  // ------------------------------------------------------------------ instanced meshes
  const tint = new THREE.Color();
  for (const style of ['hazard', 'row', 'dark'] as CrateStyle[]) {
    const mats = crateMatrices[style];
    if (!mats.length) continue;
    const spec = CRATE_SPECS[style];
    const geo = crateGeometry(spec);
    const map = crateAtlas(style, lowPower, 0xc0ffee + style.length * 7919);
    const mat = new THREE.MeshStandardMaterial({
      color: map ? 0xffffff : spec.fallbackColor,
      map,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      const v = 0.9 + rand() * 0.1;
      mesh.setColorAt(i, tint.setRGB(v, v, v * (0.98 + rand() * 0.02)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.name = `crates-${style}`;
    group.add(mesh);
    disposables.push(geo, mat, mesh);
    if (map) disposables.push(map);
  }

  {
    const geo = tankGeometry(lowPower);
    const map = tankDetailMap(lowPower, 0x7a2c);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc0bfca, map, roughness: 0.55, metalness: 0.18 });
    const mesh = new THREE.InstancedMesh(geo, mat, tankMatrices.length);
    tankMatrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.name = 'tanks';
    group.add(mesh);
    disposables.push(geo, mat, mesh);
    if (map) disposables.push(map);
  }

  // ------------------------------------------------------------------ rovers
  const roverPoses = [
    { ...polar(27.5, 19.5), yawDeg: 114 },
    { ...polar(T41_VIEW.yawDeg - 8, 16, T41_VIEW.x, T41_VIEW.z), yawDeg: T41_VIEW.yawDeg + 8 },
  ];
  const roverGeo = roverGeometry(lowPower);
  const roverMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.18 });
  const rovers = new THREE.InstancedMesh(roverGeo, roverMat, roverPoses.length);
  const beaconGeo = new THREE.SphereGeometry(ROVER_BEACON_RADIUS, 8, 6);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff7a2a });
  const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, roverPoses.length);
  roverPoses.forEach((r, i) => {
    const m = groundFrame({ heightAt, x: r.x, z: r.z, yawDeg: r.yawDeg, halfX: 1.05, halfZ: 0.92, maxTilt: 0.2, sink: 0.04 });
    rovers.setMatrixAt(i, m);
    beacons.setMatrixAt(i, m.clone().multiply(new THREE.Matrix4().makeTranslation(ROVER_BEACON.x, ROVER_BEACON.y, ROVER_BEACON.z)));
    colliders.push({ x: r.x, z: r.z, radius: Math.hypot(ROVER_HALF_LENGTH, ROVER_HALF_WIDTH) * 0.85 });
  });
  rovers.instanceMatrix.needsUpdate = true;
  beacons.instanceMatrix.needsUpdate = true;
  rovers.computeBoundingSphere();
  beacons.computeBoundingSphere();
  rovers.castShadow = shadows;
  rovers.receiveShadow = shadows;
  group.add(rovers, beacons);
  disposables.push(roverGeo, roverMat, rovers, beaconGeo, beaconMat, beacons);

  // ------------------------------------------------------------------ frame update
  let sunLight: THREE.DirectionalLight | null = null;
  let searched = 0;
  const sunDir = new THREE.Vector3();
  const lp = new THREE.Vector3();
  const tp = new THREE.Vector3();

  const update = (frame: FrameContext) => {
    // rover beacon: short amber blink every ~1.6 s
    const phase = (frame.elapsed % 1.6) / 1.6;
    const k = phase < 0.08 ? 1 : 0.12;
    beaconMat.color.setRGB(1.0 * k, 0.48 * k, 0.16 * k);
    // greenhouse glass highlight follows the scene's sun light (found lazily)
    if (!sunLight && searched < 3) {
      searched++;
      let root: THREE.Object3D = group;
      while (root.parent) root = root.parent;
      root.traverse((o) => {
        if (!sunLight && (o as THREE.DirectionalLight).isDirectionalLight) sunLight = o as THREE.DirectionalLight;
      });
    }
    if (sunLight) {
      const light: THREE.DirectionalLight = sunLight;
      light.getWorldPosition(lp);
      light.target.getWorldPosition(tp);
      sunDir.subVectors(lp, tp);
      if (sunDir.lengthSq() > 1e-8) greenhouse.setSunDirection(sunDir.normalize());
    }
  };

  return {
    object: group,
    colliders,
    spawn: { ...MOONBASE_SPAWN },
    update,
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}
