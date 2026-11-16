import { describe, expect, it } from 'vitest';
import {
  classifyBodyOnScreen,
  hudSafeInsets,
  ORBIT_CAMERA_FOV_DEG,
  ORBIT_EARTH_DISTANCE,
  ORBIT_EARTH_RADIUS,
  ORBIT_FIT_RADIUS,
  ORBIT_SUN_ALIGNMENT_PUSH,
  ORBIT_SUN_DISTANCE,
  placeEdgeIndicator,
  segmentHitsSphere,
  sunDistanceForSeparation,
  systemFrameInsets,
  systemViewPose,
} from './orbitScreen';

const DEG = Math.PI / 180;

/**
 * Projects a point of the equatorial ring (radius `ringRadius`, angle `theta` around the polar
 * axis, 0 = toward the camera's side) for a camera at `distance` and `elevationDeg`, looking at the
 * Moon's centre. Returns screen offsets from the Moon's centre in px (x right, y down).
 */
function projectRingPoint(
  ringRadius: number,
  theta: number,
  distance: number,
  elevationDeg: number,
  height: number,
): { x: number; y: number; depth: number } {
  const e = elevationDeg * DEG;
  // Camera frame: forward f points from the camera to the origin; right r is horizontal.
  const cam = [distance * Math.cos(e), distance * Math.sin(e), 0];
  const f = [-Math.cos(e), -Math.sin(e), 0];
  const r = [0, 0, -1];
  const u = [-Math.sin(e), Math.cos(e), 0];
  const p = [ringRadius * Math.cos(theta), 0, ringRadius * Math.sin(theta)];
  const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
  const depth = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  const scale = height / 2 / Math.tan((ORBIT_CAMERA_FOV_DEG * DEG) / 2) / depth;
  return {
    x: (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) * scale,
    y: -(d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) * scale,
    depth,
  };
}

describe('default framing with the Sun and the Earth', () => {
  const viewports: Array<[number, number]> = [
    [1920, 940],
    [1440, 900],
    [1366, 768],
    [1280, 720],
    [1024, 768],
    [820, 1180],
    [390, 844],
    [360, 640],
  ];

  it('keeps the whole ring of body positions inside the HUD-free area', () => {
    for (const [w, h] of viewports) {
      const pose = systemViewPose(w, h);
      const frame = systemFrameInsets(w, h);
      const cx = w / 2;
      const cy = h / 2 + pose.shiftYPx;
      for (let k = 0; k < 72; k++) {
        const pt = projectRingPoint(ORBIT_FIT_RADIUS, (k * 5 * Math.PI) / 180, pose.distance, pose.elevationDeg, h);
        expect(pt.depth).toBeGreaterThan(1);
        const x = cx + pt.x;
        const y = cy + pt.y;
        // 1.5 px of slack for rounding.
        expect(x).toBeGreaterThan(frame.left - 1.5);
        expect(x).toBeLessThan(w - frame.right + 1.5);
        expect(y).toBeGreaterThan(frame.top - 1.5);
        expect(y).toBeLessThan(h - frame.bottom + 1.5);
      }
    }
  });

  it('never hides a ring position behind the Moon and leaves a visible gap to the limb', () => {
    for (const [w, h] of viewports) {
      const pose = systemViewPose(w, h);
      const e = pose.elevationDeg * DEG;
      const cam: [number, number, number] = [pose.distance * Math.cos(e), pose.distance * Math.sin(e), 0];
      const limbPx = (Math.tan(Math.asin(1 / pose.distance)) / Math.tan((ORBIT_CAMERA_FOV_DEG * DEG) / 2)) * (h / 2);
      for (let k = 0; k < 36; k++) {
        const th = (k * 10 * Math.PI) / 180;
        const body: [number, number, number] = [
          ORBIT_EARTH_DISTANCE * Math.cos(th),
          0,
          ORBIT_EARTH_DISTANCE * Math.sin(th),
        ];
        expect(segmentHitsSphere(cam, body, 1.03)).toBe(false);
        const pt = projectRingPoint(ORBIT_EARTH_DISTANCE, th, pose.distance, pose.elevationDeg, h);
        const earthPx = (ORBIT_EARTH_RADIUS / ORBIT_EARTH_DISTANCE) * Math.hypot(pt.x, pt.y);
        // The Earth's disc clears the Moon's limb.
        expect(Math.hypot(pt.x, pt.y) - earthPx).toBeGreaterThan(limbPx * 1.05);
      }
      // The Moon is still a large part of the HUD-free area.
      expect(limbPx / pose.fitRadiusPx).toBeGreaterThan(0.62);
    }
  });

  it('puts the Earth on the side with free room and centres the globe between the HUD bars', () => {
    expect(systemViewPose(1920, 940).earthSide).toBe('left');
    expect(systemViewPose(1280, 720).earthSide).toBe('left');
    expect(systemViewPose(390, 844).earthSide).toBe('top');
    // Desktop: the bottom bars are taller than the top one → the globe moves up.
    expect(systemViewPose(1920, 940).shiftYPx).toBeLessThan(0);
    // Phone: the stacked top bars are taller → the globe moves down.
    expect(systemViewPose(390, 844).shiftYPx).toBeGreaterThan(0);
    // Degenerate sizes do not blow up.
    const odd = systemViewPose(0, Number.NaN);
    expect(Number.isFinite(odd.distance)).toBe(true);
    expect(odd.distance).toBeGreaterThan(3);
  });
});

describe('Sun distance near alignment with the Earth', () => {
  it('draws the Sun beyond the Earth only when the two line up', () => {
    expect(sunDistanceForSeparation(0)).toBeCloseTo(ORBIT_SUN_DISTANCE + ORBIT_SUN_ALIGNMENT_PUSH, 12);
    expect(sunDistanceForSeparation(5)).toBeGreaterThan(ORBIT_EARTH_DISTANCE + ORBIT_EARTH_RADIUS * 2);
    expect(sunDistanceForSeparation(30)).toBeCloseTo(ORBIT_SUN_DISTANCE, 12);
    expect(sunDistanceForSeparation(180)).toBeCloseTo(ORBIT_SUN_DISTANCE, 12);
    let prev = sunDistanceForSeparation(0);
    for (let sep = 1; sep <= 40; sep++) {
      const d = sunDistanceForSeparation(sep);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      // Smooth: no jump larger than a few hundredths of a Moon radius per degree.
      expect(prev - d).toBeLessThan(0.03);
      prev = d;
    }
  });
});

describe('edge indicators', () => {
  const insets = { top: 100, right: 60, bottom: 160, left: 60 };

  it('pins the indicator on the border of the safe rectangle, in the direction of the body', () => {
    const right = placeEdgeIndicator(1, 0, 1920, 940, insets);
    expect(right.x).toBeCloseTo(1860, 9);
    expect(right.y).toBeCloseTo((100 + 780) / 2, 9);
    expect(right.angleDeg).toBeCloseTo(0, 9);

    const up = placeEdgeIndicator(0, -5, 1920, 940, insets);
    expect(up.x).toBeCloseTo(960, 9);
    expect(up.y).toBeCloseTo(100, 9);
    expect(up.angleDeg).toBeCloseTo(-90, 9);

    const downLeft = placeEdgeIndicator(-1, 1, 1920, 940, insets);
    // The rectangle is wider than tall: a diagonal exits through the bottom edge.
    expect(downLeft.y).toBeCloseTo(780, 9);
    expect(downLeft.x).toBeCloseTo(960 - 340, 9);
    expect(downLeft.angleDeg).toBeCloseTo(135, 9);

    for (let a = 0; a < 360; a += 7) {
      const pl = placeEdgeIndicator(Math.cos(a * DEG), Math.sin(a * DEG), 390, 844, hudSafeInsets(390, 844));
      const safe = hudSafeInsets(390, 844);
      expect(pl.x).toBeGreaterThanOrEqual(safe.left - 1e-6);
      expect(pl.x).toBeLessThanOrEqual(390 - safe.right + 1e-6);
      expect(pl.y).toBeGreaterThanOrEqual(safe.top - 1e-6);
      expect(pl.y).toBeLessThanOrEqual(844 - safe.bottom + 1e-6);
    }
  });

  it('copes with a body straight ahead of or behind the camera', () => {
    const pl = placeEdgeIndicator(0, 0, 1920, 940, insets);
    expect(pl.x).toBeCloseTo(960, 9);
    expect(pl.y).toBeCloseTo(100, 9);
  });

  it('classifies bodies as visible, behind the Moon, covered or outside the view', () => {
    const base = { width: 1920, height: 940, marginPx: 4 };
    expect(classifyBodyOnScreen({ ...base, x: 500, y: 400, inFront: true, occluded: false })).toBe('visible');
    expect(classifyBodyOnScreen({ ...base, x: 500, y: 400, inFront: true, occluded: true })).toBe('behind-moon');
    expect(
      classifyBodyOnScreen({ ...base, x: 500, y: 400, inFront: true, occluded: false, covered: true }),
    ).toBe('covered');
    expect(classifyBodyOnScreen({ ...base, x: -20, y: 400, inFront: true, occluded: false })).toBe('offscreen');
    expect(classifyBodyOnScreen({ ...base, x: 500, y: 2000, inFront: true, occluded: true })).toBe('offscreen');
    expect(classifyBodyOnScreen({ ...base, x: 500, y: 400, inFront: false, occluded: false })).toBe('offscreen');
  });
});

describe('occlusion by the Moon', () => {
  it('detects when the line of sight crosses the sphere', () => {
    expect(segmentHitsSphere([0, 5, 0], [0, -2, 0], 1)).toBe(true);
    expect(segmentHitsSphere([0, 5, 0], [1.4, 0, 0], 1)).toBe(false);
    // The sphere is behind the far end of the segment: not in the way.
    expect(segmentHitsSphere([0, 5, 0], [0, 2, 0], 1)).toBe(false);
    // Grazing just outside / just inside the limb.
    expect(segmentHitsSphere([-5, 1.01, 0], [5, 1.01, 0], 1)).toBe(false);
    expect(segmentHitsSphere([-5, 0.99, 0], [5, 0.99, 0], 1)).toBe(true);
    expect(segmentHitsSphere([0.2, 0, 0], [0.2, 0, 0], 1)).toBe(true);
  });
});
