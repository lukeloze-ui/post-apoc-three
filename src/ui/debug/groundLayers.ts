// Debug layer for the ground debris (public/world/ground/): walls, hedge banks, rubble, cars, trunks and wrack.
// Drawn only when zoomed in; tiles in view are fetched through the ground cache and appear once loaded.
import { BARRIER_BROKEN, type GroundCache, type GroundObject, type GroundTile } from '../../world/ground';
import { TILES_PER_SIDE, TILE_M, tileId } from '../../world/terrain';
import { registerDebugLayer, type DebugViewport } from './overheadView';

/** Draw ground objects at this zoom and closer, pixels per metre. */
export const GROUND_MIN_SCALE = 0.4;
const HOVER_PX = 6;
const CAR_WIDTH_M = 1.8;

const COLOR: Record<string, string> = {
  wall: '#d8d8d8',
  hedgebank: '#58c03c',
  rubble: '#b0703c',
  car: '#ff3b3b',
  trunk: '#8a5a2b',
  wrack: '#e0c060',
};
const BROKEN_COLOR: Record<string, string> = { wall: '#7a6f66', hedgebank: '#8a7a3a' };

/** Tile ids overlapping the viewport. */
function tilesInView(view: DebugViewport): string[] {
  const a = view.toLocal(0, view.height);
  const b = view.toLocal(view.width, 0);
  const out: string[] = [];
  const i0 = Math.max(0, Math.floor(a.x / TILE_M));
  const i1 = Math.min(TILES_PER_SIDE - 1, Math.floor(b.x / TILE_M));
  const j0 = Math.max(0, Math.floor(a.y / TILE_M));
  const j1 = Math.min(TILES_PER_SIDE - 1, Math.floor(b.y / TILE_M));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push(tileId(i, j));
  return out;
}

/** Registers the ground layer. Returns `load`, which resolves once the given tiles are drawable. */
export function registerGroundLayer(cache: GroundCache): { load(tiles: readonly string[]): Promise<void> } {
  const loaded = new Map<string, GroundTile>();
  const fetch = (tile: string): Promise<void> =>
    cache.get(tile).then(
      (t) => void loaded.set(tile, t),
      (err: unknown) => console.warn(`[debug] ground ${tile}:`, err),
    );
  const inView = (view: DebugViewport): GroundTile[] => {
    const out: GroundTile[] = [];
    for (const id of tilesInView(view)) {
      const t = loaded.get(id);
      if (t) out.push(t);
      else if (!cache.has(id)) void fetch(id);
    }
    return out;
  };

  const drawObject = (ctx: CanvasRenderingContext2D, view: DebugViewport, o: GroundObject): void => {
    const { px, py } = view.toPx(o.x, o.y);
    const s = view.scale;
    // Canvas y runs down: a heading clockwise from north is a canvas rotation by the same angle from -y.
    const ux = Math.sin(o.rot);
    const uy = -Math.cos(o.rot);
    const broken = o.extra === BARRIER_BROKEN;
    ctx.strokeStyle = ctx.fillStyle = (broken && BROKEN_COLOR[o.kind]) || COLOR[o.kind] || '#fff';
    switch (o.kind) {
      case 'wall':
      case 'hedgebank': {
        const h = (o.size / 2) * s;
        ctx.lineWidth = Math.max(1, (o.kind === 'wall' ? 0.6 : 2) * s);
        ctx.setLineDash(broken ? [Math.max(2, 1.5 * s), Math.max(2, 1.5 * s)] : []);
        ctx.beginPath();
        ctx.moveTo(px - ux * h, py - uy * h);
        ctx.lineTo(px + ux * h, py + uy * h);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'trunk': {
        // From the root plate at (x, y) towards the crown.
        ctx.lineWidth = Math.max(1, 0.6 * s);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + ux * o.size * s, py + uy * o.size * s);
        ctx.stroke();
        break;
      }
      case 'car': {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(o.rot);
        const w = Math.max(2, CAR_WIDTH_M * s);
        const l = Math.max(3, o.size * s);
        ctx.fillRect(-w / 2, -l / 2, w, l);
        ctx.restore();
        break;
      }
      default: {
        const r = Math.max(1.5, (o.size / 2) * s);
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        if (o.kind === 'rubble') ctx.rect(px - r, py - r, 2 * r, 2 * r);
        else ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  };

  registerDebugLayer({
    id: 'g-debris',
    label: `Ground debris (zoom in; wall, hedge, rubble, car, trunk, wrack)`,
    defaultOn: true,
    draw(ctx, view) {
      if (view.scale < GROUND_MIN_SCALE) return;
      ctx.save();
      for (const t of inView(view)) for (const o of t.objects) drawObject(ctx, view, o);
      ctx.restore();
    },
    hover(view, x, y) {
      if (view.scale < GROUND_MIN_SCALE) return undefined;
      const tol = HOVER_PX / view.scale;
      let best: GroundObject | undefined;
      let bestD = Infinity;
      for (const t of inView(view)) {
        for (const o of t.objects) {
          const d = Math.max(0, Math.hypot(o.x - x, o.y - y) - o.size / 2);
          if (d <= tol && d < bestD) {
            bestD = d;
            best = o;
          }
        }
      }
      if (!best) return undefined;
      const state = best.kind === 'wall' || best.kind === 'hedgebank' ? (best.extra === BARRIER_BROKEN ? ' broken' : ' standing') : '';
      return `ground ${best.key}: ${best.kind}${state} size=${best.size.toFixed(1)} m rot=${((best.rot * 180) / Math.PI).toFixed(0)}°`;
    },
  });

  return { load: async (tiles) => void (await Promise.all(tiles.map(fetch))) };
}
