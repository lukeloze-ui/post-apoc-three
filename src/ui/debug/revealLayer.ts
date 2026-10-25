// Debug layer for the reveal (src/sim/reveal.ts): which tiles show their district damage, and why.
// Visited tiles are blue, scope-revealed ones green, tiles in the scope's sight right now are outlined.
import type { Reveal } from '../../sim/reveal';
import { TILES_PER_SIDE, TILE_M, tileId, tileOf } from '../../world/terrain';
import { registerDebugLayer } from './overheadView';

export function registerRevealLayer(reveal: Reveal): void {
  registerDebugLayer({
    id: 'reveal',
    label: 'Reveal: visited (blue), scoped (green), in sight (outline)',
    defaultOn: false,
    draw(ctx, view) {
      const looking = new Set(reveal.looking);
      ctx.save();
      for (let j = 0; j < TILES_PER_SIDE; j++) {
        for (let i = 0; i < TILES_PER_SIDE; i++) {
          const id = tileId(i, j);
          const a = view.toPx(i * TILE_M, (j + 1) * TILE_M);
          const b = view.toPx((i + 1) * TILE_M, j * TILE_M);
          const w = b.px - a.px;
          const h = b.py - a.py;
          const fill = reveal.visited.has(id) ? 'rgba(40,110,255,0.3)' : reveal.revealed.has(id) ? 'rgba(40,200,80,0.35)' : null;
          if (fill) {
            ctx.fillStyle = fill;
            ctx.fillRect(a.px, a.py, w, h);
          }
          if (looking.has(id)) {
            ctx.strokeStyle = 'rgba(255,255,0,0.9)';
            ctx.lineWidth = 3;
            ctx.strokeRect(a.px + 2, a.py + 2, w - 4, h - 4);
          }
        }
      }
      ctx.restore();
    },
    hover(_view, x, y) {
      const t = tileOf(x, y);
      const id = tileId(t.i, t.j);
      const how = [reveal.visited.has(id) && 'visited', reveal.revealed.has(id) && 'scoped'].filter(Boolean).join(', ');
      return `${id}: ${how || 'plain'}`;
    },
  });
}
