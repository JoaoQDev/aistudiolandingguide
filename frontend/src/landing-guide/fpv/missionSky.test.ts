import { describe, expect, it } from 'vitest';
import {
  buildMissionSceneState,
  drawnElevationDeg,
  MAX_DRAWN_EARTH_EL_DEG,
  MAX_DRAWN_SUN_EL_DEG,
  MIN_DRAWN_EL_DEG,
  SKY_HEIGHT_EXAGGERATION,
  type MissionSkyInput,
} from './missionSky';

const base: MissionSkyInput = {
  sunAzDeg: 251.9,
  sunElDeg: 1.4,
  horizonAtSunDeg: -0.6,
  sunIllumFraction: 1,
  earthAzDeg: 134.9,
  earthElDeg: -3.9,
  horizonAtEarthDeg: 0.5,
  powerW: 300,
  peakPowerW: 600,
  dteVisible: false,
  combinedLinkVisible: true,
};

describe('missionSky', () => {
  it('draws bodies at their margin above the terrain horizon, exaggerated and capped', () => {
    expect(drawnElevationDeg(1, 99)).toBeCloseTo(SKY_HEIGHT_EXAGGERATION);
    expect(drawnElevationDeg(0, 99)).toBe(0);
    expect(drawnElevationDeg(-1, 99)).toBeCloseTo(-SKY_HEIGHT_EXAGGERATION);
    expect(drawnElevationDeg(50, MAX_DRAWN_SUN_EL_DEG)).toBe(MAX_DRAWN_SUN_EL_DEG);
    expect(drawnElevationDeg(-50, MAX_DRAWN_SUN_EL_DEG)).toBe(MIN_DRAWN_EL_DEG);
    expect(drawnElevationDeg(Number.NaN, 10)).toBe(0);
  });

  it('keeps azimuths, visibility, power and link straight from the data', () => {
    const m = buildMissionSceneState(base);
    expect(m.sunAzDeg).toBe(251.9);
    expect(m.earthAzDeg).toBe(134.9);
    expect(m.sunDrawnElDeg).toBeCloseTo(2.0 * SKY_HEIGHT_EXAGGERATION);
    expect(m.earthDrawnElDeg).toBe(MIN_DRAWN_EL_DEG); // 4.4° below terrain → floor
    expect(m.sunIllumFraction).toBe(1);
    expect(m.powerFraction).toBeCloseTo(0.5);
    expect(m.link).toBe('relay');
  });

  it('orders the link states and guards bad numbers', () => {
    expect(buildMissionSceneState({ ...base, dteVisible: true }).link).toBe('dte');
    expect(buildMissionSceneState({ ...base, combinedLinkVisible: false }).link).toBe('none');
    const dark = buildMissionSceneState({ ...base, sunElDeg: -1.5, sunIllumFraction: 0, powerW: 0, peakPowerW: 0 });
    expect(dark.sunDrawnElDeg).toBeLessThan(0);
    expect(dark.powerFraction).toBe(0);
    const high = buildMissionSceneState({ ...base, earthElDeg: 30, sunIllumFraction: 7 });
    expect(high.earthDrawnElDeg).toBe(MAX_DRAWN_EARTH_EL_DEG);
    expect(high.sunIllumFraction).toBe(1);
  });
});
