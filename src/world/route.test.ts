import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateDistricts, type Districts } from './districts';
import type { Features } from './features';
import { parseLakes, type LakesMeta } from './lakes';
import {
  Cell,
  TOWARDS_PRIDDY,
  buildCrossings,
  buildRouteGrid,
  cellAt,
  edgeGoal,
  ensureWayThrough,
  findWayThrough,
  openCrossings,
  type Crossing,
  type RouteGrid,
} from './route';
import { START, parseTerrain, type TerrainMeta } from './terrain';

const N = 20;
const CELL = 50;

/** A 20x20 grid of 50 m cells with river cells at the given (cx, cy). */
function grid(river: (cx: number, cy: number) => boolean): RouteGrid {
  const cells = new Uint8Array(N * N);
  for (let cy = 0; cy < N; cy++) for (let cx = 0; cx < N; cx++) if (river(cx, cy)) cells[cy * N + cx] = Cell.River;
  return { cellM: CELL, w: N, h: N, cells };
}

const at = (cx: number, cy: number): { x: number; y: number } => ({ x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL });
const bridge = (id: string, cx: number, cy: number, depthBelowMark: number, open = false): Crossing => ({
  id,
  cells: [cy * N + cx],
  open,
  depthBelowMark,
});

// A river right across row 10; the start is south of it, the goal the north edge.
const riverGrid = grid((_, cy) => cy === 10);
const north = edgeGoal(riverGrid, ['north']);
const start = at(5, 2);

describe('findWayThrough', () => {
  it('finds a route over open ground to the goal edge', () => {
    const g = grid(() => false);
    const r = findWayThrough(g, start, north);
    expect(r).not.toBeNull();
    expect(r?.cells[0]).toBe(cellAt(g, start.x, start.y));
    expect(Math.floor((r?.cells.at(-1) as number) / N)).toBe(N - 1);
    expect(r?.cells).toHaveLength(N - 2);
  });

  it('is stopped by a river', () => {
    expect(findWayThrough(riverGrid, start, north)).toBeNull();
  });

  it('cannot squeeze diagonally through a diagonal river line', () => {
    const diag = grid((cx, cy) => cx === cy);
    // Start south-east of the line, goal the west edge, which lies wholly north-west of it but for its corner.
    expect(findWayThrough(diag, at(15, 2), edgeGoal(diag, ['west']))).toBeNull();
  });

  it('crosses on an opened crossing', () => {
    const r = findWayThrough(openCrossings(riverGrid, [bridge('b', 7, 10, 0)]), start, north);
    expect(r?.cells).toContain(10 * N + 7);
  });

  it('reaches the north or east edge towards Priddy', () => {
    const g = grid((cx) => cx === 10);
    expect(findWayThrough(g, at(2, 2), edgeGoal(g, ['east']))).toBeNull();
    expect(findWayThrough(g, at(2, 2), edgeGoal(g, TOWARDS_PRIDDY))).not.toBeNull();
  });
});

describe('ensureWayThrough', () => {
  const fallen = [bridge('far', 17, 10, 5), bridge('nearDeep', 6, 10, 40), bridge('nearShallow', 4, 10, 30)];

  it('reopens exactly one fallen bridge when the river blocks every route', () => {
    expect(findWayThrough(openCrossings(riverGrid, fallen.filter((c) => c.open)), start, north)).toBeNull();
    const out = ensureWayThrough(riverGrid, fallen, start, north);
    expect(out.route).not.toBeNull();
    expect(out.reopened).toHaveLength(1);
    // The far bridge is the shallowest but gives a longer route; of the two near ones the shallower wins.
    expect(out.reopened[0]?.id).toBe('nearShallow');
    expect(out.reopened[0]?.reason).toMatch(/shortest/);
    expect(out.log.some((l) => l.startsWith('reopened nearShallow'))).toBe(true);
    expect(out.route?.cells).toContain(10 * N + 4);
    // The input is left alone.
    expect(fallen.every((c) => !c.open)).toBe(true);
  });

  it('reopens nothing when a bridge stands', () => {
    const out = ensureWayThrough(riverGrid, [...fallen, bridge('standing', 12, 10, 50, true)], start, north);
    expect(out.reopened).toEqual([]);
    expect(out.route?.cells).toContain(10 * N + 12);
  });

  it('reopens a second bridge only when one is not enough', () => {
    const two = grid((_, cy) => cy === 7 || cy === 13);
    const crossings = [bridge('a1', 3, 7, 10), bridge('a2', 15, 7, 2), bridge('b1', 4, 13, 10)];
    const out = ensureWayThrough(two, crossings, start, north);
    expect(out.route).not.toBeNull();
    expect(out.reopened.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
    expect(out.reopened.every((r) => /no single/.test(r.reason))).toBe(true);
  });

  it('gives up with null when nothing helps', () => {
    const out = ensureWayThrough(riverGrid, [], start, north);
    expect(out.route).toBeNull();
    expect(out.reopened).toEqual([]);
  });
});

describe('shipped world', () => {
  const dir = 'public/world/';
  const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
  const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
  const lakes = parseLakes(JSON.parse(readFileSync(dir + 'lakes.json', 'utf8')) as LakesMeta, readFileSync(dir + 'lakeid.bin'), terrain);
  const features = JSON.parse(readFileSync(dir + 'features.json', 'utf8')) as Features;
  const districts = JSON.parse(readFileSync(dir + 'districts.json', 'utf8')) as Districts;
  const world = { terrain, lakes, features, districts };
  const base = buildRouteGrid(world);
  const crossings = buildCrossings(world, base);

  it('has river walls and crossings', () => {
    expect(base.cells.some((c) => c === Cell.River)).toBe(true);
    expect(crossings.length).toBeGreaterThan(0);
  });

  it('has a route from START to the north or east edge with the standing bridges', () => {
    const g = openCrossings(
      base,
      crossings.filter((c) => c.open),
    );
    const r = findWayThrough(g, START, edgeGoal(g, TOWARDS_PRIDDY));
    expect(r).not.toBeNull();
  });

  it('records the route check in the header', () => {
    expect(districts.routeCheck?.goal).toEqual([...TOWARDS_PRIDDY]);
    expect(validateDistricts(districts, features)).toEqual([]);
  });
});
