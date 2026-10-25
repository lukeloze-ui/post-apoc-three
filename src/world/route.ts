// Way-through check (SX 02 'Always leave a way through'): a 50 m passability grid over the patch, a search from the
// start to a goal, and the reopening of fallen bridges when no route exists. Pure: the build step
// (Tools/worldgen/steps/routeCheck.ts) runs it on the committed data, and the debug view draws the route it finds.
// Local frame as in terrain.ts: x metres east, y metres north from the patch's SW corner. Cell key = cy * w + cx.
import type { Districts } from './districts';
import type { Features, Pt } from './features';
import { lakeAt, lakeLevelAt, type Lakes } from './lakes';
import { heightAt, type Terrain } from './terrain';

/** What a grid cell holds. Only Open is walkable; wrack, blocked roads, fallen wood and silt are slow, so Open. */
export const Cell = {
  Open: 0,
  /** A lake deeper than LAKE_WALL_DEPTH_M at the cell centre on ROUTE_DAY. */
  Lake: 1,
  /** A river-kind feature runs through it. Streams are fordable, so they stay Open. */
  River: 2,
  /** Inside a burning strike zone. Glassy ones are slow, not walls. */
  Burning: 3,
  /** Steeper than STEEP_DEG. */
  Steep: 4,
} as const;
export type CellCode = (typeof Cell)[keyof typeof Cell];

/** Game day the check is made for: the first day the rivers are out of flood. Gas (days 1 to 5) is ignored. */
export const ROUTE_DAY = 6;
export const LAKE_WALL_DEPTH_M = 1;
export const STEEP_DEG = 45;
/** Lines are sampled this often when rasterised, metres. */
const RASTER_STEP_M = 10;
/** A bridge opens its carrier way's cells this far either side of the bridge point, metres. */
export const CROSSING_REACH_M = 60;

export interface RouteGrid {
  cellM: number;
  w: number;
  h: number;
  /** One CellCode per cell, row-major, row 0 = south. */
  cells: Uint8Array;
}

/** A way over a river: open when a bridge stands (or at a fordable shallow spot). Opening it makes its cells Open. */
export interface Crossing {
  id: string;
  cells: number[];
  open: boolean;
  depthBelowMark: number;
}

/** True for a goal cell (column, row). */
export type GoalFn = (cx: number, cy: number) => boolean;

export interface Route {
  /** Cell keys from the start cell to the goal cell. */
  cells: number[];
  lengthM: number;
}

export interface Reopen {
  id: string;
  reason: string;
}

export interface WayThrough {
  route: Route | null;
  /** Fallen crossings reopened, in the order chosen. */
  reopened: Reopen[];
  /** One line per finding or change. */
  log: string[];
}

export type Side = 'north' | 'east' | 'south' | 'west';

/** Priddy lies north-east of the patch. */
export const TOWARDS_PRIDDY: readonly Side[] = ['north', 'east'];

/** 8-connected steps: orthogonal first, so ties prefer straight moves. */
const STEPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
];

/** Cell key holding local (x, y), or -1 outside the grid. */
export function cellAt(grid: RouteGrid, x: number, y: number): number {
  const cx = Math.floor(x / grid.cellM);
  const cy = Math.floor(y / grid.cellM);
  return cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h ? -1 : cy * grid.w + cx;
}

/** Centre of a cell, local metres. */
export function cellCentre(grid: RouteGrid, k: number): Pt {
  const cx = k % grid.w;
  return [(cx + 0.5) * grid.cellM, ((k - cx) / grid.w + 0.5) * grid.cellM];
}

/** Goal: any cell on the named patch edges. */
export function edgeGoal(grid: RouteGrid, sides: readonly Side[]): GoalFn {
  const n = sides.includes('north');
  const e = sides.includes('east');
  const s = sides.includes('south');
  const w = sides.includes('west');
  return (cx, cy) => (n && cy === grid.h - 1) || (e && cx === grid.w - 1) || (s && cy === 0) || (w && cx === 0);
}

/** A copy of the grid with the given crossings' cells made Open. */
export function openCrossings(grid: RouteGrid, crossings: readonly Crossing[]): RouteGrid {
  const cells = grid.cells.slice();
  for (const c of crossings) for (const k of c.cells) cells[k] = Cell.Open;
  return { ...grid, cells };
}

/** True when neighbouring cells a and b differ in both column and row. */
const isDiagonal = (grid: RouteGrid, a: number, b: number): boolean =>
  a % grid.w !== b % grid.w && Math.floor(a / grid.w) !== Math.floor(b / grid.w);

function routeOf(grid: RouteGrid, prev: Int32Array, end: number): Route {
  const cells: number[] = [];
  for (let k = end; k >= 0; k = prev[k] as number) cells.push(k);
  cells.reverse();
  let lengthM = 0;
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1] as number;
    const b = cells[k] as number;
    lengthM += (isDiagonal(grid, a, b) ? Math.SQRT2 : 1) * grid.cellM;
  }
  return { cells, lengthM };
}

/**
 * Breadth-first search over Open cells, 8-connected, from the cell holding start to the nearest goal cell (fewest
 * steps). A diagonal step may not squeeze between two closed cells, so a diagonal river line is a wall. The start
 * cell counts as walkable. Returns null when no goal cell can be reached.
 */
export function findWayThrough(grid: RouteGrid, start: { x: number; y: number }, isGoal: GoalFn): Route | null {
  const { w, h, cells } = grid;
  const s = cellAt(grid, start.x, start.y);
  if (s < 0) return null;
  const prev = new Int32Array(w * h).fill(-2);
  const queue = new Int32Array(w * h);
  prev[s] = -1;
  let head = 0;
  let tail = 0;
  queue[tail++] = s;
  while (head < tail) {
    const k = queue[head++] as number;
    const cx = k % w;
    const cy = (k - cx) / w;
    if (isGoal(cx, cy)) return routeOf(grid, prev, k);
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -2 || cells[n] !== Cell.Open) continue;
      if (dx !== 0 && dy !== 0 && cells[cy * w + nx] !== Cell.Open && cells[ny * w + cx] !== Cell.Open) continue;
      prev[n] = k;
      queue[tail++] = n;
    }
  }
  return null;
}

const byDepth = (a: Crossing, b: Crossing): number => a.depthBelowMark - b.depthBelowMark || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Fewest fallen crossings that together restore a route: Dijkstra where entering a closed cell of a fallen crossing
 * costs a reopen (far more than any walk), so the cheapest path uses the fewest. Where crossings share a cell the
 * shallowest owns it. Returns the crossings used, or null if even all of them are not enough.
 */
function fewestReopens(grid: RouteGrid, fallen: readonly Crossing[], start: { x: number; y: number }, isGoal: GoalFn): Crossing[] | null {
  const { w, h, cells } = grid;
  const s = cellAt(grid, start.x, start.y);
  if (s < 0) return null;
  const sorted = [...fallen].sort(byDepth);
  const owner = new Int32Array(w * h).fill(-1);
  sorted.forEach((c, i) => {
    for (const k of c.cells) if (cells[k] !== Cell.Open && owner[k] === -1) owner[k] = i;
  });
  const passable = (k: number): boolean => cells[k] === Cell.Open || owner[k] !== -1;
  const reopenCost = 1e6;
  const dist = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  // Binary min-heap of [cost, key] pairs, lazy deletion.
  const heapC: number[] = [];
  const heapK: number[] = [];
  const push = (c: number, k: number): void => {
    let i = heapC.length;
    heapC.push(c);
    heapK.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heapC[p] as number) <= c) break;
      heapC[i] = heapC[p] as number;
      heapK[i] = heapK[p] as number;
      i = p;
    }
    heapC[i] = c;
    heapK[i] = k;
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [heapC[0] as number, heapK[0] as number];
    const c = heapC.pop() as number;
    const k = heapK.pop() as number;
    const n = heapC.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && (heapC[r] as number) < (heapC[l] as number) ? r : l;
        if ((heapC[m] as number) >= c) break;
        heapC[i] = heapC[m] as number;
        heapK[i] = heapK[m] as number;
        i = m;
      }
      heapC[i] = c;
      heapK[i] = k;
    }
    return top;
  };
  dist[s] = 0;
  push(0, s);
  while (heapC.length > 0) {
    const [d, k] = pop();
    if (d > (dist[k] as number)) continue;
    const cx = k % w;
    const cy = (k - cx) / w;
    if (isGoal(cx, cy)) {
      const used = new Set<number>();
      for (let p = k; p >= 0; p = prev[p] as number) if (owner[p] !== -1) used.add(owner[p] as number);
      return [...used].sort((a, b) => a - b).map((i) => sorted[i] as Crossing);
    }
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!passable(n)) continue;
      if (dx !== 0 && dy !== 0 && !passable(cy * w + nx) && !passable(ny * w + cx)) continue;
      const enter = owner[n] !== -1 && owner[n] !== owner[k] ? reopenCost : 0;
      const nd = d + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) + enter;
      if (nd < (dist[n] as number)) {
        dist[n] = nd;
        prev[n] = k;
        push(nd, n);
      }
    }
  }
  return null;
}

const m0 = (v: number): string => `${Math.round(v)} m`;

/**
 * Makes sure a route exists from start to a goal cell. Open crossings are opened first. If there is still no route,
 * reopens the single fallen crossing that restores the shortest route (routes within one cell of the shortest count
 * as equal, and then the shallowest below the mark wins); only if no single one is enough does it reopen the fewest
 * that together are. Every change is logged with its reason. Does not change the crossings passed in.
 */
export function ensureWayThrough(
  grid: RouteGrid,
  crossings: readonly Crossing[],
  start: { x: number; y: number },
  isGoal: GoalFn,
): WayThrough {
  const log: string[] = [];
  const base = openCrossings(
    grid,
    crossings.filter((c) => c.open),
  );
  const found = findWayThrough(base, start, isGoal);
  if (found) {
    log.push(`route found with the standing crossings: ${found.cells.length} cells, ${m0(found.lengthM)}; nothing reopened`);
    return { route: found, reopened: [], log };
  }
  log.push('no route with the standing crossings');

  // Only a crossing that would open a closed cell can change anything.
  const fallen = crossings.filter((c) => !c.open && c.cells.some((k) => base.cells[k] !== Cell.Open));
  const singles: { c: Crossing; route: Route }[] = [];
  for (const c of fallen) {
    const route = findWayThrough(openCrossings(base, [c]), start, isGoal);
    if (route) singles.push({ c, route });
  }
  if (singles.length > 0) {
    const shortest = Math.min(...singles.map((s) => s.route.lengthM));
    const best = singles
      .filter((s) => s.route.lengthM <= shortest + grid.cellM)
      .sort((a, b) => byDepth(a.c, b.c))[0] as { c: Crossing; route: Route };
    const reason =
      `no route from start to goal; of ${singles.length} fallen crossing(s) that each restore one, this gives the ` +
      `shortest (${m0(best.route.lengthM)}) and is the shallowest such, ${best.c.depthBelowMark.toFixed(1)} m below the mark`;
    log.push(`reopened ${best.c.id}: ${reason}`);
    return { route: best.route, reopened: [{ id: best.c.id, reason }], log };
  }

  const several = fewestReopens(base, fallen, start, isGoal);
  if (!several) {
    log.push('no route even with every fallen crossing reopened');
    return { route: null, reopened: [], log };
  }
  const route = findWayThrough(openCrossings(base, several), start, isGoal);
  const reopened = several.map((c) => {
    const reason =
      `no single fallen crossing restores a route; ${c.id} is one of the fewest (${several.length}) that together do, ` +
      `${c.depthBelowMark.toFixed(1)} m below the mark`;
    log.push(`reopened ${c.id}: ${reason}`);
    return { id: c.id, reason };
  });
  if (route) log.push(`route: ${route.cells.length} cells, ${m0(route.lengthM)}`);
  return { route, reopened, log };
}

// ---- the grid and crossings from the world data ----------------------------------------------------------------

export interface RouteWorld {
  terrain: Terrain;
  lakes: Lakes;
  features: Features;
  districts: Districts;
}

/** Cells along a polyline, 4-connected (a diagonal step also takes the cell beside it), in order, without repeats. */
function rasterLine(grid: RouteGrid, pts: readonly Pt[], keep: (x: number, y: number) => boolean = () => true): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let last = -1;
  const add = (k: number): void => {
    if (k < 0 || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (let s = 1; s < pts.length; s++) {
    const [ax, ay] = pts[s - 1] as Pt;
    const [bx, by] = pts[s] as Pt;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / RASTER_STEP_M));
    for (let t = 0; t <= steps; t++) {
      const x = ax + ((bx - ax) * t) / steps;
      const y = ay + ((by - ay) * t) / steps;
      if (!keep(x, y)) {
        last = -1;
        continue;
      }
      const k = cellAt(grid, x, y);
      if (k < 0 || k === last) continue;
      if (last >= 0 && isDiagonal(grid, last, k)) {
        // Diagonal: take the cell beside, sharing the column of the last and the row of this one.
        add(k - (k % grid.w) + (last % grid.w));
      }
      add(k);
      last = k;
    }
  }
  return out;
}

/** Passability grid for the patch on ROUTE_DAY (see Cell). Same cells as the terrain. */
export function buildRouteGrid(world: RouteWorld): RouteGrid {
  const { terrain, lakes, features, districts } = world;
  const cellM = terrain.meta.cellM;
  const w = terrain.meta.postsX - 1;
  const h = terrain.meta.postsY - 1;
  const grid: RouteGrid = { cellM, w, h, cells: new Uint8Array(w * h) };
  const cells = grid.cells;
  const half = cellM / 2;
  const steepTan = Math.tan((STEEP_DEG * Math.PI) / 180);

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const x = (cx + 0.5) * cellM;
      const y = (cy + 0.5) * cellM;
      const ground = heightAt(terrain, x, y);
      const gx = (heightAt(terrain, x + half, y) - heightAt(terrain, x - half, y)) / cellM;
      const gy = (heightAt(terrain, x, y + half) - heightAt(terrain, x, y - half)) / cellM;
      if (Math.hypot(gx, gy) > steepTan) cells[cy * w + cx] = Cell.Steep;
      const lake = lakeAt(lakes, x, y);
      if (lake && lakeLevelAt(lake, ROUTE_DAY) - ground > LAKE_WALL_DEPTH_M) cells[cy * w + cx] = Cell.Lake;
    }
  }

  for (const t of districts.tiles) {
    for (const z of t.strikeZones) {
      if (z.kind !== 'burning') continue;
      const x0 = Math.max(0, Math.floor((z.x - z.r) / cellM));
      const x1 = Math.min(w - 1, Math.floor((z.x + z.r) / cellM));
      const y0 = Math.max(0, Math.floor((z.y - z.r) / cellM));
      const y1 = Math.min(h - 1, Math.floor((z.y + z.r) / cellM));
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          if (Math.hypot((cx + 0.5) * cellM - z.x, (cy + 0.5) * cellM - z.y) <= z.r) cells[cy * w + cx] = Cell.Burning;
        }
      }
    }
  }

  for (const r of features.rivers) {
    if (r.kind !== 'river') continue;
    for (const k of rasterLine(grid, r.pts)) cells[k] = Cell.River;
  }
  return grid;
}

/**
 * One crossing per district bridge over a river-kind feature (streams are fordable anyway): the cells of its carrier
 * way within CROSSING_REACH_M of the bridge point, plus the bridge's own cell. Open when the bridge stands.
 * The world data records no fordable shallow spots yet, so none are added.
 */
export function buildCrossings(world: RouteWorld, grid: RouteGrid): Crossing[] {
  const { features, districts } = world;
  const riverKind = new Map(features.rivers.map((r) => [r.id, r.kind]));
  const roads = new Map(features.roads.map((r) => [r.id, r.pts]));
  const rail = new Map(features.rail.map((r) => [r.id, r.pts]));
  const out: Crossing[] = [];
  for (const b of districts.bridges) {
    if (b.crosses === null || riverKind.get(b.crosses) !== 'river') continue;
    const pts = (b.on === 'rail' ? rail : roads).get(b.refId) ?? [];
    const near = (x: number, y: number): boolean => Math.hypot(x - b.x, y - b.y) <= CROSSING_REACH_M;
    const cells = rasterLine(grid, pts, near);
    const own = cellAt(grid, b.x, b.y);
    if (own >= 0 && !cells.includes(own)) cells.push(own);
    out.push({ id: b.id, cells, open: b.standing, depthBelowMark: b.depthBelowMark });
  }
  return out;
}

/** Cell centres along a route, local metres. */
export function routePoints(grid: RouteGrid, route: Route): Pt[] {
  return route.cells.map((k) => cellCentre(grid, k));
}
