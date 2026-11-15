import * as THREE from 'three';
import { makeRng } from './propsGeometry';

/**
 * Procedural canvas textures for the moonbase props (no downloads). Every generator returns
 * null when a 2D canvas is unavailable (jsdom, workers): callers fall back to plain colours.
 */

type Ctx = CanvasRenderingContext2D;

export function make2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  if (typeof document === 'undefined') return null;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return { canvas, ctx };
  } catch {
    return null;
  }
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------
// painting helpers (all coordinates in a 1024-unit design space; the context is pre-scaled)

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function speckle(
  ctx: Ctx,
  rand: () => number,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
  colors: string[],
  alpha: [number, number],
  size: [number, number],
) {
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = alpha[0] + rand() * (alpha[1] - alpha[0]);
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const s = size[0] + rand() * (size[1] - size[0]);
    ctx.fillRect(x + rand() * w, y + rand() * h, s, s * (0.5 + rand()));
  }
  ctx.globalAlpha = 1;
}

function smudges(
  ctx: Ctx,
  rand: () => number,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
  rgb: string,
  maxAlpha: number,
  radius: [number, number],
  biasBottom = 0,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let i = 0; i < count; i++) {
    const cx = x + rand() * w;
    const t = biasBottom > 0 ? 1 - Math.pow(rand(), 1 + biasBottom * 2) : rand();
    const cy = y + t * h;
    const r = radius[0] + rand() * (radius[1] - radius[0]);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const a = maxAlpha * (0.3 + rand() * 0.7);
    g.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  ctx.restore();
}

function scratches(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number, count: number, color: string, alpha: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = alpha * (0.3 + rand() * 0.7);
    ctx.lineWidth = 0.6 + rand() * 1.6;
    const sx = x + rand() * w;
    const sy = y + rand() * h;
    const len = 6 + rand() * 40;
    const ang = rand() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function hazardStripes(ctx: Ctx, x: number, y: number, w: number, h: number, stripe: number, a: string, b: string, alongX = false) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = b;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = a;
  const span = w + h;
  for (let s = -span; s < span; s += stripe * 2) {
    ctx.beginPath();
    if (alongX) {
      ctx.moveTo(x + s, y + h);
      ctx.lineTo(x + s + stripe, y + h);
      ctx.lineTo(x + s + stripe + h, y);
      ctx.lineTo(x + s + h, y);
    } else {
      ctx.moveTo(x, y + s);
      ctx.lineTo(x, y + s + stripe);
      ctx.lineTo(x + w, y + s + stripe + w);
      ctx.lineTo(x + w, y + s + w);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Irregular painted band along the inside of a rectangle's border (chipped paint look). */
function chippedBorder(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number, thick: number, color: string) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = color;
  const side = (len: number, draw: (t: number, d: number) => [number, number]) => {
    const steps = Math.max(8, Math.round(len / 9));
    ctx.beginPath();
    const [sx0, sy0] = draw(0, 0);
    ctx.moveTo(sx0, sy0);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const notch = rand() < 0.12 ? 0.25 : 1;
      const d = thick * notch * (0.55 + rand() * 0.9);
      const [px, py] = draw(t, d);
      ctx.lineTo(px, py);
    }
    const [ex, ey] = draw(1, 0);
    ctx.lineTo(ex, ey);
    ctx.closePath();
    ctx.fill();
  };
  side(w, (t, d) => [x + t * w, y + d]);
  side(w, (t, d) => [x + t * w, y + h - d]);
  side(h, (t, d) => [x + d, y + t * h]);
  side(h, (t, d) => [x + w - d, y + t * h]);
  // chips and scuffs near the edges
  for (let i = 0; i < Math.round((w + h) / 14); i++) {
    const edge = Math.floor(rand() * 4);
    const t = rand();
    const d = thick * (0.8 + rand() * 2.2);
    const px = edge === 0 || edge === 1 ? x + t * w : edge === 2 ? x + d : x + w - d;
    const py = edge === 2 || edge === 3 ? y + t * h : edge === 0 ? y + d : y + h - d;
    const r = 1.5 + rand() * thick * 0.45;
    ctx.globalAlpha = 0.5 + rand() * 0.5;
    ctx.beginPath();
    ctx.ellipse(px, py, r * (0.6 + rand()), r * (0.4 + rand() * 0.8), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function textLines(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number, n: number, color: string) {
  ctx.fillStyle = color;
  const lh = h / n;
  for (let i = 0; i < n; i++) {
    let cx = x;
    const end = x + w * (0.55 + rand() * 0.45);
    while (cx < end) {
      const word = 6 + rand() * 26;
      ctx.fillRect(cx, y + i * lh + lh * 0.2, Math.min(word, end - cx), lh * 0.55);
      cx += word + 4 + rand() * 4;
    }
  }
}

/** Yellow warning label with red header band and grungy text (white containers, t18.5). */
function warningLabel(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number) {
  rect(ctx, x - 3, y - 3, w + 6, h + 6, '#5b5a55');
  rect(ctx, x, y, w, h, '#e4cb52');
  rect(ctx, x, y, w, h * 0.13, '#c8372d');
  rect(ctx, x, y + h * 0.13, w, h * 0.03, '#f4e7a0');
  textLines(ctx, rand, x + w * 0.07, y + h * 0.22, w * 0.86, h * 0.7, 6, '#2b2620');
  speckle(ctx, rand, x, y, w, h, 260, ['#ffffff', '#f2f0e0', '#3a352c'], [0.25, 0.8], [1, 4]);
  smudges(ctx, rand, x, y, w, h, 6, '70,60,40', 0.35, [8, 30]);
}

/** Small white "danger" sticker with a yellow triangle (dark crates, f_041). */
function dangerSticker(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number) {
  rect(ctx, x, y, w, h, '#e9e9e4');
  ctx.fillStyle = '#e1c13d';
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 3;
  const tx = x + h * 0.15;
  const ts = h * 0.72;
  ctx.beginPath();
  ctx.moveTo(tx + ts / 2, y + h * 0.12);
  ctx.lineTo(tx + ts, y + h * 0.12 + ts);
  ctx.lineTo(tx, y + h * 0.12 + ts);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  rect(ctx, tx + ts / 2 - 2, y + h * 0.35, 4, ts * 0.35, '#1a1a1a');
  textLines(ctx, rand, x + h * 1.05, y + h * 0.18, w - h * 1.2, h * 0.65, 3, '#1c1c1c');
  speckle(ctx, rand, x, y, w, h, 60, ['#8a8a85', '#ffffff'], [0.2, 0.6], [1, 3]);
}

function bevelFrame(ctx: Ctx, x: number, y: number, w: number, h: number, dark: string, light: string, width: number) {
  ctx.lineWidth = width;
  ctx.strokeStyle = dark;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  ctx.strokeStyle = light;
  ctx.beginPath();
  ctx.moveTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.stroke();
}

function baseFill(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number, base: string, light: string, dark: string, density = 1) {
  rect(ctx, x, y, w, h, base);
  speckle(ctx, rand, x, y, w, h, Math.round(w * h * 0.004 * density), [light, dark], [0.04, 0.14], [1, 5]);
  smudges(ctx, rand, x, y, w, h, Math.round(8 * density), dark === '#000000' ? '0,0,0' : '90,90,90', 0.05, [30, 120]);
}

// ---------------------------------------------------------------------------------------------
// crate atlases. Layout (1024 design units, canvas y down):
//   FRONT  (0,0)-(1024,512)      long faces (±Z)       — region top = crate top
//   END    (0,512)-(512,1024)    short faces (±X)
//   TOP    (512,512)-(1024,768)  top/bottom (±Y)       — region left = -X, region top = -Z
//   STRIP  (512,768)-(1024,1024) corner posts: x runs along the post height (bottom → top)

export type CrateStyle = 'hazard' | 'row' | 'dark';

function paintHazard(ctx: Ctx, rand: () => number) {
  // FRONT
  baseFill(ctx, rand, 0, 0, 1024, 512, '#d8d8d4', '#f4f4f0', '#8c8c88', 1.2);
  smudges(ctx, rand, 0, 300, 1024, 212, 14, '95,88,78', 0.14, [40, 140], 1);
  bevelFrame(ctx, 8, 8, 1008, 496, '#f3f3ef', '#7f807e', 8);
  ctx.strokeStyle = '#6e6f6d';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, 984, 472);
  for (const sx of [88, 892]) {
    rect(ctx, sx - 4, 46, 52, 420, '#5d5e5c');
    hazardStripes(ctx, sx, 50, 44, 412, 20, '#dcc24a', '#3b3b3d');
    speckle(ctx, rand, sx, 50, 44, 412, 90, ['#f4f4ee', '#1d1d1d'], [0.2, 0.7], [1, 4]);
  }
  ctx.strokeStyle = '#4a4b4a';
  ctx.lineWidth = 5;
  for (const [cx, cy, dx, dy] of [
    [40, 40, 1, 1],
    [984, 40, -1, 1],
    [40, 472, 1, -1],
    [984, 472, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * 26, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * 26);
    ctx.stroke();
  }
  for (const [cx, dir] of [
    [158, 1],
    [866, -1],
  ] as const) {
    for (const cy of [80, 432]) {
      ctx.beginPath();
      ctx.moveTo(cx + dir * 12, cy - 12);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dir * 12, cy + 12);
      ctx.stroke();
    }
  }
  warningLabel(ctx, rand, 392, 84, 240, 150);
  roundRectPath(ctx, 366, 278, 292, 170, 16);
  ctx.fillStyle = '#cbcbc7';
  ctx.fill();
  bevelFrame(ctx, 368, 280, 288, 166, '#7a7b79', '#f1f1ed', 4);
  roundRectPath(ctx, 452, 298, 120, 24, 10);
  ctx.fillStyle = '#29292b';
  ctx.fill();
  rect(ctx, 458, 322, 108, 3, '#f0f0ec');
  textLines(ctx, rand, 760, 430, 110, 34, 2, '#55565a');
  scratches(ctx, rand, 0, 0, 1024, 512, 60, '#5a5a58', 0.35);
  smudges(ctx, rand, 0, 0, 1024, 512, 10, '40,38,35', 0.1, [20, 70]);

  // END
  // light frame around a dark recessed end panel with white diagonal braces (t17/t18.5)
  baseFill(ctx, rand, 0, 512, 512, 512, '#d3d3cf', '#f0f0ec', '#878784', 1.2);
  bevelFrame(ctx, 8, 520, 496, 496, '#f1f1ed', '#7b7c7a', 8);
  for (const sx of [30, 450]) {
    rect(ctx, sx - 3, 556, 38, 424, '#5d5e5c');
    hazardStripes(ctx, sx, 560, 32, 416, 18, '#d8d8d2', '#2b2b2d');
    speckle(ctx, rand, sx, 560, 32, 416, 60, ['#f4f4ee', '#1d1d1d'], [0.2, 0.7], [1, 4]);
  }
  roundRectPath(ctx, 84, 566, 344, 404, 16);
  ctx.fillStyle = '#3a3b3f';
  ctx.fill();
  bevelFrame(ctx, 86, 568, 340, 400, '#1f2023', '#9fa1a4', 6);
  ctx.save();
  roundRectPath(ctx, 92, 574, 328, 388, 12);
  ctx.clip();
  ctx.strokeStyle = '#d9d9d4';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.moveTo(92, 600);
  ctx.lineTo(256, 768);
  ctx.lineTo(420, 600);
  ctx.moveTo(92, 936);
  ctx.lineTo(256, 768);
  ctx.lineTo(420, 936);
  ctx.stroke();
  ctx.restore();
  rect(ctx, 214, 744, 84, 48, '#c9c9c5');
  rect(ctx, 226, 760, 60, 14, '#2a2b2d');
  speckle(ctx, rand, 84, 566, 344, 404, 140, ['#e9e9e4', '#111113'], [0.2, 0.7], [1, 4]);
  smudges(ctx, rand, 0, 512, 512, 512, 12, '70,66,60', 0.15, [30, 100], 1);
  scratches(ctx, rand, 0, 512, 512, 512, 30, '#5a5a58', 0.35);

  // TOP
  baseFill(ctx, rand, 512, 512, 512, 256, '#d6d6d2', '#f4f4f0', '#8a8a87', 1.2);
  bevelFrame(ctx, 518, 518, 500, 244, '#f3f3ef', '#80817f', 6);
  roundRectPath(ctx, 660, 596, 216, 88, 10);
  ctx.fillStyle = '#3a3b3e';
  ctx.fill();
  rect(ctx, 676, 664, 184, 8, '#76787c');
  for (const [bx, by] of [
    [540, 540],
    [988, 540],
    [540, 736],
    [988, 736],
  ])
    rect(ctx, bx - 5, by - 5, 10, 10, '#6c6d6b');
  smudges(ctx, rand, 512, 512, 512, 256, 10, '80,75,68', 0.16, [20, 80]);

  // STRIP (unused by this style, painted as hazard stripes for safety)
  hazardStripes(ctx, 512, 768, 512, 256, 26, '#dcc24a', '#3b3b3d', true);
}

function paintRow(ctx: Ctx, rand: () => number) {
  // FRONT
  baseFill(ctx, rand, 0, 0, 1024, 512, '#dadbd8', '#f6f6f3', '#8e8f8c', 1);
  rect(ctx, 0, 0, 1024, 60, '#c6c7c4');
  rect(ctx, 0, 452, 1024, 60, '#bdbebb');
  rect(ctx, 0, 0, 40, 512, '#c3c4c1');
  rect(ctx, 984, 0, 40, 512, '#c3c4c1');
  ctx.strokeStyle = '#767775';
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 60, 944, 392);
  ctx.strokeStyle = '#f5f5f2';
  ctx.lineWidth = 2;
  ctx.strokeRect(45, 65, 934, 382);
  const panel = (px: number, diag: boolean) => {
    const py = 136;
    const s = 240;
    roundRectPath(ctx, px, py, s, s, 10);
    ctx.fillStyle = '#bfc0bf';
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#6a6b6d';
    ctx.stroke();
    bevelFrame(ctx, px + 8, py + 8, s - 16, s - 16, '#8b8c8d', '#e9eae7', 4);
    if (diag) {
      ctx.beginPath();
      ctx.moveTo(px + 22, py + s - 58);
      ctx.lineTo(px + s - 58, py + 22);
      ctx.lineTo(px + s - 22, py + 58);
      ctx.lineTo(px + 58, py + s - 22);
      ctx.closePath();
      ctx.fillStyle = '#e8e9e6';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#6d6e70';
      ctx.stroke();
    }
  };
  panel(88, true);
  panel(696, true);
  roundRectPath(ctx, 392, 136, 240, 240, 34);
  ctx.fillStyle = '#c9cac8';
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#6a6b6d';
  ctx.stroke();
  roundRectPath(ctx, 446, 196, 132, 70, 20);
  ctx.fillStyle = '#e4e5e2';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#58595b';
  ctx.stroke();
  roundRectPath(ctx, 470, 218, 84, 24, 10);
  ctx.fillStyle = '#38393b';
  ctx.fill();
  textLines(ctx, rand, 448, 300, 128, 40, 2, '#7b7c7e');
  smudges(ctx, rand, 0, 0, 1024, 512, 16, '85,80,72', 0.12, [30, 120], 0.6);
  scratches(ctx, rand, 0, 0, 1024, 512, 40, '#6a6a68', 0.3);

  // END (darker metal, vertical slots)
  baseFill(ctx, rand, 0, 512, 512, 512, '#8e9092', '#b5b7b9', '#4e5052', 1);
  rect(ctx, 0, 512, 512, 46, '#a9abad');
  rect(ctx, 0, 978, 512, 46, '#a3a5a7');
  for (const px of [96, 290]) {
    roundRectPath(ctx, px, 600, 126, 336, 12);
    ctx.fillStyle = '#383a3e';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#d4d5d3';
    ctx.stroke();
    for (let k = 0; k < 4; k++) rect(ctx, px + 20, 640 + k * 76, 86, 10, '#55585c');
  }
  smudges(ctx, rand, 0, 512, 512, 512, 8, '30,30,30', 0.15, [30, 90]);

  // TOP
  baseFill(ctx, rand, 512, 512, 512, 256, '#d7d8d5', '#f5f5f2', '#8d8e8b', 1);
  rect(ctx, 512, 512, 512, 30, '#c4c5c2');
  rect(ctx, 512, 738, 512, 30, '#c4c5c2');
  for (const lx of [512 + 170, 512 + 342]) rect(ctx, lx, 542, 4, 196, '#8a8b89');
  for (let k = 0; k < 6; k++) rect(ctx, 512 + 220, 600 + k * 14, 72, 6, '#4b4c4e');
  smudges(ctx, rand, 512, 512, 512, 256, 8, '85,80,72', 0.14, [20, 70]);

  hazardStripes(ctx, 512, 768, 512, 256, 26, '#dcc24a', '#3b3b3d', true);
}

function paintDark(ctx: Ctx, rand: () => number) {
  const W = '#ecece6';
  // FRONT
  baseFill(ctx, rand, 0, 0, 1024, 512, '#222326', '#3a3b40', '#0c0c0e', 1.4);
  smudges(ctx, rand, 0, 0, 1024, 512, 14, '70,70,76', 0.12, [40, 160]);
  ctx.strokeStyle = '#34353a';
  ctx.lineWidth = 5;
  ctx.strokeRect(46, 46, 932, 420);
  // two low-contrast recessed panels (t01) with a faint emblem between them
  for (const px of [120, 600]) {
    roundRectPath(ctx, px, 110, 304, 290, 14);
    ctx.fillStyle = '#1d1e21';
    ctx.fill();
    bevelFrame(ctx, px + 3, 113, 298, 284, '#101012', '#45464c', 5);
  }
  ctx.fillStyle = '#2e2f34';
  ctx.beginPath();
  ctx.moveTo(512 - 46, 170);
  ctx.lineTo(512 + 46, 170);
  ctx.lineTo(512, 250);
  ctx.closePath();
  ctx.fill();
  dangerSticker(ctx, rand, 640, 408, 150, 52);
  chippedBorder(ctx, rand, 0, 0, 1024, 512, 15, W);
  scratches(ctx, rand, 0, 0, 1024, 512, 70, '#d8d8d2', 0.35);
  speckle(ctx, rand, 0, 0, 1024, 512, 160, [W], [0.3, 0.9], [1, 4]);

  // END
  baseFill(ctx, rand, 0, 512, 512, 512, '#212225', '#393a3f', '#0b0b0d', 1.4);
  ctx.strokeStyle = '#3b3c42';
  ctx.lineWidth = 6;
  ctx.strokeRect(66, 578, 380, 380);
  roundRectPath(ctx, 196, 700, 120, 34, 10);
  ctx.fillStyle = '#121214';
  ctx.fill();
  ctx.strokeStyle = '#5c5e63';
  ctx.lineWidth = 3;
  ctx.stroke();
  chippedBorder(ctx, rand, 0, 512, 512, 512, 18, W);
  scratches(ctx, rand, 0, 512, 512, 512, 40, '#d8d8d2', 0.35);
  speckle(ctx, rand, 0, 512, 512, 512, 90, [W], [0.3, 0.9], [1, 4]);

  // TOP
  baseFill(ctx, rand, 512, 512, 512, 256, '#26272a', '#3d3e43', '#0d0d0f', 1.4);
  ctx.strokeStyle = '#55575c';
  ctx.lineWidth = 4;
  ctx.strokeRect(512 + 46, 512 + 40, 420, 176);
  roundRectPath(ctx, 512 + 186, 512 + 112, 140, 28, 8);
  ctx.fillStyle = '#0f0f11';
  ctx.fill();
  rect(ctx, 512 + 190, 512 + 140, 132, 3, '#77797e');
  chippedBorder(ctx, rand, 512, 512, 512, 256, 12, W);
  speckle(ctx, rand, 512, 512, 512, 256, 70, [W], [0.25, 0.8], [1, 4]);

  // STRIP (corner posts): black + yellow stripes, chipped white edges along the post sides
  hazardStripes(ctx, 512, 768, 512, 256, 30, '#bba244', '#18181a', true);
  speckle(ctx, rand, 512, 768, 512, 256, 120, ['#0c0c0c', '#f1e7b8'], [0.2, 0.7], [1, 5]);
  chippedBorder(ctx, rand, 512, 768, 512, 256, 22, W);
}

/** Atlas texture for one crate style (1024² or 512² in low-power mode). */
export function crateAtlas(style: CrateStyle, lowPower: boolean, seed: number): THREE.Texture | null {
  const size = lowPower ? 512 : 1024;
  const c = make2d(size, size);
  if (!c) return null;
  const { canvas, ctx } = c;
  ctx.scale(size / 1024, size / 1024);
  const rand = makeRng(seed);
  if (style === 'hazard') paintHazard(ctx, rand);
  else if (style === 'row') paintRow(ctx, rand);
  else paintDark(ctx, rand);
  return toTexture(canvas, true, false);
}

// ---------------------------------------------------------------------------------------------
// ship hull panels: tiling greyscale (multiplies the lavender paint) + matching bump map.

export interface PanelMaps {
  map: THREE.Texture;
  bump: THREE.Texture;
}

export function hullPanelMaps(lowPower: boolean, seed: number): PanelMaps | null {
  const size = lowPower ? 512 : 1024;
  const col = make2d(size, size);
  const bmp = make2d(size, size);
  if (!col || !bmp) return null;
  const s = size / 1024;
  col.ctx.scale(s, s);
  bmp.ctx.scale(s, s);
  const rand = makeRng(seed);
  const C = col.ctx;
  const B = bmp.ctx;
  rect(C, 0, 0, 1024, 1024, '#ececec');
  rect(B, 0, 0, 1024, 1024, '#9a9a9a');

  // recursive panel subdivision of the tile (tile = 8 m, so 128 units per metre)
  const panels: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, h: number, depth: number) => {
    const canSplitX = w > 300;
    const canSplitY = h > 300;
    if (depth > 4 || (!canSplitX && !canSplitY) || (depth > 1 && rand() < 0.22)) {
      panels.push([x, y, w, h]);
      return;
    }
    const horiz = canSplitX && (!canSplitY || w > h * (0.8 + rand() * 0.6));
    const t = 0.3 + rand() * 0.4;
    if (horiz) {
      const cut = Math.round((w * t) / 32) * 32;
      split(x, y, cut, h, depth + 1);
      split(x + cut, y, w - cut, h, depth + 1);
    } else {
      const cut = Math.round((h * t) / 32) * 32;
      split(x, y, w, cut, depth + 1);
      split(x, y + cut, w, h - cut, depth + 1);
    }
  };
  split(0, 0, 1024, 1024, 0);
  for (const [x, y, w, h] of panels) {
    const v = 226 + Math.floor(rand() * 24);
    rect(C, x, y, w, h, `rgb(${v},${v},${v})`);
    const b = 150 + Math.floor(rand() * 10);
    rect(B, x, y, w, h, `rgb(${b},${b},${b})`);
    if (rand() < 0.12) {
      // inset hatch / access plate
      const iw = w * (0.25 + rand() * 0.35);
      const ih = h * (0.2 + rand() * 0.3);
      const ix = x + (w - iw) * rand();
      const iy = y + (h - ih) * rand();
      C.strokeStyle = 'rgba(70,70,78,0.55)';
      C.lineWidth = 3;
      C.strokeRect(ix, iy, iw, ih);
      B.strokeStyle = '#4a4a4a';
      B.lineWidth = 4;
      B.strokeRect(ix, iy, iw, ih);
    }
    if (rand() < 0.12) {
      // rivet rows
      const n = Math.max(3, Math.floor(w / 40));
      for (let i = 0; i < n; i++) {
        rect(C, x + 14 + i * ((w - 28) / n), y + 12, 4, 4, 'rgba(90,90,98,0.6)');
        rect(B, x + 14 + i * ((w - 28) / n), y + 12, 4, 4, '#c8c8c8');
      }
    }
  }
  // seams: dark groove + light lip
  for (const [x, y, w, h] of panels) {
    C.strokeStyle = 'rgba(52,52,60,0.9)';
    C.lineWidth = 4;
    C.strokeRect(x + 1, y + 1, w - 2, h - 2);
    C.strokeStyle = 'rgba(255,255,255,0.5)';
    C.lineWidth = 2;
    C.beginPath();
    C.moveTo(x + 5, y + h - 4);
    C.lineTo(x + 5, y + 5);
    C.lineTo(x + w - 4, y + 5);
    C.stroke();
    B.strokeStyle = '#000000';
    B.lineWidth = 7;
    B.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
  speckle(C, rand, 0, 0, 1024, 1024, 5000, ['#ffffff', '#7a7a84'], [0.03, 0.1], [1, 4]);
  smudges(C, rand, 0, 0, 1024, 1024, 26, '70,70,80', 0.07, [40, 200]);
  scratches(C, rand, 0, 0, 1024, 1024, 80, '#6d6d76', 0.25);
  return { map: toTexture(col.canvas, true, true), bump: toTexture(bmp.canvas, false, true) };
}

/** Subtle mottled detail for tanks (vertical streaks), tiling. */
export function tankDetailMap(lowPower: boolean, seed: number): THREE.Texture | null {
  const size = lowPower ? 256 : 512;
  const c = make2d(size, size);
  if (!c) return null;
  const { canvas, ctx } = c;
  ctx.scale(size / 512, size / 512);
  const rand = makeRng(seed);
  rect(ctx, 0, 0, 512, 512, '#efefef');
  for (let i = 0; i < 70; i++) {
    const x = rand() * 512;
    const w = 2 + rand() * 10;
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    const a = 0.03 + rand() * 0.07;
    g.addColorStop(0, `rgba(80,80,90,0)`);
    g.addColorStop(0.5 + rand() * 0.5, `rgba(80,80,90,${a.toFixed(3)})`);
    g.addColorStop(1, `rgba(80,80,90,${(a * 1.5).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, 512);
  }
  speckle(ctx, rand, 0, 0, 512, 512, 900, ['#ffffff', '#80808a'], [0.04, 0.12], [1, 3]);
  return toTexture(canvas, true, true);
}
