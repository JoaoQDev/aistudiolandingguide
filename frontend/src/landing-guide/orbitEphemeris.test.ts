import { describe, expect, it } from 'vitest';
import datasetJson from '../data/south_pole_precomputed.v1.json';
import { parseNavigatorDataset } from '../contract';
import { latLonToSphereUnit, sphereUnitToLatLon } from './lunarTerrainEngine';
import {
  angularSeparationDeg,
  bodySubPointsAtEpoch,
  enuToMoonMeUnit,
  globeLocalToMoonMe,
  greatCircleArc,
  meanBodyDirectionsMoonMe,
  moonMeToGlobeLocal,
  moonMeUnitToEnuAzEl,
  moonMeUnitToSubPoint,
  shortestAngleDeltaDeg,
  signedLonDeg,
  siteBodyDirectionsMoonMe,
  stepSubPointToward,
  subPointGapDeg,
  subPointToMoonMeUnit,
  Vec3,
} from './orbitEphemeris';

const dataset = parseNavigatorDataset(datasetJson);
const EPOCHS = dataset.mission_window.timestamps_utc.length;

const angleDiff = (a: number, b: number) => Math.abs(shortestAngleDeltaDeg(a, b));

describe('ENU ↔ MOON_ME rotation', () => {
  it('round-trips azimuth/elevation at arbitrary sites', () => {
    let s = 12345;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 200; i++) {
      const lat = -89.9 + rand() * 179.8;
      const lon = rand() * 360;
      const az = rand() * 360;
      const el = -80 + rand() * 160;
      const me = enuToMoonMeUnit(lat, lon, az, el);
      expect(Math.hypot(me[0], me[1], me[2])).toBeCloseTo(1, 12);
      const back = moonMeUnitToEnuAzEl(me, lat, lon);
      expect(back.elDeg).toBeCloseTo(el, 8);
      expect(angleDiff(back.azDeg, az)).toBeLessThan(1e-7);
    }
  });

  it('puts the zenith at the site and local north toward the north pole', () => {
    const up = enuToMoonMeUnit(-86, 2.7, 0, 90);
    const sub = moonMeUnitToSubPoint(up);
    expect(sub.latDeg).toBeCloseTo(-86, 9);
    expect(sub.lonEastDeg).toBeCloseTo(2.7, 9);

    // Sun on the horizon due North of a south-polar site: its sub-point is 90° further north along
    // the site's own meridian, i.e. 1° north of the equator for a site at 89°S.
    const sunNorth = moonMeUnitToSubPoint(enuToMoonMeUnit(-89, 30, 0, 0));
    expect(sunNorth.latDeg).toBeCloseTo(1, 9);
    expect(sunNorth.lonEastDeg).toBeCloseTo(30, 9);

    // Due East on the horizon is on the equator, 90° of longitude ahead.
    const sunEast = moonMeUnitToSubPoint(enuToMoonMeUnit(-89, 30, 90, 0));
    expect(sunEast.latDeg).toBeCloseTo(0, 9);
    expect(sunEast.lonEastDeg).toBeCloseTo(120, 9);
  });

  it('reduces to "longitude + azimuth" exactly at the south pole', () => {
    for (const [lon, az, el] of [
      [0, 10, 0],
      [222.5, 252, 1.5],
      [118.8, 301, -1.2],
    ]) {
      const sub = moonMeUnitToSubPoint(enuToMoonMeUnit(-90, lon, az, el));
      expect(angleDiff(sub.lonEastDeg, lon + az)).toBeLessThan(1e-7);
      // Elevation e at the south pole means a body 'e' degrees south of the equator.
      expect(sub.latDeg).toBeCloseTo(-el, 9);
    }
  });
});

describe('globe-local frame', () => {
  it('matches latLonToSphereUnit and is a proper rotation', () => {
    for (const [lat, lon] of [
      [0, 0],
      [0, 90],
      [-90, 0],
      [37.5, 211.25],
      [-84.36, 31.9],
    ]) {
      const local = moonMeToGlobeLocal(subPointToMoonMeUnit(lat, lon));
      const ref = latLonToSphereUnit(lat, lon);
      expect(local.x).toBeCloseTo(ref.x, 12);
      expect(local.y).toBeCloseTo(ref.y, 12);
      expect(local.z).toBeCloseTo(ref.z, 12);
      const back = globeLocalToMoonMe(local.x, local.y, local.z);
      const sub = moonMeUnitToSubPoint(back);
      expect(sub.latDeg).toBeCloseTo(lat, 9);
      if (Math.abs(lat) < 89.9) expect(angleDiff(sub.lonEastDeg, lon)).toBeLessThan(1e-7);
      const viaEngine = sphereUnitToLatLon(local.x, local.y, local.z);
      expect(viaEngine.latDeg).toBeCloseTo(lat, 9);
    }
    // Handedness: X × Y = Z must still hold after the change of frame.
    const x = moonMeToGlobeLocal([1, 0, 0]);
    const y = moonMeToGlobeLocal([0, 1, 0]);
    const z = moonMeToGlobeLocal([0, 0, 1]);
    expect(x.y * y.z - x.z * y.y).toBeCloseTo(z.x, 12);
    expect(x.z * y.x - x.x * y.z).toBeCloseTo(z.y, 12);
    expect(x.x * y.y - x.y * y.x).toBeCloseTo(z.z, 12);
  });
});

describe('Sun and Earth directions from the dataset', () => {
  it('all sites agree on the Sun direction and (within parallax) on the Earth direction', () => {
    for (let epoch = 0; epoch < EPOCHS; epoch += 24) {
      const mean = meanBodyDirectionsMoonMe(dataset.sites, epoch);
      expect(mean).not.toBeNull();
      for (const site of dataset.sites) {
        const d = siteBodyDirectionsMoonMe(site, epoch);
        expect(d).not.toBeNull();
        expect(angularSeparationDeg(d!.sun, mean!.sun)).toBeLessThan(0.01);
        expect(angularSeparationDeg(d!.earth, mean!.earth)).toBeLessThan(0.3);
      }
    }
  });

  it('keeps the sub-solar point within 1.6° of the lunar equator for every epoch', () => {
    let maxAbsLat = 0;
    for (let epoch = 0; epoch < EPOCHS; epoch++) {
      const sub = bodySubPointsAtEpoch(dataset.sites, null, epoch);
      expect(sub).not.toBeNull();
      maxAbsLat = Math.max(maxAbsLat, Math.abs(sub!.sun.latDeg));
    }
    expect(maxAbsLat).toBeLessThan(1.6);
    expect(maxAbsLat).toBeGreaterThan(1.0);
  });

  it('keeps the sub-Earth point near the centre of the near side (libration)', () => {
    let maxAbsLat = 0;
    let maxAbsLon = 0;
    for (let epoch = 0; epoch < EPOCHS; epoch++) {
      const sub = bodySubPointsAtEpoch(dataset.sites, null, epoch)!;
      maxAbsLat = Math.max(maxAbsLat, Math.abs(sub.earth.latDeg));
      maxAbsLon = Math.max(maxAbsLon, Math.abs(signedLonDeg(sub.earth.lonEastDeg)));
    }
    // Optical libration is about ±6.7° in latitude and ±7.9° in longitude; the sites add ≤ 0.26°
    // of parallax.
    expect(maxAbsLat).toBeLessThan(7.2);
    expect(maxAbsLon).toBeLessThan(8.5);
    // …and it really does wander by several degrees during the month.
    expect(maxAbsLat).toBeGreaterThan(3);
    expect(maxAbsLon).toBeGreaterThan(3);
  });

  it('sweeps the sub-solar point westward by about 12.2° per day', () => {
    const a = bodySubPointsAtEpoch(dataset.sites, null, 0)!;
    const b = bodySubPointsAtEpoch(dataset.sites, null, 24)!;
    const perDay = shortestAngleDeltaDeg(a.sun.lonEastDeg, b.sun.lonEastDeg);
    expect(perDay).toBeLessThan(-11.8);
    expect(perDay).toBeGreaterThan(-12.6);
  });

  it('matches the known Shackleton ridge case at epoch 0 (Sun azimuth 252°)', () => {
    const ridge = dataset.sites.find((s) => s.id === 'shackleton_ridge')!;
    expect(ridge.sky_series.sun_az_deg[0]).toBeCloseTo(252, 0);
    const d = siteBodyDirectionsMoonMe(ridge, 0)!;
    const sun = moonMeUnitToSubPoint(d.sun);
    expect(sun.lonEastDeg).toBeCloseTo(114.43, 1);
    expect(sun.latDeg).toBeCloseTo(-1.56, 1);
    // Reprojecting the Moon-fixed vector to another site reproduces that site's own series.
    const other = dataset.sites.find((s) => s.id === 'nobile_rim_1')!;
    const local = moonMeUnitToEnuAzEl(d.sun, other.center.latitude_deg, other.center.longitude_east_deg);
    expect(angleDiff(local.azDeg, other.sky_series.sun_az_deg[0])).toBeLessThan(0.05);
    expect(Math.abs(local.elDeg - other.sky_series.sun_el_deg[0])).toBeLessThan(0.02);
  });

  it('falls back to the given site and reports missing data', () => {
    const ridge = dataset.sites[0];
    expect(bodySubPointsAtEpoch([], ridge, 5)).not.toBeNull();
    expect(bodySubPointsAtEpoch([], null, 5)).toBeNull();
    expect(bodySubPointsAtEpoch(dataset.sites, ridge, EPOCHS + 10)).toBeNull();
    expect(siteBodyDirectionsMoonMe(ridge, -1)).toBeNull();
  });
});

describe('surface headings', () => {
  it('follows the body azimuth and reaches its sub-point after (90° − elevation) of arc', () => {
    for (const site of [dataset.sites[0], dataset.sites[5]]) {
      for (const epoch of [0, 180, 360, 540]) {
        const dirs = siteBodyDirectionsMoonMe(site, epoch)!;
        const az = site.sky_series.sun_az_deg[epoch];
        const el = site.sky_series.sun_el_deg[epoch];
        const arc = greatCircleArc(
          site.center.latitude_deg,
          site.center.longitude_east_deg,
          az,
          90 - el,
          8,
        );
        expect(arc).toHaveLength(9);
        const start = moonMeUnitToSubPoint(arc[0]);
        expect(start.latDeg).toBeCloseTo(site.center.latitude_deg, 6);
        expect(angularSeparationDeg(arc[8], dirs.sun)).toBeLessThan(1e-6);
        for (let i = 1; i < arc.length; i++) {
          expect(angularSeparationDeg(arc[i - 1], arc[i])).toBeCloseTo((90 - el) / 8, 6);
        }
      }
    }
  });
});

describe('sub-point easing', () => {
  it('takes the short way across 0°/360° and stays near the equator', () => {
    expect(shortestAngleDeltaDeg(350, 10)).toBeCloseTo(20, 12);
    expect(shortestAngleDeltaDeg(10, 350)).toBeCloseTo(-20, 12);
    expect(shortestAngleDeltaDeg(0, 180)).toBeCloseTo(180, 12);

    const half = stepSubPointToward({ latDeg: -1, lonEastDeg: 350 }, { latDeg: 1, lonEastDeg: 10 }, 0.5);
    expect(half.latDeg).toBeCloseTo(0, 12);
    expect(angleDiff(half.lonEastDeg, 0)).toBeLessThan(1e-9);

    // Nearly opposite longitudes: every intermediate step keeps the low latitude instead of
    // cutting across a pole.
    let cur = { latDeg: -1.5, lonEastDeg: 114 };
    const target = { latDeg: -1.4, lonEastDeg: 295 };
    for (let i = 0; i < 40; i++) {
      cur = stepSubPointToward(cur, target, 0.2);
      expect(Math.abs(cur.latDeg)).toBeLessThan(1.6);
    }
    expect(subPointGapDeg(cur, target)).toBeLessThan(0.05);
    expect(stepSubPointToward(cur, target, 1)).toEqual({ latDeg: -1.4, lonEastDeg: 295 });
  });

  it('measures angles between vectors robustly', () => {
    const a: Vec3 = [1, 0, 0];
    expect(angularSeparationDeg(a, [0, 2, 0])).toBeCloseTo(90, 12);
    expect(angularSeparationDeg(a, [-3, 0, 0])).toBeCloseTo(180, 12);
    expect(angularSeparationDeg(a, [1, 1e-9, 0])).toBeCloseTo(5.729577951e-8, 12);
  });
});
