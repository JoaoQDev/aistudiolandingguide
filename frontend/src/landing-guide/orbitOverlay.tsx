import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import type { SubPoint } from './orbitEphemeris';
import { signedLonDeg } from './orbitEphemeris';
import type { BodyScreenState, EdgePlacement } from './orbitScreen';
import './orbitOverlay.css';

/**
 * SVG labels and indicators for the Sun and the Earth of the Orbit 3D globe. Rendered inside the
 * viewport's HUD `<svg>`; positions are pushed every rendered frame through the imperative handle
 * (no React re-render per frame).
 */

export type OrbitBodyId = 'sun' | 'earth';

export interface OrbitBodyFrame {
  state: BodyScreenState;
  /** Projected centre of the body, px. */
  x: number;
  y: number;
  /** On-screen radius of the drawn disc, px. */
  radiusPx: number;
  /** Unit screen vector from the Moon's centre to the body (0,0 when they coincide). */
  outX: number;
  outY: number;
  /** Where to pin the edge indicator when the body is outside the view. */
  edge: EdgePlacement;
}

export interface OrbitArrowFrame {
  visible: boolean;
  /** Projected polyline from the site toward the body, px. */
  points: Array<[number, number]>;
}

export interface OrbitPointFrame {
  visible: boolean;
  x: number;
  y: number;
}

export interface OrbitOverlayFrame {
  width: number;
  height: number;
  sun: OrbitBodyFrame;
  earth: OrbitBodyFrame;
  sunArrow: OrbitArrowFrame;
  earthArrow: OrbitArrowFrame;
  subSolar: OrbitPointFrame;
  subEarth: OrbitPointFrame;
}

export interface OrbitOverlayHandle {
  update(frame: OrbitOverlayFrame): void;
  hide(): void;
}

const BODY_NAME: Record<OrbitBodyId, string> = { sun: 'Sun', earth: 'Earth' };

const setVisible = (el: Element | null, visible: boolean) => {
  if (el) el.setAttribute('visibility', visible ? 'visible' : 'hidden');
};

const fmt = (n: number) => n.toFixed(1);

function placeBodyLabel(el: SVGGElement | null, body: OrbitBodyFrame, frame: OrbitOverlayFrame) {
  if (!el) return;
  if (body.state !== 'visible') {
    setVisible(el, false);
    return;
  }
  const gap = body.radiusPx + 9;
  let x = body.x;
  let y = body.y;
  let anchor: 'start' | 'middle' | 'end' = 'middle';
  if (Math.abs(body.outX) >= Math.abs(body.outY)) {
    // Body beside the Moon: label under it (over it when it sits low in the view).
    const above = body.y > frame.height * 0.72;
    y = above ? body.y - gap - 19 : body.y + gap + 9;
  } else {
    // Body above or below the Moon: label beside it.
    const leftSide = body.x > frame.width * 0.72;
    anchor = leftSide ? 'end' : 'start';
    x = body.x + (leftSide ? -gap : gap);
    y = body.y - 3;
  }
  // Keep the whole two-line label (about 76 px wide) inside the viewport.
  const roomLeft = anchor === 'start' ? 6 : anchor === 'middle' ? 42 : 80;
  const roomRight = anchor === 'end' ? 6 : anchor === 'middle' ? 42 : 80;
  x = Math.max(roomLeft, Math.min(frame.width - roomRight, x));
  el.setAttribute('transform', `translate(${fmt(x)}, ${fmt(y)})`);
  el.setAttribute('text-anchor', anchor);
  setVisible(el, true);
}

function placeGhost(el: SVGGElement | null, body: OrbitBodyFrame) {
  if (!el) return;
  if (body.state !== 'behind-moon') {
    setVisible(el, false);
    return;
  }
  el.setAttribute('transform', `translate(${fmt(body.x)}, ${fmt(body.y)})`);
  const ring = el.querySelector('circle');
  const r = Math.max(9, body.radiusPx);
  if (ring) ring.setAttribute('r', fmt(r));
  const text = el.querySelector('text');
  if (text) text.setAttribute('y', fmt(r + 15));
  setVisible(el, true);
}

function placeEdge(el: SVGGElement | null, body: OrbitBodyFrame, nudge: number) {
  if (!el) return;
  if (body.state !== 'offscreen' && body.state !== 'covered') {
    setVisible(el, false);
    el.setAttribute('tabindex', '-1');
    return;
  }
  const rad = (body.edge.angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  // Slide along the edge when both indicators would land on the same spot.
  const x = body.edge.x - uy * nudge;
  const y = body.edge.y + ux * nudge;
  el.setAttribute('transform', `translate(${fmt(x)}, ${fmt(y)})`);
  const chevron = el.querySelector('.orbit-edge-chevron');
  if (chevron) {
    // Distance from the pill centre to its border along the pointing direction, plus a small gap.
    const reach = Math.min(34 / Math.max(1e-6, Math.abs(ux)), 15 / Math.max(1e-6, Math.abs(uy))) + 11;
    chevron.setAttribute(
      'transform',
      `translate(${fmt(ux * reach)}, ${fmt(uy * reach)}) rotate(${fmt(body.edge.angleDeg)})`,
    );
  }
  el.setAttribute('tabindex', '0');
  setVisible(el, true);
}

function placeArrow(el: SVGGElement | null, arrow: OrbitArrowFrame) {
  if (!el) return;
  const pts = arrow.points;
  if (!arrow.visible || pts.length < 2) {
    setVisible(el, false);
    return;
  }
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p[0])} ${fmt(p[1])}`).join(' ');
  el.querySelectorAll('path').forEach((path) => path.setAttribute('d', d));
  const tip = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const ang = (Math.atan2(tip[1] - prev[1], tip[0] - prev[0]) * 180) / Math.PI;
  const head = el.querySelector('polygon');
  if (head) head.setAttribute('transform', `translate(${fmt(tip[0])}, ${fmt(tip[1])}) rotate(${fmt(ang)})`);
  const text = el.querySelector('text');
  if (text) {
    const len = Math.hypot(tip[0] - prev[0], tip[1] - prev[1]) || 1;
    const ux = (tip[0] - prev[0]) / len;
    const uy = (tip[1] - prev[1]) / len;
    text.setAttribute('x', fmt(tip[0] + ux * 13));
    text.setAttribute('y', fmt(tip[1] + uy * 13 + 3.5));
    text.setAttribute('text-anchor', ux > 0.35 ? 'start' : ux < -0.35 ? 'end' : 'middle');
  }
  setVisible(el, true);
}

function placePoint(el: SVGGElement | null, point: OrbitPointFrame) {
  if (!el) return;
  if (!point.visible) {
    setVisible(el, false);
    return;
  }
  el.setAttribute('transform', `translate(${fmt(point.x)}, ${fmt(point.y)})`);
  setVisible(el, true);
}

interface OrbitBodiesOverlayProps {
  /** Called when an edge indicator is activated: bring both bodies back into view. */
  onShowBodies: () => void;
}

export const OrbitBodiesOverlay = forwardRef<OrbitOverlayHandle, OrbitBodiesOverlayProps>(
  function OrbitBodiesOverlay({ onShowBodies }, ref) {
    const labelRefs = useRef<Record<OrbitBodyId, SVGGElement | null>>({ sun: null, earth: null });
    const ghostRefs = useRef<Record<OrbitBodyId, SVGGElement | null>>({ sun: null, earth: null });
    const edgeRefs = useRef<Record<OrbitBodyId, SVGGElement | null>>({ sun: null, earth: null });
    const arrowRefs = useRef<Record<OrbitBodyId, SVGGElement | null>>({ sun: null, earth: null });
    const pointRefs = useRef<Record<OrbitBodyId, SVGGElement | null>>({ sun: null, earth: null });

    useImperativeHandle(
      ref,
      () => ({
        update(frame) {
          placeArrow(arrowRefs.current.sun, frame.sunArrow);
          placeArrow(arrowRefs.current.earth, frame.earthArrow);
          placePoint(pointRefs.current.sun, frame.subSolar);
          placePoint(pointRefs.current.earth, frame.subEarth);
          placeBodyLabel(labelRefs.current.sun, frame.sun, frame);
          placeBodyLabel(labelRefs.current.earth, frame.earth, frame);
          placeGhost(ghostRefs.current.sun, frame.sun);
          placeGhost(ghostRefs.current.earth, frame.earth);
          const isOff = (b: OrbitBodyFrame) => b.state === 'offscreen' || b.state === 'covered';
          const bothOff = isOff(frame.sun) && isOff(frame.earth);
          const close =
            bothOff &&
            Math.abs(frame.sun.edge.x - frame.earth.edge.x) < 84 &&
            Math.abs(frame.sun.edge.y - frame.earth.edge.y) < 40;
          placeEdge(edgeRefs.current.sun, frame.sun, close ? -24 : 0);
          placeEdge(edgeRefs.current.earth, frame.earth, close ? 24 : 0);
        },
        hide() {
          for (const id of ['sun', 'earth'] as const) {
            setVisible(labelRefs.current[id], false);
            setVisible(ghostRefs.current[id], false);
            setVisible(edgeRefs.current[id], false);
            setVisible(arrowRefs.current[id], false);
            setVisible(pointRefs.current[id], false);
          }
        },
      }),
      [],
    );

    const bodies: OrbitBodyId[] = ['sun', 'earth'];

    return (
      <g className="orbit-overlay" data-testid="orbit-bodies-overlay">
        {bodies.map((id) => (
          <g
            key={`arrow-${id}`}
            ref={(el) => {
              arrowRefs.current[id] = el;
            }}
            className={`orbit-arrow orbit-arrow-${id}`}
            visibility="hidden"
            pointerEvents="none"
          >
            <path className="orbit-arrow-halo" />
            <path className="orbit-arrow-line" />
            <polygon className="orbit-arrow-head" points="5,0 -6,-5 -3.5,0 -6,5" />
            <text className="orbit-arrow-label">{`to ${BODY_NAME[id]}`}</text>
          </g>
        ))}

        {bodies.map((id) => (
          <g
            key={`point-${id}`}
            ref={(el) => {
              pointRefs.current[id] = el;
            }}
            className={`orbit-subpoint orbit-subpoint-${id}`}
            visibility="hidden"
            pointerEvents="none"
          >
            <circle className="orbit-subpoint-ring" r={7} />
            <circle className="orbit-subpoint-dot" r={2} />
            <text className="orbit-subpoint-label" x={11} y={4}>
              {`${BODY_NAME[id]} overhead`}
            </text>
          </g>
        ))}

        {bodies.map((id) => (
          <g
            key={`ghost-${id}`}
            ref={(el) => {
              ghostRefs.current[id] = el;
            }}
            className={`orbit-ghost orbit-ghost-${id}`}
            visibility="hidden"
            pointerEvents="none"
          >
            <circle r={10} />
            <text textAnchor="middle" y={25}>{`${BODY_NAME[id]} · behind the Moon`}</text>
          </g>
        ))}

        {bodies.map((id) => (
          <g
            key={`label-${id}`}
            ref={(el) => {
              labelRefs.current[id] = el;
            }}
            className={`orbit-body-label orbit-body-label-${id}`}
            visibility="hidden"
            pointerEvents="none"
          >
            <text className="orbit-body-name">{BODY_NAME[id]}</text>
            <text className="orbit-body-note" y={13}>
              not to scale
            </text>
          </g>
        ))}

        {bodies.map((id) => (
          <g
            key={`edge-${id}`}
            ref={(el) => {
              edgeRefs.current[id] = el;
            }}
            className={`orbit-edge orbit-edge-${id} overlay-pointer-target`}
            visibility="hidden"
            role="button"
            tabIndex={-1}
            aria-label={`${BODY_NAME[id]} is in this direction, outside or hidden in this view. Show the whole Moon with the Sun and the Earth.`}
            onClick={(e) => {
              e.stopPropagation();
              onShowBodies();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onShowBodies();
              }
            }}
          >
            <rect className="orbit-edge-pill" x={-34} y={-15} width={68} height={30} rx={3} />
            <circle className="orbit-edge-dot" cx={-21} cy={0} r={4.5} />
            <text className="orbit-edge-text" x={-11} y={4}>
              {BODY_NAME[id]}
            </text>
            <path className="orbit-edge-chevron" d="M-6 -8.5 L7.5 0 L-6 8.5 L-2.5 0 Z" />
            <title>{`${BODY_NAME[id]} is in this direction (outside or hidden in this view). Click to show the whole Moon with the Sun and the Earth.`}</title>
          </g>
        ))}
      </g>
    );
  },
);

function formatSubPoint(p: SubPoint): string {
  const lat = `${Math.abs(p.latDeg).toFixed(1)}°${p.latDeg < 0 ? 'S' : 'N'}`;
  const lonS = signedLonDeg(p.lonEastDeg);
  const lon = `${Math.abs(lonS).toFixed(1)}°${lonS < 0 ? 'W' : 'E'}`;
  return `${lat} ${lon}`;
}

interface OrbitSkyLegendProps {
  /** Sub-solar and sub-Earth points of the displayed epoch (null when the dataset has none). */
  sun: SubPoint | null;
  earth: SubPoint | null;
}

/** Small key explaining what the Sun and the Earth on the globe are (and are not). */
export const OrbitSkyLegend: React.FC<OrbitSkyLegendProps> = ({ sun, earth }) => {
  if (!sun || !earth) return null;
  return (
    <div className="orbit-legend" role="note" aria-label="Sun and Earth on the globe">
      <div className="orbit-legend-row">
        <span className="orbit-legend-swatch orbit-legend-swatch-sun" aria-hidden="true" />
        <span className="orbit-legend-name">Sun</span>
        <span className="orbit-legend-value">overhead at {formatSubPoint(sun)}</span>
      </div>
      <div className="orbit-legend-row">
        <span className="orbit-legend-swatch orbit-legend-swatch-earth" aria-hidden="true" />
        <span className="orbit-legend-name">Earth</span>
        <span className="orbit-legend-value">overhead at {formatSubPoint(earth)}</span>
      </div>
      <p className="orbit-legend-note">
        True directions for this date; sizes and distances are not to scale. Both stay near the
        Moon&rsquo;s equator, so from the south pole they sit low on the horizon.
      </p>
    </div>
  );
};
