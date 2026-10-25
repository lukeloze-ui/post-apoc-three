// Draws the player's marks in a pencil-grey, hand-drawn look. Canvas2D only. The wobble is seeded by mark id and
// point index, so a mark looks the same every frame and at every zoom (its size in pixels does not change).
import type { Marks, Mark, Pt } from './marks';
import { toPx, type MapView, type MarksLayer } from './renderMap';

const PENCIL = '#4b4c52';
const WOBBLE_PX = 0.7;
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

function drawMark(ctx: CanvasRenderingContext2D, view: MapView, m: Mark): void {
  switch (m.kind) {
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
export function createMarksLayer(marks: Marks, preview?: () => Mark | undefined): MarksLayer {
  return (ctx, view) => {
    for (const m of marks.all) drawMark(ctx, view, m);
    const p = preview?.();
    if (p) drawMark(ctx, view, p);
  };
}
