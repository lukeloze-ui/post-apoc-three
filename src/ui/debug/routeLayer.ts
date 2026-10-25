// Debug layers for the route check (src/world/route.ts): the walls of the 50 m passability grid and the way through
// from START to the goal edge, found on the loaded data. Bridges the build reopened are ringed.
import type { Districts } from '../../world/districts';
import type { Features } from '../../world/features';
import {
  Cell,
  TOWARDS_PRIDDY,
  buildCrossings,
  buildRouteGrid,
  edgeGoal,
  findWayThrough,
  openCrossings,
  routePoints,
  type Route,
  type RouteGrid,
} from '../../world/route';
import { START } from '../../world/terrain';
import { registerDebugLayer, type DebugViewport } from './overheadView';

const WALL_COLOUR: Record<number, string> = {
  [Cell.Lake]: 'rgba(20,40,140,0.55)',
  [Cell.River]: 'rgba(0,170,255,0.7)',
  [Cell.Burning]: 'rgba(255,90,0,0.6)',
  [Cell.Steep]: 'rgba(120,120,120,0.6)',
};

interface Found {
  grid: RouteGrid;
  route: Route | null;
}

/** Registers the route layers. The grid and route are built on first draw. */
export function registerRouteLayers(districts: Districts, features: Features): void {
  let found: Found | undefined;
  const get = (view: DebugViewport): Found => {
    if (!found) {
      const world = { terrain: view.data.terrain, lakes: view.data.lakes, features, districts };
      const base = buildRouteGrid(world);
      const grid = openCrossings(
        base,
        buildCrossings(world, base).filter((c) => c.open),
      );
      found = { grid, route: findWayThrough(grid, START, edgeGoal(grid, TOWARDS_PRIDDY)) };
    }
    return found;
  };
  const reopened = new Set((districts.routeCheck?.reopened ?? []).map((r) => r.bridgeId));
  const reopenedBridges = districts.bridges.filter((b) => reopened.has(b.id));

  registerDebugLayer({
    id: 'routeWalls',
    label: 'Route check: walls (lake, river, burning, steep)',
    defaultOn: false,
    draw(ctx, view) {
      const { grid } = get(view);
      const side = grid.cellM * view.scale;
      ctx.save();
      for (let k = 0; k < grid.cells.length; k++) {
        const code = grid.cells[k] as number;
        if (code === Cell.Open) continue;
        const cx = k % grid.w;
        const cy = (k - cx) / grid.w;
        const { px, py } = view.toPx(cx * grid.cellM, (cy + 1) * grid.cellM);
        if (px > view.width || py > view.height || px + side < 0 || py + side < 0) continue;
        ctx.fillStyle = WALL_COLOUR[code] ?? 'rgba(255,0,255,0.5)';
        ctx.fillRect(px, py, Math.max(1, side), Math.max(1, side));
      }
      ctx.restore();
    },
  });

  registerDebugLayer({
    id: 'route',
    label: 'Route check: way through to the N/E edge',
    defaultOn: false,
    draw(ctx, view) {
      const { grid, route } = get(view);
      ctx.save();
      if (route) {
        ctx.strokeStyle = '#ffe600';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        for (const [x, y] of routePoints(grid, route)) {
          const { px, py } = view.toPx(x, y);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = '#ff3030';
        ctx.font = '14px monospace';
        ctx.fillText('route check: no way through', 10, view.height - 20);
      }
      ctx.strokeStyle = '#ff00ff';
      ctx.lineWidth = 3;
      for (const b of reopenedBridges) {
        const { px, py } = view.toPx(b.x, b.y);
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
    hover(view, x, y) {
      for (const b of reopenedBridges) {
        if (Math.hypot(x - b.x, y - b.y) * view.scale <= 12) {
          const why = districts.routeCheck?.reopened.find((r) => r.bridgeId === b.id)?.reason ?? '';
          return `reopened by route check: ${b.id}: ${why}`;
        }
      }
      return undefined;
    },
  });
}
