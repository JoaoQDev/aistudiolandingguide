import * as THREE from 'three';
import { CRATE_SPECS, crateGeometry } from './propsCrates';
import { createContactShadows, type ContactFootprint } from './propsDecalShadows';
import { createGreenhouse } from './propsDome';
import { groundFrame, makeRng, yawForAzimuth } from './propsGeometry';
import {
  GREENHOUSE_CENTER,
  GREENHOUSE_RADIUS,
  MOONBASE_SPAWN,
  polar,
  SHIP_AXIS_AZ,
  SHIP_CENTER,
  shipLocal,
  SUNWARD_CRATES,
  SUNWARD_LONE_CRATE,
  SUNWARD_TANKS,
  T41_VIEW,
} from './propsLayout';
import { ROVER_BEACON, ROVER_BEACON_RADIUS, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, roverGeometry } from './propsRover';
import { buildShipGeometry, SHIP_HALF_WIDTH, SHIP_LENGTH } from './propsShip';
import { shipHullMaps } from './propsShipTextures';
import { TANK_PAINT, TANK_RADIUS, tankGeometry } from './propsTanks';
import { createCrateMaterial } from './propsKitPaint';
import { tankDetailMap, type CrateStyle } from './propsTextures';
import type { CircleCollider, FrameContext, PropsModule, PropsOptions } from './types';

export { MOONBASE_SPAWN, T41_VIEW } from './propsLayout';

/**
 * Procedural moonbase seen in the reference walk: landed ship with tanks and white hazard
 * containers along its sunlit flank, a rover and a row of dark crates near the start, a backlit
 * tank/crate group toward the Sun, a second container row + tank group with a rover, and a large
 * greenhouse dome far beyond the sunward crest. Everything is generated in code (geometry + canvas
 * textures) and drawn with a handful of merged / instanced meshes; soft contact darkening is one
 * extra draped mesh. Positions live in propsLayout.ts.
 */

const DEG = Math.PI / 180;

type CrateItem = [dx: number, dz: number, level: number, dyawDeg: number];

interface CrateGroup {
  style: CrateStyle;
  x: number;
  z: number;
  yawDeg: number;
  items: CrateItem[];
  tilt?: number;
  /** Extra height under level 0 (stacking on another family's crates). */
  baseLift?: number;
}

interface TankGroup {
  x: number;
  z: number;
  yawDeg: number;
  items: [dx: number, dz: number][];
}

const lidT = (style: CrateStyle) => CRATE_SPECS[style].lid?.t ?? 0;
const crateLift = (style: CrateStyle) => CRATE_SPECS[style].h + lidT(style) + 0.005;

export function createMoonbase(opts: PropsOptions): PropsModule {
  const { heightAt, lowPower } = opts;
  const rand = makeRng((opts.seed ^ 0x6d6f6f6e) >>> 0);
  const group = new THREE.Group();
  group.name = 'moonbase';
  const disposables: { dispose(): void }[] = [];
  const colliders: CircleCollider[] = [];
  const contacts: ContactFootprint[] = [];
  const shadows = !lowPower;

  // ------------------------------------------------------------------ ship
  const shipYaw = yawForAzimuth(SHIP_AXIS_AZ);
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
  const shipBase = hSum / hN - 0.12;
  const ship = buildShipGeometry(shipBase - hMin + 0.8);
  const hullMaps = shipHullMaps(lowPower, 0x5a17);
  const hullMat = new THREE.MeshStandardMaterial({
    color: hullMaps ? 0xb0a9b2 : 0xaaa3ac,
    map: hullMaps?.map ?? null,
    bumpMap: hullMaps?.bump ?? null,
    bumpScale: 1.2,
    vertexColors: true,
    roughness: 0.78,
    metalness: 0.04,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x4a464b, roughness: 0.7, metalness: 0.08 });
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x4e4a54, roughness: 0.85, metalness: 0.04 });
  const shipHull = new THREE.Mesh(ship.hull, hullMat);
  const shipDark = new THREE.Mesh(ship.dark, darkMat);
  const shipShade = new THREE.Mesh(ship.shade, shadeMat);
  shipHull.name = 'ship-hull';
  for (const m of [shipHull, shipDark, shipShade]) {
    m.position.set(SHIP_CENTER.x, shipBase, SHIP_CENTER.z);
    m.rotation.y = shipYaw;
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    group.add(m);
  }
  disposables.push(ship.hull, ship.dark, ship.shade, hullMat, darkMat, shadeMat);
  if (hullMaps) disposables.push(hullMaps.map, hullMaps.bump);
  for (const c of ship.colliders) {
    const p = shipLocal(c.x, c.z);
    colliders.push({ x: p.x, z: p.z, radius: c.r });
  }
  for (const f of ship.footprint) {
    const p = shipLocal((f.x0 + f.x1) / 2, 0);
    contacts.push({ x: p.x, z: p.z, yawDeg: SHIP_AXIS_AZ, halfX: (f.x1 - f.x0) / 2, halfZ: f.hw, strength: 0.7, spread: 1.6, corner: 0.6 });
  }

  // ------------------------------------------------------------------ crates
  const crateMatrices: Record<CrateStyle, THREE.Matrix4[]> = { hazard: [], row: [], dark: [] };
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();

  /** Places a crate group; returns the world matrices of its crates (in item order). */
  const addCrateGroup = (g: CrateGroup): THREE.Matrix4[] => {
    const spec = CRATE_SPECS[g.style];
    const lift = crateLift(g.style);
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
    const out: THREE.Matrix4[] = [];
    for (const [dx, dz, level, dyaw] of g.items) {
      rot.makeRotationY(dyaw * DEG);
      tmp.makeTranslation(dx, (g.baseLift ?? 0) + level * lift, dz).multiply(rot);
      const m = frame.clone().multiply(tmp);
      crateMatrices[g.style].push(m);
      out.push(m);
      if (level === 0 && !g.baseLift) {
        const x = g.x + dx * cos + dz * sin;
        const z = g.z - dx * sin + dz * cos;
        colliders.push({ x, z, radius: Math.hypot(spec.w, spec.d) * 0.46 });
        contacts.push({ x, z, yawDeg: g.yawDeg - dyaw, halfX: spec.w / 2, halfZ: spec.d / 2, strength: 0.6, spread: 0.75, corner: 0.12 });
      }
    }
    return out;
  };

  // tanks
  const tankMatrices: THREE.Matrix4[] = [];
  const addTank = (x: number, z: number, yawDeg: number) => {
    const m = groundFrame({ heightAt, x, z, yawDeg, halfX: TANK_RADIUS, halfZ: TANK_RADIUS, maxTilt: 0, sink: 0.05 });
    tankMatrices.push(m);
    colliders.push({ x, z, radius: TANK_RADIUS + 0.2 });
    contacts.push({ x, z, yawDeg: 0, halfX: TANK_RADIUS + 0.04, halfZ: TANK_RADIUS + 0.04, corner: TANK_RADIUS + 0.04, strength: 0.62, spread: 0.55 });
  };
  const addTankGroup = (g: TankGroup) => {
    const cos = Math.cos(yawForAzimuth(g.yawDeg));
    const sin = Math.sin(yawForAzimuth(g.yawDeg));
    for (const [dx, dz] of g.items) addTank(g.x + dx * cos + dz * sin, g.z - dx * sin + dz * cos, g.yawDeg + rand() * 360);
  };
  const tankOnCrate = (crate: THREE.Matrix4, style: CrateStyle, dx: number) => {
    tankMatrices.push(crate.clone().multiply(new THREE.Matrix4().makeTranslation(dx, CRATE_SPECS[style].h + lidT(style), 0)));
  };

  // (A) white hazard containers at the foot of the ship's head, sunlit side (t01, t05): two columns
  // of containers end to end pointing away from the flank, white ends toward the spawn/Sun, their
  // long faces in shade.
  {
    const a = shipLocal(-10.4, 6.7);
    addCrateGroup({
      style: 'hazard',
      x: a.x,
      z: a.z,
      yawDeg: SHIP_AXIS_AZ + 90,
      items: [[-1.2, -0.68, 0, 0], [1.2, -0.68, 0, 180], [-1.2, 0.68, 0, 180], [1.2, 0.7, 0, 0], [1.15, -0.66, 1, 2]],
    });
  }
  // (B) tanks + white hazard containers beside the ship's mid flank (t15–t18.5)
  {
    const t = shipLocal(-3.6, 8.9);
    addTankGroup({ x: t.x, z: t.z, yawDeg: SHIP_AXIS_AZ, items: [[-0.6, 0.45], [0.6, 0.5], [-0.25, -0.62], [0.95, -0.6]] });
    const c = shipLocal(0.4, 8.9);
    const crates = addCrateGroup({ style: 'hazard', x: c.x, z: c.z, yawDeg: SHIP_AXIS_AZ + 2, items: [[-1.2, 0.08, 0, 0], [1.22, -0.1, 0, 180]] });
    tankOnCrate(crates[1], 'hazard', -0.6);
  }
  // (C) white modular containers stacked off the ship's rear quarter (t15/t17 right side)
  {
    const p = shipLocal(3.0, 15.0);
    addCrateGroup({ style: 'row', x: p.x, z: p.z, yawDeg: SHIP_AXIS_AZ + 8, items: [[-1.25, 0, 0, 0], [1.25, 0.1, 0, 180], [1.3, -1.2, 0, 0], [0.7, -0.55, 1, 2]] });
  }
  // (D) dark crate row in front-left of the spawn (t01)
  {
    const p = polar(9, 14.8);
    addCrateGroup({ style: 'dark', x: p.x, z: p.z, yawDeg: 99, items: [[-3.8, 0, 0, 0], [-1.3, 0, 0, 180], [1.25, 0.05, 0, 0], [-3.15, 0, 1, 1], [-0.65, 0.02, 1, 179]] });
  }
  // (E) second white container row + tank cluster around the t41.5 viewpoint: rover centre-left,
  // a short row receding to the right toward its tanks, a dark crate with a free top close by (t47).
  {
    const v = T41_VIEW;
    const L = polar(v.yawDeg + 13, 12.0, v.x, v.z);
    const R = polar(v.yawDeg + 31, 15.5, v.x, v.z);
    const rowAz = (Math.atan2(R.x - L.x, -(R.z - L.z)) * 180) / Math.PI;
    const span = Math.hypot(R.x - L.x, R.z - L.z);
    const along = (t: number) => polar(rowAz, t, L.x, L.z);
    const c = along(span * 0.5);
    addCrateGroup({ style: 'row', x: c.x, z: c.z, yawDeg: rowAz, tilt: 0.14, items: [[-2.46, 0, 0, 0], [0, 0, 0, 180], [2.46, 0, 0, 0]] });
    const t = along(span * 0.5 + 4.6);
    addTankGroup({ x: t.x, z: t.z, yawDeg: rowAz, items: [[-0.55, 0.55], [0.55, 0.55], [-0.55, -0.55], [0.55, -0.55]] });
    // single dark crate close on the right, its long striped face toward the viewpoint (t41.5, t43)
    const d = polar(v.yawDeg + 50, 3.7, v.x, v.z);
    addCrateGroup({ style: 'dark', x: d.x, z: d.z, yawDeg: v.yawDeg - 12, items: [[0, 0, 0, 0]] });
  }
  // (F) backlit group toward the Sun (t08, t12, t21, t30): row modules + dark crate on top, tank pair beyond
  {
    const c = SUNWARD_CRATES;
    addCrateGroup({ style: 'row', x: c.x, z: c.z, yawDeg: 3.7, items: [[-1.25, 0, 0, 0], [1.25, 0, 0, 180], [1.45, -1.2, 0, 0]] });
    addCrateGroup({ style: 'dark', x: c.x, z: c.z, yawDeg: 3.7, baseLift: crateLift('row') - 0.06, items: [[-0.1, -0.2, 0, 2]] });
    addTankGroup({ x: SUNWARD_TANKS.x, z: SUNWARD_TANKS.z, yawDeg: 164, items: [[-0.52, 0], [0.52, 0.06]] });
  }

  // (H) lone dark crate with a free top just beyond the backlit group (t47 foreground); hidden behind
  // it from the t08/t12 viewpoints and read as part of it from t21/t30.
  addCrateGroup({ style: 'dark', x: SUNWARD_LONE_CRATE.x, z: SUNWARD_LONE_CRATE.z, yawDeg: 196, items: [[0, 0, 0, 0]] });

  // (G) greenhouse far beyond the sunward crest (t08, t12, t21, t30, t37–t47)
  const R = GREENHOUSE_RADIUS;
  let domeGround = Infinity;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    domeGround = Math.min(domeGround, heightAt(GREENHOUSE_CENTER.x + Math.cos(a) * R, GREENHOUSE_CENTER.z + Math.sin(a) * R));
  }
  domeGround = Math.min(domeGround, heightAt(GREENHOUSE_CENTER.x, GREENHOUSE_CENTER.z)) - 0.3;
  const greenhouse = createGreenhouse(R, 1.6, lowPower, opts.seed);
  greenhouse.object.position.set(GREENHOUSE_CENTER.x, domeGround, GREENHOUSE_CENTER.z);
  group.add(greenhouse.object);
  disposables.push(greenhouse);
  colliders.push({ x: GREENHOUSE_CENTER.x, z: GREENHOUSE_CENTER.z, radius: R + 2 });
  contacts.push({ x: GREENHOUSE_CENTER.x, z: GREENHOUSE_CENTER.z, yawDeg: 0, halfX: R + 1.5, halfZ: R + 1.5, corner: R + 1.5, strength: 0.55, spread: 4 });
  {
    // backlit dome shadow falling toward the base (dark patch in front of the dome, t12)
    const s = polar(72, R * 0.95, GREENHOUSE_CENTER.x, GREENHOUSE_CENTER.z);
    contacts.push({ x: s.x, z: s.z, yawDeg: 72, halfX: R * 0.8, halfZ: R * 0.55, corner: R * 0.5, strength: 0.7, spread: 6 });
  }

  // ------------------------------------------------------------------ instanced meshes
  const tint = new THREE.Color();
  for (const style of ['hazard', 'row', 'dark'] as CrateStyle[]) {
    const mats = crateMatrices[style];
    if (!mats.length) continue;
    const geo = crateGeometry(CRATE_SPECS[style]);
    const { material: mat, textures } = createCrateMaterial(style, lowPower, 0xc0ffee + style.length * 7919);
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
    disposables.push(geo, mat, mesh, ...textures);
  }

  {
    const geo = tankGeometry(lowPower);
    const map = tankDetailMap(lowPower, 0x7a2c);
    // a little darker than the kit's TANK_PAINT so the lit side reads ≈ 140 like the reference
    const mat = new THREE.MeshStandardMaterial({ color: 0xaaa5ae, map, roughness: TANK_PAINT.roughness + 0.06, metalness: TANK_PAINT.metalness });
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
    // rover 1: ~20 m ahead-left of the spawn, ~10 m from the white containers at the ship's head (t01, t05)
    { ...polar(23.5, 20), yawDeg: 114 },
    // rover 2: centre-left of the t41.5 view
    { ...polar(T41_VIEW.yawDeg - 8, 16, T41_VIEW.x, T41_VIEW.z), yawDeg: T41_VIEW.yawDeg + 8 },
  ];
  const roverGeo = roverGeometry(lowPower);
  const roverMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.18 });
  const rovers = new THREE.InstancedMesh(roverGeo, roverMat, roverPoses.length);
  const beaconGeo = new THREE.SphereGeometry(ROVER_BEACON_RADIUS, 8, 6);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff7a2a });
  const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, roverPoses.length);
  roverPoses.forEach((r, i) => {
    const m = groundFrame({ heightAt, x: r.x, z: r.z, yawDeg: r.yawDeg, halfX: ROVER_HALF_LENGTH * 0.85, halfZ: ROVER_HALF_WIDTH * 0.85, maxTilt: 0.2, sink: 0.04 });
    rovers.setMatrixAt(i, m);
    beacons.setMatrixAt(i, m.clone().multiply(new THREE.Matrix4().makeTranslation(ROVER_BEACON.x, ROVER_BEACON.y, ROVER_BEACON.z)));
    colliders.push({ x: r.x, z: r.z, radius: Math.hypot(ROVER_HALF_LENGTH, ROVER_HALF_WIDTH) * 0.85 });
    contacts.push({ x: r.x, z: r.z, yawDeg: r.yawDeg, halfX: ROVER_HALF_LENGTH * 0.8, halfZ: ROVER_HALF_WIDTH * 0.8, strength: 0.42, spread: 0.6, corner: 0.4 });
  });
  rovers.instanceMatrix.needsUpdate = true;
  beacons.instanceMatrix.needsUpdate = true;
  rovers.computeBoundingSphere();
  beacons.computeBoundingSphere();
  rovers.castShadow = shadows;
  rovers.receiveShadow = shadows;
  group.add(rovers, beacons);
  disposables.push(roverGeo, roverMat, rovers, beaconGeo, beaconMat, beacons);

  // ------------------------------------------------------------------ contact darkening
  const contactShadows = createContactShadows(heightAt, contacts, lowPower);
  group.add(contactShadows.mesh);
  disposables.push(contactShadows);

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
    // greenhouse glass / canopy follow the scene's sun light (found lazily)
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
