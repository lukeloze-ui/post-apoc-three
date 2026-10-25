// Route check (SX 02 'Always leave a way through'). Runs after every district and blocker step and after the hand
// overrides: builds the 50 m passability grid from the committed data, looks for a route from START to the goal edge,
// and if there is none reopens the fewest fallen bridges (src/world/route.ts). Records the outcome in the header.
import { readFileSync, writeFileSync } from 'node:fs';
import { validateDistricts, type Districts, type RouteCheckRecord } from '../../../src/world/districts';
import type { Features } from '../../../src/world/features';
import { parseLakes, type LakesMeta } from '../../../src/world/lakes';
import {
  LAKE_WALL_DEPTH_M,
  ROUTE_DAY,
  STEEP_DEG,
  TOWARDS_PRIDDY,
  buildCrossings,
  buildRouteGrid,
  edgeGoal,
  ensureWayThrough,
  type Reopen,
  type Side,
} from '../../../src/world/route';
import { START, parseTerrain, type TerrainMeta } from '../../../src/world/terrain';
import type { Step } from '../steps';
import { serialise } from './districts';

const dir = 'public/world/';

/** The goal: the patch edges towards Priddy. Change this to aim the check elsewhere. */
export const ROUTE_GOAL: readonly Side[] = TOWARDS_PRIDDY;

/** Bridge reason recorded for a bridge the route check reopened. */
export const ROUTE_REASON = 'routeCheck';

/** Marks the reopened bridges standing (in place). Throws on an unknown id. */
export function applyReopen(d: Districts, reopened: readonly Reopen[]): void {
  for (const r of reopened) {
    const b = d.bridges.find((x) => x.id === r.id);
    if (!b) throw new Error(`routeCheck: no bridge ${r.id}`);
    b.standing = true;
    b.reason = ROUTE_REASON;
  }
}

/** Districts with the record placed in the header, after survivors, so it reads with the other big decisions. */
export function withRouteCheck(d: Districts, record: RouteCheckRecord): Districts {
  const { version, method, storm, survivors, bridges, roadSegments, tiles } = d;
  return { version, method, storm, survivors, routeCheck: record, bridges, roadSegments, tiles };
}

export const routeCheckStep: Step = {
  name: 'routeCheck',
  run() {
    const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
    const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
    const lmeta = JSON.parse(readFileSync(dir + 'lakes.json', 'utf8')) as LakesMeta;
    const lakes = parseLakes(lmeta, readFileSync(dir + 'lakeid.bin'), terrain);
    const features = JSON.parse(readFileSync(dir + 'features.json', 'utf8')) as Features;
    const districts = JSON.parse(readFileSync(dir + 'districts.json', 'utf8')) as Districts;

    const world = { terrain, lakes, features, districts };
    const grid = buildRouteGrid(world);
    const crossings = buildCrossings(world, grid);
    const out = ensureWayThrough(grid, crossings, START, edgeGoal(grid, ROUTE_GOAL));
    for (const line of out.log) console.log(`[worldgen] routeCheck: ${line}`);
    if (!out.route) throw new Error('routeCheck: no way through, even with every fallen bridge reopened');
    applyReopen(districts, out.reopened);

    const marker = ' [routeCheck] ';
    districts.method =
      districts.method.split(marker)[0] +
      marker +
      `Checked last: a ${grid.cellM} m grid, 8-connected, from START to the ${ROUTE_GOAL.join(' or ')} edge. Walls are lakes ` +
      `over ${LAKE_WALL_DEPTH_M} m deep on day ${ROUTE_DAY}, river-kind features (crossed only on a standing bridge), ` +
      `burning strike zones and slopes over ${STEEP_DEG} degrees; gas is ignored and the slow blockers are walkable. ` +
      `Bridges it reopened have reason '${ROUTE_REASON}'; routeCheck in the header says why.`;
    const record: RouteCheckRecord = {
      method: 'src/world/route.ts ensureWayThrough',
      goal: [...ROUTE_GOAL],
      cells: out.route.cells.length,
      lengthM: Math.round(out.route.lengthM),
      reopened: out.reopened.map((r) => ({ bridgeId: r.id, reason: r.reason })),
    };
    const result = withRouteCheck(districts, record);

    const errs = validateDistricts(result, features);
    if (errs.length > 0) throw new Error(`routeCheck: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
    writeFileSync(dir + 'districts.json', serialise(result));
    console.log(
      `[worldgen] routeCheck: ${crossings.length} river crossings (${crossings.filter((c) => c.open).length} standing), ` +
        `${out.reopened.length} reopened, route ${record.lengthM} m`,
    );
  },
};
