/**
 * Moon-fixed directions toward the Sun and the Earth for the Orbit 3D globe.
 *
 * The dataset stores, for every site and hourly epoch, the topocentric azimuth/elevation of the Sun
 * and of the Earth. Rotating that local East-North-Up vector with the site's latitude/longitude gives
 * the same direction in the Moon-fixed MOON_ME frame (X = 0°E on the equator, Y = 90°E, Z = north
 * pole). Nothing here is fitted or approximated beyond one stated simplification:
 *
 *   The Sun is far enough that every site sees it in the same direction. The Earth is not: its
 *   direction differs between surface sites (and from the Moon-centre direction) by the lunar
 *   parallax, at most about 0.26°. That is neglected, so "the" Earth direction is the mean over the
 *   precomputed sites and the sub-Earth point drawn on the globe can be off by up to that amount.
 *
 * Pure functions only (no three.js, no DOM) so they can be unit-tested.
 */
import type { LandingSiteEntry } from '../navigator/types';
import { enuToMoonMeUnit, moonMeUnitToEnuAzEl } from './customSiteBuilder';

export { enuToMoonMeUnit, moonMeUnitToEnuAzEl };

export type Vec3 = [number, number, number];

/** A direction given by the point on the Moon where the body is at the zenith. */
export interface SubPoint {
  latDeg: number;
  /** East longitude, 0…360. */
  lonEastDeg: number;
}

export interface BodyDirectionsMoonMe {
  sun: Vec3;
  earth: Vec3;
}

export interface BodySubPoints {
  sun: SubPoint;
  earth: SubPoint;
}

const DEG = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) return [1, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function angularSeparationDeg(a: Vec3, b: Vec3): number {
  const ua = normalize3(a);
  const ub = normalize3(b);
  // atan2 of |a×b| and a·b stays accurate for nearly parallel vectors.
  const cx = ua[1] * ub[2] - ua[2] * ub[1];
  const cy = ua[2] * ub[0] - ua[0] * ub[2];
  const cz = ua[0] * ub[1] - ua[1] * ub[0];
  const dot = ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2];
  return Math.atan2(Math.hypot(cx, cy, cz), dot) / DEG;
}

/** MOON_ME unit vector → the surface point that has this direction at its zenith. */
export function moonMeUnitToSubPoint(v: Vec3): SubPoint {
  const u = normalize3(v);
  return {
    latDeg: Math.asin(clamp(u[2], -1, 1)) / DEG,
    lonEastDeg: wrap360(Math.atan2(u[1], u[0]) / DEG),
  };
}

export function subPointToMoonMeUnit(latDeg: number, lonEastDeg: number): Vec3 {
  const phi = latDeg * DEG;
  const lam = lonEastDeg * DEG;
  const c = Math.cos(phi);
  return [c * Math.cos(lam), c * Math.sin(lam), Math.sin(phi)];
}

/**
 * MOON_ME → the globe mesh's local frame used by `latLonToSphereUnit` in lunarTerrainEngine
 * (0°E at −x, north pole at +y, 90°E at +z). A proper rotation, so angles are preserved.
 */
export function moonMeToGlobeLocal(v: Vec3): { x: number; y: number; z: number } {
  return { x: -v[0], y: v[2], z: v[1] };
}

export function globeLocalToMoonMe(x: number, y: number, z: number): Vec3 {
  return [-x, z, y];
}

/** Signed longitude in (−180, 180], handy to read librations around the 0°E meridian. */
export function signedLonDeg(lonEastDeg: number): number {
  const w = wrap360(lonEastDeg);
  return w > 180 ? w - 360 : w;
}

/** Sun and Earth directions (MOON_ME unit vectors) seen from one site at one epoch. */
export function siteBodyDirectionsMoonMe(
  site: LandingSiteEntry,
  epochIdx: number,
): BodyDirectionsMoonMe | null {
  const s = site.sky_series;
  const sunAz = s.sun_az_deg[epochIdx];
  const sunEl = s.sun_el_deg[epochIdx];
  const earthAz = s.earth_az_deg[epochIdx];
  const earthEl = s.earth_el_deg[epochIdx];
  if (![sunAz, sunEl, earthAz, earthEl].every((n) => Number.isFinite(n))) return null;
  const lat = site.center.latitude_deg;
  const lon = site.center.longitude_east_deg;
  return {
    sun: normalize3(enuToMoonMeUnit(lat, lon, sunAz, sunEl)),
    earth: normalize3(enuToMoonMeUnit(lat, lon, earthAz, earthEl)),
  };
}

/**
 * Sun and Earth directions for an epoch, averaged over the given sites (normalised vector mean).
 * Averaging removes the per-site rounding of the az/el series; Earth parallax between the sites
 * (≤ ~0.26°, see the file header) is neglected.
 */
export function meanBodyDirectionsMoonMe(
  sites: readonly LandingSiteEntry[],
  epochIdx: number,
): BodyDirectionsMoonMe | null {
  const sun: Vec3 = [0, 0, 0];
  const earth: Vec3 = [0, 0, 0];
  let n = 0;
  for (const site of sites) {
    const d = siteBodyDirectionsMoonMe(site, epochIdx);
    if (!d) continue;
    for (let k = 0; k < 3; k++) {
      sun[k] += d.sun[k];
      earth[k] += d.earth[k];
    }
    n++;
  }
  if (n === 0) return null;
  return { sun: normalize3(sun), earth: normalize3(earth) };
}

/**
 * Sub-solar and sub-Earth points for an epoch. Uses the mean over `sites` and falls back to
 * `fallbackSite` (e.g. the active site) when none of them has data for that epoch.
 */
export function bodySubPointsAtEpoch(
  sites: readonly LandingSiteEntry[],
  fallbackSite: LandingSiteEntry | null | undefined,
  epochIdx: number,
): BodySubPoints | null {
  const dirs =
    meanBodyDirectionsMoonMe(sites, epochIdx) ??
    (fallbackSite ? siteBodyDirectionsMoonMe(fallbackSite, epochIdx) : null);
  if (!dirs) return null;
  return { sun: moonMeUnitToSubPoint(dirs.sun), earth: moonMeUnitToSubPoint(dirs.earth) };
}

/**
 * Points (MOON_ME unit vectors) along the great circle that leaves a surface point with the given
 * compass heading. The topocentric azimuth of a body is exactly the initial heading of the great
 * circle toward its sub-point, and that sub-point lies (90° − elevation) of arc away.
 */
export function greatCircleArc(
  latDeg: number,
  lonEastDeg: number,
  headingDeg: number,
  arcDeg: number,
  steps: number,
): Vec3[] {
  const origin = subPointToMoonMeUnit(latDeg, lonEastDeg);
  const tangent = normalize3(enuToMoonMeUnit(latDeg, lonEastDeg, headingDeg, 0));
  const n = Math.max(1, Math.floor(steps));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = ((arcDeg * i) / n) * DEG;
    const c = Math.cos(s);
    const sn = Math.sin(s);
    out.push([
      origin[0] * c + tangent[0] * sn,
      origin[1] * c + tangent[1] * sn,
      origin[2] * c + tangent[2] * sn,
    ]);
  }
  return out;
}

/** Shortest signed rotation from one angle to another, in (−180, 180]. */
export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  const d = wrap360(toDeg - fromDeg);
  return d > 180 ? d - 360 : d;
}

/**
 * Moves a sub-point a fraction `alpha` (0…1) of the way to a target, in longitude/latitude rather
 * than along the shortest great circle: the Sun and the Earth stay close to the Moon's equator, and
 * a great-circle shortcut between two nearly opposite longitudes would swing over a pole.
 */
export function stepSubPointToward(current: SubPoint, target: SubPoint, alpha: number): SubPoint {
  const a = clamp(alpha, 0, 1);
  return {
    latDeg: current.latDeg + (target.latDeg - current.latDeg) * a,
    lonEastDeg: wrap360(
      current.lonEastDeg + shortestAngleDeltaDeg(current.lonEastDeg, target.lonEastDeg) * a,
    ),
  };
}

/** Largest of the latitude and longitude differences between two sub-points, degrees. */
export function subPointGapDeg(a: SubPoint, b: SubPoint): number {
  return Math.max(
    Math.abs(a.latDeg - b.latDeg),
    Math.abs(shortestAngleDeltaDeg(a.lonEastDeg, b.lonEastDeg)),
  );
}
