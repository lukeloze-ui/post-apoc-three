// The faint hint layer: small pencil dots on the paper map where the player saw something. No text, no kind.
// Separate from the player's marks. Positions only, so the map learns nothing about the damage.
import { toPx, type MapView, type MarksLayer } from './renderMap';

export interface HintPoint {
  x: number;
  y: number;
}

/** A layer drawing a faint dot at each point; `points` is read on every draw. */
export function createHintLayer(points: () => readonly HintPoint[]): MarksLayer {
  return (ctx: CanvasRenderingContext2D, view: MapView) => {
    const pts = points();
    if (pts.length === 0) return;
    ctx.save();
    ctx.fillStyle = 'rgba(70,62,52,0.35)';
    for (const p of pts) {
      const { px, py } = toPx(view, p.x, p.y);
      if (px < -8 || py < -8 || px > view.width + 8 || py > view.height + 8) continue;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
}
