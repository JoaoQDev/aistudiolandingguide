import React from 'react';

/**
 * Horizon strip: the "true instrument" of the first-person view. A heading-centred panorama of
 * the active site's real terrain horizon (LOLA-derived profile) with the Sun and Earth at their
 * real dataset azimuth/elevation and their tracks over the selected window.
 *
 * STUB — owned by the STRIP agent. The props below are the fixed contract.
 */
export interface HorizonStripProps {
  /** Azimuths (deg, clockwise from North) of the horizon profile samples. */
  horizonAzDeg: number[];
  /** Real terrain horizon elevation (deg) per azimuth at the active site. */
  horizonElevDeg: number[];
  /** Full dataset series (deg), one value per epoch. */
  sunAzDeg: number[];
  sunElDeg: number[];
  earthAzDeg: number[];
  earthElDeg: number[];
  /** Angular radii (deg) per epoch. */
  solarAngularRadiusDeg: number[];
  earthAngularRadiusDeg: number[];
  epochIdx: number;
  /** Selected mission window (inclusive epoch indices): tracks are drawn over it. */
  windowStartIdx: number;
  windowEndIdx: number;
  /** Dataset-derived state now, for colouring/labels. */
  sunIllumFraction: number;
  dteVisible: boolean;
  /** Player heading (deg clockwise from North, may be unwrapped); polled every animation frame. */
  getHeadingDeg: () => number;
}

export const HorizonStrip: React.FC<HorizonStripProps> = () => null;
