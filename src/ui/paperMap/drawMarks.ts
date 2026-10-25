// Draws the player's marks in a pencil-grey, hand-drawn look. Canvas2D only. The wobble is seeded by mark id and
// point index, so a mark looks the same every frame and at every zoom (its size in pixels does not change).
import type { Marks, Mark, Pt } from './marks';
import { toPx, type MapView, type MarksLayer } from './renderMap';

const PENCIL = '#4b4c52';
const WOBBLE_PX = 0.7;
const LABEL_FONT = '13px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
/** Text beside a leg, computed on every draw so it follows the pack. */
export type LegLabel = (pts: readonly Pt[]) => string;
export const NOTE_FONT = '15px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';

/** Deterministic value in -1..1. */
function jitter(id: number, i: number, axis: number): number {
  let h = (id * 374761393 + i * 668265263 + axis * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

type Px = { px: number; py: number };

function wobbly(view: MapView, id: number, pts: readonly Pt[], pass: number): Px[] {
  return pts.map((p, i) => {
    const q = toPx(view, p.x, p.y);
    return {
      px: q.px + jitter(id, i + pass * 101, 0) * WOBBLE_PX,
      py: q.py + jitter(id, i + pass * 101, 1) * WOBBLE_PX,
    };
  });
}

/** A smooth line through the points (midpoint quadratics). */
function smoothPath(ctx: CanvasRenderingContext2D, px: readonly Px[]): void {
  const first = px[0]!;
  const last = px[px.length - 1]!;
  ctx.beginPath();
  ctx.moveTo(first.px, first.py);
  for (let i = 1; i < px.length - 1; i++) {
    const p = px[i]!;
    const q = px[i + 1]!;
    ctx.quadraticCurveTo(p.px, p.py, (p.px + q.px) / 2, (p.py + q.py) / 2);
  }
  ctx.lineTo(last.px, last.py);
}

/** Two slightly different passes, the way pencil goes over a line. */
function pencilLine(ctx: CanvasRenderingContext2D, view: MapView, id: number, pts: readonly Pt[], width: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PENCIL;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = width;
  smoothPath(ctx, wobbly(view, id, pts, 0));
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = width * 0.6;
  smoothPath(ctx, wobbly(view, id, pts, 1));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Metres between tick marks along a leg; ticks are skipped when they would be closer than TICK_MIN_PX. */
const TICK_M = 250;
const TICK_MIN_PX = 8;

function drawLeg(ctx: CanvasRenderingContext2D, view: MapView, m: Mark & { kind: 'leg' }, label?: string): void {
  const pts = m.pts;
  if (pts.length >= 2) pencilLine(ctx, view, m.id, pts, 2.2);
  ctx.strokeStyle = PENCIL;
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.6;
  ctx.globalAlpha = 0.9;
  const tick = (a: Pt, b: Pt, t: number, half: number): void => {
    const c = toPx(view, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    const q = toPx(view, b.x, b.y);
    const p = toPx(view, a.x, a.y);
    const len = Math.hypot(q.px - p.px, q.py - p.py) || 1;
    const nx = -(q.py - p.py) / len;
    const ny = (q.px - p.px) / len;
    ctx.beginPath();
    ctx.moveTo(c.px - nx * half, c.py - ny * half);
    ctx.lineTo(c.px + nx * half, c.py + ny * half);
    ctx.stroke();
  };
  let along = 0;
  let nextTick = TICK_M;
  const spaced = TICK_M * view.scale >= TICK_MIN_PX;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    tick(a, b, 0, 6);
    while (spaced && len > 0 && nextTick <= along + len) {
      tick(a, b, (nextTick - along) / len, 3.5);
      nextTick += TICK_M;
    }
    along += len;
  }
  if (pts.length >= 2) tick(pts[pts.length - 2]!, pts[pts.length - 1]!, 1, 6);
  else {
    const c = toPx(view, pts[0]!.x, pts[0]!.y);
    ctx.beginPath();
    ctx.arc(c.px, c.py, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (label && pts.length >= 2) {
    // Beside the point halfway along the leg.
    let half = 0;
    for (let i = 0; i + 1 < pts.length; i++) half += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    half /= 2;
    let at = pts[0]!;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (half <= len) {
        const t = len === 0 ? 0 : half / len;
        at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        break;
      }
      half -= len;
    }
    const c = toPx(view, at.x, at.y);
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PENCIL;
    ctx.globalAlpha = 0.9;
    ctx.fillText(label, c.px + 10, c.py - 8);
    ctx.globalAlpha = 1;
  }
}

function drawMark(ctx: CanvasRenderingContext2D, view: MapView, m: Mark, legLabel?: LegLabel): void {
  switch (m.kind) {
    case 'leg':
      drawLeg(ctx, view, m, legLabel?.(m.pts));
      break;
    case 'stroke':
      pencilLine(ctx, view, m.id, m.pts, 2.2);
      break;
    case 'note': {
      const { px, py } = toPx(view, m.x, m.y);
      ctx.font = NOTE_FONT;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = PENCIL;
      ctx.globalAlpha = 0.9;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(jitter(m.id, 0, 2) * 0.03);
      ctx.fillText(m.text, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      break;
    }
    case 'cross': {
      const r = 7 + jitter(m.id, 0, 3);
      const c = toPx(view, m.x, m.y);
      const arm = (x0: number, y0: number, x1: number, y1: number, k: number): void => {
        const a = { px: c.px + x0 * r, py: c.py + y0 * r };
        const b = { px: c.px + x1 * r, py: c.py + y1 * r };
        ctx.lineCap = 'round';
        ctx.strokeStyle = PENCIL;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(a.px + jitter(m.id, k, 0), a.py + jitter(m.id, k, 1));
        ctx.lineTo(b.px + jitter(m.id, k + 1, 0), b.py + jitter(m.id, k + 1, 1));
        ctx.stroke();
        ctx.globalAlpha = 1;
      };
      arm(-1, -1, 1, 1, 10);
      arm(-1, 1, 1, -1, 20);
      break;
    }
    case 'strike':
      pencilLine(ctx, view, m.id, [m.a, m.b], 2.8);
      break;
  }
}

/** The marks layer for `renderMap`: over the map, under the scale bar and names. `preview` is drawn last (the stroke in progress). */
export function createMarksLayer(marks: Marks, preview?: () => Mark | undefined, legLabel?: LegLabel): MarksLayer {
  return (ctx, view) => {
    for (const m of marks.all) drawMark(ctx, view, m, legLabel);
    const p = preview?.();
    if (p) drawMark(ctx, view, p);
  };
}
