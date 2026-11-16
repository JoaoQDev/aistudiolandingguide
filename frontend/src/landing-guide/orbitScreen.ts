/**
 * Screen-space helpers and scene constants for the Sun and the Earth in the Orbit 3D globe.
 * Pure functions (no three.js, no DOM) so the framing and the edge indicators can be unit-tested.
 *
 * Scene units are Moon radii. The directions of the two bodies are exact; their distances and sizes
 * are illustrative on purpose: at true scale the Earth would be about 221 Moon radii away and the
 * Sun about 86 000, far outside any view that still shows the landing sites.
 */

export type Vec3Tuple = [number, number, number];

/** Vertical field of view of the globe camera, degrees. */
export const ORBIT_CAMERA_FOV_DEG = 34;

/** Illustrative distance of the Earth from the Moon's centre (Moon radii). Not to scale. */
export const ORBIT_EARTH_DISTANCE = 1.33;
/** Illustrative radius of the Earth sphere (Moon radii). Not to scale. */
export const ORBIT_EARTH_RADIUS = 0.108;
/** Illustrative distance of the Sun disc from the Moon's centre (Moon radii). Not to scale. */
export const ORBIT_SUN_DISTANCE = 1.34;
/** Extra distance given to the Sun when it lines up with the Earth, so it is drawn beyond it. */
export const ORBIT_SUN_ALIGNMENT_PUSH = 0.3;
/** Radius of the bright solar disc and of its soft glow (Moon radii). Not to scale. */
export const ORBIT_SUN_CORE_RADIUS = 0.068;
export const ORBIT_SUN_GLOW_RADIUS = 0.5;

/** Radius that the default framing keeps inside the HUD-free area (the Sun disc with a little air). */
export const ORBIT_FIT_RADIUS = ORBIT_SUN_DISTANCE + ORBIT_SUN_CORE_RADIUS;

/** Camera elevation above the Moon's equatorial plane in the default "system" view, degrees. */
export const ORBIT_SYSTEM_VIEW_ELEVATION_DEG = 84;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Distance at which the Sun disc is drawn, given its angular separation from the Earth as seen
 * from the Moon. Near alignment (around full Moon) the Sun is moved outward so it appears behind
 * the Earth instead of on top of it. The direction is never changed.
 */
export function sunDistanceForSeparation(separationDeg: number): number {
  return ORBIT_SUN_DISTANCE + ORBIT_SUN_ALIGNMENT_PUSH * (1 - smoothstep(9, 30, separationDeg));
}

export interface ScreenInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Area of the viewport the explorer HUD leaves free for the globe and the two bodies (fixed bars of
 * style.css: top buttons, bottom site chips and time strip; on phones the stacked top bars and the
 * Sun/Earth key). The narrow Moon/Topography switch at the top centre is deliberately ignored: a
 * body passing behind it gets an edge indicator instead.
 */
export function systemFrameInsets(width: number, height: number): ScreenInsets {
  if (width <= 820) {
    return { top: Math.min(236, height * 0.3), right: 12, bottom: Math.min(132, height * 0.2), left: 12 };
  }
  return { top: Math.min(40, height * 0.08), right: 40, bottom: Math.min(146, height * 0.24), left: 40 };
}

/** Margins that keep the edge indicators clear of the explorer HUD. */
export function hudSafeInsets(width: number, height: number): ScreenInsets {
  if (width <= 820) {
    return { top: Math.min(250, height * 0.32), right: 46, bottom: Math.min(150, height * 0.22), left: 46 };
  }
  return { top: Math.min(104, height * 0.16), right: 64, bottom: Math.min(164, height * 0.26), left: 64 };
}

export interface SystemViewPose {
  /** Camera distance from the Moon's centre, Moon radii. */
  distance: number;
  /** Elevation of the camera above the equatorial plane, on the south-pole side, degrees. */
  elevationDeg: number;
  /**
   * Where the 0°E meridian (the mean Earth direction) lands on screen: the side with the most
   * free room, so the Earth is never cut off by the short dimension of the viewport.
   */
  earthSide: 'left' | 'top';
  /** Vertical shift of the picture that centres the Moon in the HUD-free area, px (+ = down). */
  shiftYPx: number;
  /** Radius of the HUD-free circle the bodies are fitted in, px. */
  fitRadiusPx: number;
}

/**
 * Default framing: looks down on the south pole from far enough that a ring of radius
 * `ORBIT_FIT_RADIUS` around the Moon (where the Sun and the Earth are drawn) fits in the HUD-free
 * part of the viewport.
 */
export function systemViewPose(
  width: number,
  height: number,
  fovDeg: number = ORBIT_CAMERA_FOV_DEG,
): SystemViewPose {
  const w = Number.isFinite(width) && width > 0 ? width : 1280;
  const h = Number.isFinite(height) && height > 0 ? height : 720;
  const frame = systemFrameInsets(w, h);
  const availW = w - frame.left - frame.right;
  const availH = h - frame.top - frame.bottom;
  const fitRadiusPx = Math.max(Math.min(availW, availH), 0.4 * Math.min(w, h)) / 2;
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanRing = (fitRadiusPx / (h / 2)) * tanV;
  const elevationDeg = ORBIT_SYSTEM_VIEW_ELEVATION_DEG;
  // The ring is seen almost face-on; its near side is slightly closer to the camera, hence larger.
  const elev = (elevationDeg * Math.PI) / 180;
  const distance = (ORBIT_FIT_RADIUS * Math.sin(elev)) / tanRing + ORBIT_FIT_RADIUS * Math.cos(elev);
  return {
    distance: clamp(distance, 3.4, 24),
    elevationDeg,
    earthSide: availW >= availH ? 'left' : 'top',
    shiftYPx: (frame.top - frame.bottom) / 2,
    fitRadiusPx,
  };
}

export interface EdgePlacement {
  x: number;
  y: number;
  /** Screen angle of the direction, degrees (0 = right, 90 = down). */
  angleDeg: number;
}

/**
 * Point on the border of the safe rectangle in the given screen direction (x right, y down), seen
 * from the rectangle's centre. Used to pin an indicator for a body that is outside the view.
 */
export function placeEdgeIndicator(
  dirX: number,
  dirY: number,
  width: number,
  height: number,
  insets: ScreenInsets,
): EdgePlacement {
  const left = insets.left;
  const right = Math.max(left + 1, width - insets.right);
  const top = insets.top;
  const bottom = Math.max(top + 1, height - insets.bottom);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const len = Math.hypot(dirX, dirY);
  // A body exactly along the view axis has no screen direction: point up by convention.
  const ux = len > 1e-9 ? dirX / len : 0;
  const uy = len > 1e-9 ? dirY / len : -1;
  const halfW = (right - left) / 2;
  const halfH = (bottom - top) / 2;
  const tx = Math.abs(ux) > 1e-9 ? halfW / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(uy) > 1e-9 ? halfH / Math.abs(uy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  return {
    x: cx + ux * t,
    y: cy + uy * t,
    angleDeg: (Math.atan2(uy, ux) * 180) / Math.PI,
  };
}

/**
 * True when the straight segment between two points passes through a sphere centred on the origin
 * (the Moon hides whatever is behind it).
 */
export function segmentHitsSphere(from: Vec3Tuple, to: Vec3Tuple, radius: number): boolean {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-18) return Math.hypot(from[0], from[1], from[2]) < radius;
  const t = clamp(-(from[0] * dx + from[1] * dy + from[2] * dz) / len2, 0, 1);
  const px = from[0] + dx * t;
  const py = from[1] + dy * t;
  const pz = from[2] + dz * t;
  return px * px + py * py + pz * pz < radius * radius;
}

export type BodyScreenState = 'visible' | 'behind-moon' | 'offscreen' | 'covered';

/**
 * Classifies a body from its projected position. `inFront` is false when it is behind the camera;
 * `occluded` when the Moon covers its centre; `covered` when an interface panel sits on top of it.
 */
export function classifyBodyOnScreen(params: {
  x: number;
  y: number;
  inFront: boolean;
  occluded: boolean;
  width: number;
  height: number;
  covered?: boolean;
  /** Pixels of the body that must stay inside the viewport to count as visible. */
  marginPx?: number;
}): BodyScreenState {
  const { x, y, inFront, occluded, width, height } = params;
  const m = params.marginPx ?? 0;
  const onScreen = inFront && x >= m && x <= width - m && y >= m && y <= height - m;
  if (!onScreen) return 'offscreen';
  if (occluded) return 'behind-moon';
  return params.covered ? 'covered' : 'visible';
}
