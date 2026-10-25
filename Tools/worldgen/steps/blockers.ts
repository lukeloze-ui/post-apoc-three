// Terrain blockers (SX 02 'Damage blocks'): wrack dams, landslips, silt and mud flats with soft patches, fallen woodland.
// Reads districts.json (written by the districts and craters steps just before) and fills the tile lists. Own RNG and seed.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  LANDSLIP_MIN_SLOPE_DEG,
  ringContains,
  validateDistricts,
  type Districts,
  type FallenWood,
  type Landslip,
  type SiltFlat,
  type WrackDam,
} from '../../../src/world/districts';
import type { Features, Pt } from '../../../src/world/features';
import { priorityFlood } from '../../../src/world/fill';
import { hwAt, parseFlood, type FloodMeta } from '../../../src/world/flood';
import { isUnderWater, parseLakes, type LakesMeta } from '../../../src/world/lakes';
import { LandCover, TILES_PER_SIDE, TILE_M, heightAt, landcoverAt, parseTerrain, tileOf, type Terrain, type TerrainMeta } from '../../../src/world/terrain';
import { reliefAt } from '../rules/craters';
import { mulberry32, type Rng } from '../rng';
import type { Step } from '../steps';
import { serialise } from './districts';

const dir = 'public/world/';
const SEED = 0xb10c4e25;

/**
 * Landslips: cells steeper than this, within this height above the mark, metres. The 50 m DEM smooths slopes (only a
 * few cells reach 30 degrees), so the cut sits just over the validator floor.
 */
const SLIP_SLOPE_DEG = 26;
const SLIP_ABOVE_MARK_M = 20;
const SLIP_MIN_CELLS = 1;
const SLIP_MAX_CELLS = 20;
const SLIP_CHANCE = 0.7;

/** Silt: gentle cells below the mark on a valley floor or basin, in runs of at least this many cells per tile. */
const SILT_MAX_SLOPE_DEG = 5;
const SILT_RELIEF_M = -4;
const SILT_MIN_CELLS = 3;
/** Soft patches: about one per this many cells of flat, at most the cap; radius in metres (the circle stays inside one cell). */
const SOFT_CELLS_PER_PATCH = 3;
const SOFT_MAX = 6;
const SOFT_R_MIN = 4;
const SOFT_R_MAX = 12;

/** Wrack dams at bridges below the mark (a standing bridge traps more than a broken one), and at valley narrows. */
const WRACK_STANDING_CHANCE = 0.7;
const WRACK_FALLEN_CHANCE = 0.3;
const BRIDGE_DAM_R_MIN = 8;
const BRIDGE_DAM_R_MAX = 18;
/** Valley floor = ground within this height of the filled river bed; measured across the river up to this far each side, metres. */
const FLOOR_RISE_M = 6;
const FLOOR_REACH_M = 300;
const CROSS_STEP_M = 10;
/** River sampling step; the stretch upstream used for comparison; a narrows is narrower than this fraction of it. */
const RIVER_STEP_M = 25;
const UPSTREAM_FROM_M = 100;
const UPSTREAM_TO_M = 300;
const NARROW_RATIO = 0.5;
const NARROW_CHANCE = 0.6;
const NARROW_SPACING_M = 400;
const NARROW_DAM_R_MIN = 10;
const NARROW_DAM_R_MAX = 25;

/** Woods: fallen when this share of the wood's sampled points lie below the mark (and the roll passes), or a strike zone touches it. */
const WOOD_BELOW_SHARE = 0.5;
const WOOD_FALL_CHANCE = 0.9;
const WOOD_SAMPLE_M = 25;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Slope at (x, y) from central differences over the cell size, degrees. */
export function slopeDegAt(t: Terrain, x: number, y: number): number {
  const d = t.meta.cellM / 2;
  const gx = (heightAt(t, x + d, y) - heightAt(t, x - d, y)) / (2 * d);
  const gy = (heightAt(t, x, y + d) - heightAt(t, x, y - d)) / (2 * d);
  return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
}

/** 4-connected runs of the given cell keys (cy * stride + cx), each sorted ascending; runs ordered by first key. */
export function cellRuns(keys: ReadonlySet<number>, stride: number): number[][] {
  const seen = new Set<number>();
  const runs: number[][] = [];
  for (const start of [...keys].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const run: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const k = stack.pop() as number;
      run.push(k);
      const x = k % stride;
      for (const [nx, nk] of [[x + 1, k + 1], [x - 1, k - 1], [x, k + stride], [x, k - stride]] as const) {
        if (nx < 0 || nx >= stride || !keys.has(nk) || seen.has(nk)) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    runs.push(run.sort((a, b) => a - b));
  }
  return runs;
}

/** At most max cells of run, grown breadth-first from seed (a member). Keeps the result 4-connected. */
export function growBlob(run: readonly number[], stride: number, seed: number, max: number): number[] {
  if (run.length <= max) return [...run];
  const inRun = new Set(run);
  const out = [seed];
  const seen = new Set(out);
  for (let n = 0; n < out.length && out.length < max; n++) {
    const k = out[n] as number;
    const x = k % stride;
    for (const [nx, nk] of [[x + 1, k + 1], [x - 1, k - 1], [x, k + stride], [x, k - stride]] as const) {
      if (nx < 0 || nx >= stride || !inRun.has(nk) || seen.has(nk) || out.length >= max) continue;
      seen.add(nk);
      out.push(nk);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Outer boundary of a 4-connected run of cells as a closed ring in metres (first point repeated), collinear points
 * dropped. Holes are ignored. Walks the directed boundary edges with the interior on the left.
 */
export function cellRing(cells: readonly number[], stride: number, cellM: number): Pt[] {
  const inRun = new Set(cells);
  // Edge from vertex a to vertex b, vertices keyed (vy * (stride + 1) + vx).
  const next = new Map<number, number[]>();
  const vk = (vx: number, vy: number): number => vy * (stride + 1) + vx;
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const list = next.get(vk(ax, ay)) ?? [];
    list.push(vk(bx, by));
    next.set(vk(ax, ay), list);
  };
  for (const k of cells) {
    const x = k % stride;
    const y = (k - x) / stride;
    if (!inRun.has(k - stride)) add(x, y, x + 1, y);
    if (!inRun.has(k + 1)) add(x + 1, y, x + 1, y + 1);
    if (!inRun.has(k + stride)) add(x + 1, y + 1, x, y + 1);
    if (!inRun.has(k - 1)) add(x, y + 1, x, y);
  }
  const loops: number[][] = [];
  while (next.size > 0) {
    const start = Math.min(...next.keys());
    const loop = [start];
    let at = start;
    for (;;) {
      const outs = next.get(at) as number[];
      // Several exits at a pinch point: take the first (edges were added in a fixed order).
      const to = outs.shift() as number;
      if (outs.length === 0) next.delete(at);
      if (to === start) break;
      loop.push(to);
      at = to;
      if (!next.has(at)) break;
    }
    loops.push(loop);
  }
  const area = (loop: readonly number[]): number => {
    let a = 0;
    for (let n = 0; n < loop.length; n++) {
      const p = loop[n] as number;
      const q = loop[(n + 1) % loop.length] as number;
      a += (p % (stride + 1)) * Math.floor(q / (stride + 1)) - (q % (stride + 1)) * Math.floor(p / (stride + 1));
    }
    return a / 2;
  };
  const outer = loops.reduce((best, l) => (Math.abs(area(l)) > Math.abs(area(best)) ? l : best));
  const pts = outer.map((v): Pt => [(v % (stride + 1)) * cellM, Math.floor(v / (stride + 1)) * cellM]);
  const kept = pts.filter((p, n) => {
    const a = pts[(n + pts.length - 1) % pts.length] as Pt;
    const b = pts[(n + 1) % pts.length] as Pt;
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
  return [...kept, kept[0] as Pt];
}

/** Centre of the ring's box and the radius from it that holds every point. */
function ringSpot(ring: readonly Pt[]): { x: number; y: number; r: number } {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { x: r1(x), y: r1(y), r: r1(Math.max(...ring.map((p) => Math.hypot(p[0] - x, p[1] - y)))) };
}

/** Width of the valley floor across a river at (x, y) heading (dx, dy): metres each side until the ground is over bed + rise. */
function floorWidth(raw: Terrain, bed: number, x: number, y: number, dx: number, dy: number): number {
  let width = 0;
  for (const side of [1, -1]) {
    let d = CROSS_STEP_M;
    for (; d < FLOOR_REACH_M; d += CROSS_STEP_M) {
      if (heightAt(raw, x - dy * side * d, y + dx * side * d) > bed + FLOOR_RISE_M) break;
    }
    width += d - CROSS_STEP_M;
  }
  return width;
}

export const blockersStep: Step = {
  name: 'blockers',
  run() {
    const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
    const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
    const fmeta = JSON.parse(readFileSync(dir + 'flood.json', 'utf8')) as FloodMeta;
    const flood = parseFlood(fmeta, readFileSync(dir + 'bands.bin'), terrain);
    const lmeta = JSON.parse(readFileSync(dir + 'lakes.json', 'utf8')) as LakesMeta;
    const lakes = parseLakes(lmeta, readFileSync(dir + 'lakeid.bin'), terrain);
    const features = JSON.parse(readFileSync(dir + 'features.json', 'utf8')) as Features;
    const districts = JSON.parse(readFileSync(dir + 'districts.json', 'utf8')) as Districts;
    const cellM = tmeta.cellM;
    const cells = tmeta.postsX - 1;
    const cellsPerTile = TILE_M / cellM;
    const tiles = districts.tiles;
    const tileAt = (x: number, y: number): Districts['tiles'][number] => {
      const t = tileOf(x, y);
      return tiles[t.j * TILES_PER_SIDE + t.i] as Districts['tiles'][number];
    };
    const markAt = (x: number, y: number): number => hwAt(flood.hw, x, y);
    const rng: Rng = mulberry32(SEED);

    // ---- Wrack dams ----
    const wrack: WrackDam[][] = tiles.map(() => []);
    const wrackN = new Map<string, number>();
    const addDam = (kind: WrackDam['kind'], x: number, y: number, r: number, bridgeId: string | null): void => {
      const t = tileAt(x, y);
      const n = wrackN.get(t.id) ?? 0;
      wrackN.set(t.id, n + 1);
      wrack[t.j * TILES_PER_SIDE + t.i]?.push({ id: `wd-${t.id}-${n}`, x: r1(x), y: r1(y), r: r1(r), kind, bridgeId });
    };
    let bridgeDams = 0;
    for (const b of districts.bridges) {
      // Every bridge draws its rolls, so a change to one bridge never shifts another.
      const roll = rng.next();
      const r = rng.float(BRIDGE_DAM_R_MIN, BRIDGE_DAM_R_MAX);
      if (b.crosses === null || heightAt(terrain, b.x, b.y) >= markAt(b.x, b.y)) continue;
      if (roll < (b.standing ? WRACK_STANDING_CHANCE : WRACK_FALLEN_CHANCE)) {
        addDam('bridge', b.x, b.y, r, b.id);
        bridgeDams++;
      }
    }
    // Valley narrows: where the floor width drops sharply from the stretch just upstream, in the filled DEM.
    const filled = priorityFlood(Float64Array.from(terrain.heightsDm, (dm) => dm / 10), tmeta.postsX, tmeta.postsY);
    const filledTerrain: Terrain = { ...terrain, heightsDm: Int16Array.from(filled, (m) => Math.round(m * 10)) };
    let narrowsDams = 0;
    for (const river of features.rivers) {
      // Resample at RIVER_STEP_M along the line (drawn downstream).
      const samples: { x: number; y: number; dx: number; dy: number }[] = [];
      let carry = 0;
      for (let k = 0; k + 1 < river.pts.length; k++) {
        const a = river.pts[k] as Pt;
        const b = river.pts[k + 1] as Pt;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len === 0) continue;
        for (let s = carry; s < len; s += RIVER_STEP_M) {
          samples.push({ x: a[0] + ((b[0] - a[0]) * s) / len, y: a[1] + ((b[1] - a[1]) * s) / len, dx: (b[0] - a[0]) / len, dy: (b[1] - a[1]) / len });
          carry = s + RIVER_STEP_M - len;
        }
      }
      const widths = samples.map((p) => floorWidth(terrain, heightAt(filledTerrain, p.x, p.y), p.x, p.y, p.dx, p.dy));
      const from = Math.round(UPSTREAM_FROM_M / RIVER_STEP_M);
      const to = Math.round(UPSTREAM_TO_M / RIVER_STEP_M);
      let last: { x: number; y: number } | null = null;
      for (let k = to; k < samples.length; k++) {
        let up = 0;
        for (let m = k - to; m <= k - from; m++) up += widths[m] as number;
        up /= to - from + 1;
        const w = widths[k] as number;
        const p = samples[k] as (typeof samples)[number];
        const roll = rng.next();
        const r = rng.float(NARROW_DAM_R_MIN, NARROW_DAM_R_MAX);
        if (up < 4 * CROSS_STEP_M || w >= up * NARROW_RATIO) continue;
        if (heightAt(terrain, p.x, p.y) >= markAt(p.x, p.y)) continue;
        if (last && Math.hypot(last.x - p.x, last.y - p.y) < NARROW_SPACING_M) continue;
        if (roll >= NARROW_CHANCE) continue;
        // Keep the whole dam in the patch.
        const x = Math.min(TILES_PER_SIDE * TILE_M, Math.max(0, p.x));
        const y = Math.min(TILES_PER_SIDE * TILE_M, Math.max(0, p.y));
        addDam('narrows', x, y, Math.min(r, Math.max(NARROW_DAM_R_MIN, w * 0.6)), null);
        last = p;
        narrowsDams++;
      }
    }

    // ---- Per-cell survey ----
    const cellCentre = (k: number): [number, number] => [((k % cells) + 0.5) * cellM, (Math.floor(k / cells) + 0.5) * cellM];
    const tileOfCell = (k: number): number => {
      const x = k % cells;
      const y = Math.floor(k / cells);
      return Math.floor(y / cellsPerTile) * TILES_PER_SIDE + Math.floor(x / cellsPerTile);
    };
    const steep = new Set<number>();
    const slopes = new Map<number, number>();
    const silty = new Set<number>();
    for (let k = 0; k < cells * cells; k++) {
      const [x, y] = cellCentre(k);
      if (landcoverAt(terrain, x, y) === LandCover.Water || isUnderWater(lakes, terrain, x, y, 0)) continue;
      const h = heightAt(terrain, x, y);
      const hw = markAt(x, y);
      const slope = slopeDegAt(terrain, x, y);
      if (slope > SLIP_SLOPE_DEG && h <= hw + SLIP_ABOVE_MARK_M) {
        steep.add(k);
        slopes.set(k, slope);
      }
      if (h < hw && slope < SILT_MAX_SLOPE_DEG && reliefAt(terrain, x, y) <= SILT_RELIEF_M) silty.add(k);
    }
    // Runs must stay inside one tile: cut the cell sets at tile edges by running per tile.
    const perTile = (set: ReadonlySet<number>): Map<number, Set<number>> => {
      const out = new Map<number, Set<number>>();
      for (const k of set) {
        const t = tileOfCell(k);
        const s = out.get(t) ?? new Set<number>();
        s.add(k);
        out.set(t, s);
      }
      return out;
    };

    // ---- Landslips ----
    const slips: Landslip[][] = tiles.map(() => []);
    for (const [t, set] of [...perTile(steep)].sort((a, b) => a[0] - b[0])) {
      const tile = tiles[t] as Districts['tiles'][number];
      let n = 0;
      for (const run of cellRuns(set, cells)) {
        const roll = rng.next();
        const seed = rng.pick(run);
        if (run.length < SLIP_MIN_CELLS || roll >= SLIP_CHANCE) continue;
        const blob = growBlob(run, cells, seed, SLIP_MAX_CELLS);
        const ring = cellRing(blob, cells, cellM);
        const mean = blob.reduce((s, k) => s + (slopes.get(k) as number), 0) / blob.length;
        slips[t]?.push({ id: `ls-${tile.id}-${n++}`, ...ringSpot(ring), ring, slopeDeg: r1(mean) });
      }
    }

    // ---- Silt flats and soft patches ----
    const silt: SiltFlat[][] = tiles.map(() => []);
    let patches = 0;
    for (const [t, set] of [...perTile(silty)].sort((a, b) => a[0] - b[0])) {
      const tile = tiles[t] as Districts['tiles'][number];
      let n = 0;
      for (const run of cellRuns(set, cells)) {
        if (run.length < SILT_MIN_CELLS) continue;
        const ring = cellRing(run, cells, cellM);
        const id = `sf-${tile.id}-${n++}`;
        const count = Math.min(SOFT_MAX, Math.max(1, Math.round(run.length / SOFT_CELLS_PER_PATCH)));
        const softPatches = [];
        for (let m = 0; m < count; m++) {
          const k = rng.pick(run);
          const r = rng.float(SOFT_R_MIN, SOFT_R_MAX);
          const x = (k % cells) * cellM + rng.float(r, cellM - r);
          const y = Math.floor(k / cells) * cellM + rng.float(r, cellM - r);
          softPatches.push({ id: `${id}-p${m}`, x: r1(x), y: r1(y), r: r1(r) });
        }
        patches += softPatches.length;
        silt[t]?.push({ id, ...ringSpot(ring), ring, softPatches });
      }
    }

    // ---- Fallen woodland ----
    const zones = tiles.flatMap((t) => t.strikeZones);
    const fallen: FallenWood[][] = tiles.map(() => []);
    let fellMark = 0;
    let fellStrike = 0;
    for (const wood of features.woods) {
      const roll = rng.next();
      const xs = wood.ring.map((p) => p[0]);
      const ys = wood.ring.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const x1 = Math.max(...xs);
      const y1 = Math.max(...ys);
      // Sample the wood on a grid; count the points per tile and the points below the mark.
      const perTileN = new Map<number, number>();
      let total = 0;
      let below = 0;
      const step = Math.max(WOOD_SAMPLE_M, Math.sqrt(((x1 - x0) * (y1 - y0)) / 400));
      for (let y = y0 + step / 2; y < y1; y += step) {
        for (let x = x0 + step / 2; x < x1; x += step) {
          if (!ringContains(wood.ring, x, y)) continue;
          total++;
          if (heightAt(terrain, x, y) < markAt(x, y)) below++;
          const t = tileOf(x, y);
          const k = t.j * TILES_PER_SIDE + t.i;
          perTileN.set(k, (perTileN.get(k) ?? 0) + 1);
        }
      }
      if (total === 0) {
        // A sliver with no sample point inside: take its first vertex.
        const [vx, vy] = wood.ring[0] as Pt;
        const t = tileOf(vx, vy);
        perTileN.set(t.j * TILES_PER_SIDE + t.i, 1);
        total = 1;
        below = heightAt(terrain, vx, vy) < markAt(vx, vy) ? 1 : 0;
      }
      const struck = zones.some((z) => ringContains(wood.ring, z.x, z.y) || wood.ring.some((p) => Math.hypot(p[0] - z.x, p[1] - z.y) < z.r));
      const byMark = below >= total * WOOD_BELOW_SHARE && roll < WOOD_FALL_CHANCE;
      if (!byMark && !struck) continue;
      if (byMark) fellMark++;
      else fellStrike++;
      for (const [k, count] of [...perTileN].sort((a, b) => a[0] - b[0])) {
        const tile = tiles[k] as Districts['tiles'][number];
        fallen[k]?.push({
          id: `fw-${tile.id}-${wood.id}`,
          woodId: wood.id,
          cause: byMark ? 'mark' : 'strike',
          share: Math.max(0.01, r2(count / total)),
        });
      }
    }

    // ---- Write ----
    tiles.forEach((tile, k) => {
      tile.wrackDams = wrack[k] as WrackDam[];
      tile.landslips = slips[k] as Landslip[];
      tile.siltFlats = silt[k] as SiltFlat[];
      tile.fallenWood = fallen[k] as FallenWood[];
    });
    const marker = ' [blockers] ';
    districts.method =
      districts.method.split(marker)[0] +
      marker +
      `Wrack dams: at bridges over a river or stream with the ground below the mark (${WRACK_STANDING_CHANCE * 100}% of standing bridges, ` +
      `${WRACK_FALLEN_CHANCE * 100}% of fallen ones), and at valley narrows below the mark: river points where the floor width (ground within ` +
      `${FLOOR_RISE_M} m of the filled-DEM bed, across the river) is under ${NARROW_RATIO * 100}% of its mean ${UPSTREAM_FROM_M} to ${UPSTREAM_TO_M} m ` +
      `upstream, ${NARROW_CHANCE * 100}% of them, ${NARROW_SPACING_M} m apart. Landslips: 4-connected runs of cells steeper than ${SLIP_SLOPE_DEG} degrees ` +
      `up to ${SLIP_ABOVE_MARK_M} m above the mark (never under ${LANDSLIP_MIN_SLOPE_DEG}), ${SLIP_CHANCE * 100}% of them, at most ${SLIP_MAX_CELLS} cells, cut at tile edges. ` +
      `Silt flats: runs of cells below the mark gentler than ${SILT_MAX_SLOPE_DEG} degrees and ${-SILT_RELIEF_M} m below the 500 m neighbourhood mean, ` +
      `${SILT_MIN_CELLS} cells or more per tile, with soft patches of ${SOFT_R_MIN} to ${SOFT_R_MAX} m radius, about one per ${SOFT_CELLS_PER_PATCH} cells. ` +
      `Fallen woodland: a wood falls if ${WOOD_BELOW_SHARE * 100}% of it is below the mark (${WOOD_FALL_CHANCE * 100}% chance) or a strike zone touches it; ` +
      'listed in every tile it lies in, with its share of the area.';

    const errs = validateDistricts(districts, features);
    if (errs.length > 0) throw new Error(`blockers: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
    writeFileSync(dir + 'districts.json', serialise(districts));
    const count = (f: (t: Districts['tiles'][number]) => number): number => tiles.reduce((s, t) => s + f(t), 0);
    console.log(
      `[worldgen] blockers: ${count((t) => t.wrackDams.length)} wrack dams (${bridgeDams} bridge, ${narrowsDams} narrows), ` +
        `${count((t) => t.landslips.length)} landslips, ${count((t) => t.siltFlats.length)} silt flats (${patches} soft patches), ` +
        `${fellMark} woods fallen by the mark and ${fellStrike} by strikes (${count((t) => t.fallenWood.length)} tile entries)`,
    );
  },
};
