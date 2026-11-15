import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createMoonbase } from './props';
import { WALK_RADIUS_M } from './types';

const rolling = (x: number, z: number) => Math.sin(x * 0.05) * 0.9 + Math.cos(z * 0.043) * 0.7 + Math.sin((x + z) * 0.11) * 0.25;

function stats(root: THREE.Object3D) {
  let drawCalls = 0;
  let triangles = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    drawCalls++;
    const g = mesh.geometry;
    const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    triangles += tris * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
  });
  return { drawCalls, triangles };
}

describe('createMoonbase', () => {
  it('spawns outside every collider, with finite colliders inside the walkable disc', () => {
    for (const heightAt of [rolling, () => 0]) {
      const base = createMoonbase({ seed: 1234, lowPower: false, heightAt });
      expect(base.colliders.length).toBeGreaterThan(20);
      for (const c of base.colliders) {
        expect(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.radius)).toBe(true);
        expect(c.radius).toBeGreaterThan(0);
        expect(Math.hypot(c.x, c.z)).toBeLessThan(WALK_RADIUS_M);
        expect(Math.hypot(base.spawn.x - c.x, base.spawn.z - c.z)).toBeGreaterThan(c.radius + 0.6);
      }
      expect(Number.isFinite(base.spawn.yawDeg) && Number.isFinite(base.spawn.pitchDeg)).toBe(true);
      base.dispose();
    }
  });

  it('stays within the props draw-call and triangle budget', () => {
    for (const lowPower of [false, true]) {
      const base = createMoonbase({ seed: 7, lowPower, heightAt: rolling });
      const { drawCalls, triangles } = stats(base.object);
      expect(drawCalls).toBeLessThanOrEqual(40);
      expect(triangles).toBeLessThan(600_000);
      base.dispose();
    }
  });

  it('rests ground-standing tanks on the terrain instead of floating', () => {
    const base = createMoonbase({ seed: 3, lowPower: false, heightAt: rolling });
    const tanks = base.object.getObjectByName('tanks') as THREE.InstancedMesh;
    expect(tanks).toBeTruthy();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let grounded = 0;
    for (let i = 0; i < tanks.count; i++) {
      tanks.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      const ground = rolling(p.x, p.z);
      // either standing on the regolith (bottom at or slightly below it) or on top of a container
      const onGround = p.y <= ground + 0.01 && p.y > ground - 0.6;
      const onCrate = p.y > ground + 1.0;
      expect(onGround || onCrate).toBe(true);
      if (onGround) grounded++;
    }
    expect(grounded).toBeGreaterThan(8);
    base.dispose();
  });

  it('updates without throwing and disposes cleanly', () => {
    const base = createMoonbase({ seed: 11, lowPower: true, heightAt: () => 0 });
    const scene = new THREE.Scene();
    scene.add(base.object);
    const camera = new THREE.PerspectiveCamera();
    expect(() => base.update?.({ dt: 0.016, elapsed: 1.2, camera })).not.toThrow();
    base.dispose();
    expect(base.object.parent).toBeNull();
  });
});
