import type { MissionSceneState } from './types';

/**
 * Maps real mission conditions (dataset Sun/Earth angles, LOLA terrain horizon, power, links)
 * to what the first-person scene draws.
 *
 * The base-camp scenery is illustrative and almost flat, while real South Pole horizons sit a
 * few degrees above or below 0° and the Sun never clears them by more than a few degrees. So
 * the scene draws each body at its real *margin above the terrain horizon*, exaggerated by
 * SKY_HEIGHT_EXAGGERATION and capped, at its real azimuth. Whether the Sun is up, how much of
 * its disc shows, the power level and the link state are never exaggerated: they come straight
 * from the dataset-derived analysis. The real angles are shown by the HUD and the horizon strip.
 */

/** Drawn height above the game horizon = real margin above the terrain horizon × this factor. */
export const SKY_HEIGHT_EXAGGERATION = 3;
/** Cap for the drawn Sun (keeps the lit look the scene was tuned for). */
export const MAX_DRAWN_SUN_EL_DEG = 12;
export const MAX_DRAWN_EARTH_EL_DEG = 24;
/** Bodies below the terrain horizon are drawn below the game horizon, down to this floor. */
export const MIN_DRAWN_EL_DEG = -9;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Drawn elevation (deg) for a body `marginDeg` above (+) or below (−) the real terrain horizon. */
export function drawnElevationDeg(marginDeg: number, maxDeg: number): number {
  return clamp(finiteOr(marginDeg, 0) * SKY_HEIGHT_EXAGGERATION, MIN_DRAWN_EL_DEG, maxDeg);
}

export interface MissionSkyInput {
  /** Dataset topocentric Sun azimuth / elevation (deg). */
  sunAzDeg: number;
  sunElDeg: number;
  /** Real terrain horizon elevation (deg) at the Sun's azimuth. */
  horizonAtSunDeg: number;
  /** Fraction of the solar disc above that horizon, 0..1. */
  sunIllumFraction: number;
  earthAzDeg: number;
  earthElDeg: number;
  horizonAtEarthDeg: number;
  /** Array power now and the best value of the site's series (W). */
  powerW: number;
  peakPowerW: number;
  dteVisible: boolean;
  /** Direct-to-Earth or relay link available. */
  combinedLinkVisible: boolean;
}

export function buildMissionSceneState(i: MissionSkyInput): MissionSceneState {
  const peak = finiteOr(i.peakPowerW, 0);
  return {
    sunAzDeg: finiteOr(i.sunAzDeg, 0),
    sunDrawnElDeg: drawnElevationDeg(i.sunElDeg - i.horizonAtSunDeg, MAX_DRAWN_SUN_EL_DEG),
    sunIllumFraction: clamp(finiteOr(i.sunIllumFraction, 0), 0, 1),
    earthAzDeg: finiteOr(i.earthAzDeg, 0),
    earthDrawnElDeg: drawnElevationDeg(i.earthElDeg - i.horizonAtEarthDeg, MAX_DRAWN_EARTH_EL_DEG),
    powerFraction: peak > 0 ? clamp(finiteOr(i.powerW, 0) / peak, 0, 1) : 0,
    link: i.dteVisible ? 'dte' : i.combinedLinkVisible ? 'relay' : 'none',
  };
}
