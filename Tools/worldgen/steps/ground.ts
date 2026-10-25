// Ground detail: one file per 1 km tile in public/world/ground/<tileId>.json (see src/world/ground.ts).
// Debris (spec SX 02, "Debris near towns and roads", and the SX 03 bands), placed by likelihood from the committed
// world data on a 10 m raster:
// - Barriers: walls and hedge banks split into pieces of at most 10 m. All stand above the mark, about 70% in the
//   strandline and 20% in the scour zone, decided in runs of three pieces so breaches are 30 m gaps.
// - Rubble at ruined buildings: below the mark (as the renderer ruins them), or hit by a crater or strike zone.
//   Scour-zone rubble is washed downslope.
// - Cars along roads, thick near towns. Below the mark most were carried and dumped in the wrack line or a valley
//   bottom nearby.
// - Fallen trunks in woods below the mark, lying downslope with the backwash, and radially around big strike zones.
// - Wrack below the mark: density by distance from roads and buildings, piled in valley bottoms (flow accumulation and
//   relative height over the filled DEM), concentrated in a line within a few metres below the mark, and heaped
//   against the uphill face of standing walls and hedge banks.
// - Small craters (5 m up to the district threshold) at the district crater density times the size-curve ratio, so the
//   pocked falloff carries over; they stay off the start and out of lakes.
// - Doors on standing buildings (above the mark, not hit): one on the longest wall, some locked.
// - Loot (SX 01 Days 2 to 4, SX 03 bands; Tools/worldgen/rules/loot.ts): intact in standing buildings, sealed tins in the
//   strandline wrack, buried (needs digging) in scour-zone foundations. The camp armoury and store room are fixed by hand
//   (groundLoot in Tools/worldgen/overrides.json), never rolled.
// Each kind has its own RNG from this step's seed, so retuning one kind never reshuffles another.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Districts, Spot, StrikeZone } from '../../../src/world/districts';
import type { Features, Pt, SettlementKind } from '../../../src/world/features';
import { Band, bandFor, hwAt, parseFlood, type BandCode, type Flood, type FloodMeta } from '../../../src/world/flood';
import {
  BARRIER_BROKEN,
  BARRIER_STANDING,
  emptyGroundFile,
  encodeGround,
  objectKey,
  serialiseGround,
  validateGround,
  DEBRIS_KINDS,
  type DebrisKind,
  type GroundDoor,
  type GroundFile,
  type GroundItemRow,
  type GroundLoot,
  type GroundObject,
} from '../../../src/world/ground';
import { isUnderWater, parseLakes, type Lakes, type LakesMeta } from '../../../src/world/lakes';
import { START, TILES_PER_SIDE, TILE_M, heightAt, parseTerrain, tileId, tileOf, type Terrain, type TerrainMeta } from '../../../src/world/terrain';
import { GROUND_CRATER_MIN_D, PEAK_CRATERS_PER_TILE, CRATER_MIN_D, craterDiameter, poisson, smallCratersPerDistrictCrater } from '../rules/craters';
import { NO_LOOT_TYPES, SCOUR_LOOT_SCALE, rollBuildingLoot, rollWrackLoot } from '../rules/loot';
import { mulberry32, type Rng } from '../rng';
import { OVERRIDES_PATH } from './overrides';
import type { Step } from '../steps';

const dir = 'public/world/';
const SEED = 0x9a0d7e15;
/** Warn when one tile's file is larger than this, bytes. */
export const TILE_WARN_BYTES = 120 * 1024;
/** Fail when all tile files together are larger than this, bytes. */
export const TOTAL_MAX_BYTES = 4 * 1024 * 1024;
/** At most this many objects in one tile; wrack is thinned to fit. */
export const MAX_OBJECTS_PER_TILE = 3000;

/** Placement raster cell, metres. */
export const CELL_M = 10;
/** The wrack line: the band this many metres below the mark. */
export const WRACK_LINE_M = 4;
/** Chance a barrier piece stands, by band. Under a trapped lake counts as scour. */
export const BARRIER_STAND_P: Readonly<Record<BandCode, number>> = { 0: 1, 1: 0.7, 2: 0.2, 3: 0.2 };
const BARRIER_PIECE_M = 10;
const BARRIER_RUN = 3;
/** Strike zones at least this big (radius, m) throw their woods down radially, out to FALL_OUT_R radii. */
const BIG_ZONE_R = 40;
const FALL_OUT_R = 3;
/** How far a carried car can go, metres, and how many dump sites it tries. */
const CAR_CARRY_M = 350;
const CAR_TRIES = 16;
const CAR_STEP_M = 10;
/** Settlement reach for the urban term, metres. */
const SETTLE_R: Readonly<Record<SettlementKind, number>> = { town: 1200, village: 500, hamlet: 250, camp: 400 };
/** Building types that leave big rubble heaps. */
const BIG_TYPES = new Set(['church', 'industrial', 'school', 'military', 'farm']);

/** Small craters keep this far from the start, metres. */
const START_CLEAR_M = 60;
/** A door's width, metres, and the chance it is locked, by building type (unlisted types: 0.5). */
const DOOR_W_M = 0.9;
const LOCKED_P: Readonly<Record<string, number>> = { house: 0.5, farm: 0.6, shop: 0.7, pub: 0.7, church: 0.3, military: 0.5 };
/** Buildings of these types get no door (sheds, outbuildings). */
const NO_DOOR_TYPES: ReadonlySet<string> = new Set(['other']);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface GroundWorld {
  terrain: Terrain;
  flood: Flood;
  lakes: Lakes;
  features: Features;
  districts: Districts;
  /** Hand-fixed loot by building id (groundLoot in overrides.json). */
  fixedLoot: FixedLoot[];
}

/** One hand-set building: exactly these items, and whether its door is locked. */
export interface FixedLoot {
  building: string;
  locked: boolean;
  items: [string, number][];
  reason: string;
}

export function loadGroundWorld(base = dir): GroundWorld {
  const tmeta = JSON.parse(readFileSync(base + 'terrain.json', 'utf8')) as TerrainMeta;
  const terrain = parseTerrain(tmeta, readFileSync(base + 'terrain.bin'), readFileSync(base + 'landcover.bin'));
  const flood = parseFlood(JSON.parse(readFileSync(base + 'flood.json', 'utf8')) as FloodMeta, readFileSync(base + 'bands.bin'), terrain);
  const lakes = parseLakes(JSON.parse(readFileSync(base + 'lakes.json', 'utf8')) as LakesMeta, readFileSync(base + 'lakeid.bin'), terrain);
  const features = JSON.parse(readFileSync(base + 'features.json', 'utf8')) as Features;
  const districts = JSON.parse(readFileSync(base + 'districts.json', 'utf8')) as Districts;
  const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as { groundLoot?: FixedLoot[] };
  return { terrain, flood, lakes, features, districts, fixedLoot: overrides.groundLoot ?? [] };
}

/** Barrier polylines in features.json (not in the Features type, which lists what the renderer draws). */
interface BarrierFeature {
  id: string;
  kind: 'wall' | 'hedgebank' | 'fence';
  pts: Pt[];
}

// ---- rasters -----------------------------------------------------------------------------------

/** Two-pass chamfer distance (metres) to the nearest set cell of an n x n grid. */
function distanceField(src: Uint8Array, n: number, cell: number): Float32Array {
  const d = new Float32Array(n * n);
  for (let k = 0; k < d.length; k++) d[k] = src[k] ? 0 : 1e9;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      let v = d[k] as number;
      if (x > 0) v = Math.min(v, (d[k - 1] as number) + a);
      if (y > 0) {
        v = Math.min(v, (d[k - n] as number) + a);
        if (x > 0) v = Math.min(v, (d[k - n - 1] as number) + b);
        if (x < n - 1) v = Math.min(v, (d[k - n + 1] as number) + b);
      }
      d[k] = v;
    }
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const k = y * n + x;
      let v = d[k] as number;
      if (x < n - 1) v = Math.min(v, (d[k + 1] as number) + a);
      if (y < n - 1) {
        v = Math.min(v, (d[k + n] as number) + a);
        if (x < n - 1) v = Math.min(v, (d[k + n + 1] as number) + b);
        if (x > 0) v = Math.min(v, (d[k + n - 1] as number) + b);
      }
      d[k] = v;
    }
  }
  return d;
}

/** Sum over the (2r+1)^2 window around every cell of an n x n grid (clipped at the edges). */
function boxSum(src: ArrayLike<number>, w: number, h: number, r: number): Float64Array {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x] as number;
      sat[(y + 1) * (w + 1) + x + 1] = (sat[y * (w + 1) + x + 1] as number) + row;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      out[y * w + x] =
        (sat[y1 * (w + 1) + x1] as number) - (sat[y0 * (w + 1) + x1] as number) - (sat[y1 * (w + 1) + x0] as number) + (sat[y0 * (w + 1) + x0] as number);
    }
  }
  return out;
}

/**
 * Valley-bottom index (0 to 1) at every height post. Drainage is a priority flood from the patch edge: each post
 * drains to the post that reached it, so the tree runs through filled hollows too. Combines flow accumulation with
 * height below the mean of the surrounding 550 m square.
 */
export function valleyIndex(terrain: Terrain): Float32Array {
  const { postsX: w, postsY: h } = terrain.meta;
  const n = w * h;
  const heights = Float64Array.from(terrain.heightsDm, (dm) => dm / 10);
  const keys = new Float64Array(n);
  const vals = new Int32Array(n);
  let size = 0;
  const push = (key: number, val: number): void => {
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((keys[p] as number) <= key) break;
      keys[i] = keys[p] as number;
      vals[i] = vals[p] as number;
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  };
  let topKey = 0;
  const pop = (): number => {
    const val = vals[0] as number;
    topKey = keys[0] as number;
    const m = --size;
    if (m > 0) {
      const key = keys[m] as number;
      const v = vals[m] as number;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) break;
        if (c + 1 < m && (keys[c + 1] as number) < (keys[c] as number)) c++;
        if ((keys[c] as number) >= key) break;
        keys[i] = keys[c] as number;
        vals[i] = vals[c] as number;
        i = c;
      }
      keys[i] = key;
      vals[i] = v;
    }
    return val;
  };
  const recv = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const order = new Int32Array(n);
  let popped = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x !== 0 && y !== 0 && x !== w - 1 && y !== h - 1) continue;
      const k = y * w + x;
      seen[k] = 1;
      push(heights[k] as number, k);
    }
  }
  while (size > 0) {
    const k = pop();
    const level = topKey;
    order[popped++] = k;
    const x = k % w;
    const y = (k - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const m = ny * w + nx;
        if (seen[m]) continue;
        seen[m] = 1;
        recv[m] = k;
        push(Math.max(heights[m] as number, level), m);
      }
    }
  }
  const acc = new Float64Array(n).fill(1);
  for (let q = n - 1; q >= 0; q--) {
    const k = order[q] as number;
    const r = recv[k] as number;
    if (r >= 0) acc[r] = (acc[r] as number) + (acc[k] as number);
  }
  const R = 5;
  const sums = boxSum(heights, w, h, R);
  const counts = boxSum(new Float64Array(n).fill(1), w, h, R);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const rel = (heights[k] as number) - (sums[k] as number) / (counts[k] as number);
    const flow = clamp01((Math.log10(acc[k] as number) - 0.7) / 1.6);
    out[k] = clamp01(0.5 * flow + 0.6 * clamp01(-rel / 12));
  }
  return out;
}

interface Rasters {
  n: number;
  /** Ground height minus the mark, metres, at cell centres. */
  e: Float32Array;
  /** Band at cell centres, 3 under a trapped lake at spill. */
  band: Uint8Array;
  /** Distance to the nearest road (not a path), metres. */
  road: Float32Array;
  /** 0 open country to 1 town centre: built area nearby plus settlement reach. */
  urban: Float32Array;
  valley: Float32Array;
  wood: Uint8Array;
}

/** Shoelace sum over 2: positive for a counter-clockwise ring (x east, y north). */
const ringSignedArea = (ring: readonly Pt[]): number => {
  let a = 0;
  for (let k = 1; k < ring.length; k++) {
    const p = ring[k - 1] as Pt;
    const q = ring[k] as Pt;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
const ringArea = (ring: readonly Pt[]): number => Math.abs(ringSignedArea(ring));

/** Vertex mean, leaving out the closing repeat. */
const ringCentre = (ring: readonly Pt[]): Pt => {
  const m = ring.length > 1 ? ring.length - 1 : 1;
  let x = 0;
  let y = 0;
  for (let k = 0; k < m; k++) {
    x += (ring[k] as Pt)[0] / m;
    y += (ring[k] as Pt)[1] / m;
  }
  return [x, y];
};

function buildRasters(w: GroundWorld): Rasters {
  const { terrain, flood, lakes, features } = w;
  const n = Math.round(terrain.sizeX / CELL_M);
  const N = n * n;
  const e = new Float32Array(N);
  const band = new Uint8Array(N);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const x = (cx + 0.5) * CELL_M;
      const y = (cy + 0.5) * CELL_M;
      const h = heightAt(terrain, x, y);
      const hw = hwAt(flood.hw, x, y);
      const k = cy * n + cx;
      e[k] = h - hw;
      band[k] = isUnderWater(lakes, terrain, x, y, 0) ? Band.UnderWater : bandFor(h, hw);
    }
  }

  const roadCells = new Uint8Array(N);
  for (const r of features.roads) {
    if (r.cls === 'path') continue;
    for (let k = 1; k < r.pts.length; k++) {
      const [ax, ay] = r.pts[k - 1] as Pt;
      const [bx, by] = r.pts[k] as Pt;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL_M / 2)));
      for (let s = 0; s <= steps; s++) {
        const cx = Math.floor((ax + ((bx - ax) * s) / steps) / CELL_M);
        const cy = Math.floor((ay + ((by - ay) * s) / steps) / CELL_M);
        if (cx >= 0 && cy >= 0 && cx < n && cy < n) roadCells[cy * n + cx] = 1;
      }
    }
  }
  const road = distanceField(roadCells, n, CELL_M);

  const built = new Float64Array(N);
  for (const b of features.buildings) {
    const [x, y] = ringCentre(b.ring);
    const cx = Math.floor(x / CELL_M);
    const cy = Math.floor(y / CELL_M);
    if (cx >= 0 && cy >= 0 && cx < n && cy < n) built[cy * n + cx] = (built[cy * n + cx] as number) + ringArea(b.ring);
  }
  const BR = 8;
  const builtNear = boxSum(built, n, n, BR);
  const windowM2 = (2 * BR + 1) ** 2 * CELL_M * CELL_M;
  const urban = new Float32Array(N);
  const settlements = features.settlements ?? [];
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const x = (cx + 0.5) * CELL_M;
      const y = (cy + 0.5) * CELL_M;
      let s = 0;
      for (const st of settlements) s = Math.max(s, Math.exp(-((Math.hypot(x - st.x, y - st.y) / SETTLE_R[st.kind]) ** 2)));
      const k = cy * n + cx;
      urban[k] = clamp01((builtNear[k] as number) / windowM2 / 0.12 + 0.35 * s);
    }
  }

  const vp = valleyIndex(terrain);
  const { postsX, postsY, cellM } = terrain.meta;
  const valley = new Float32Array(N);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const fx = Math.min(postsX - 1.001, ((cx + 0.5) * CELL_M) / cellM);
      const fy = Math.min(postsY - 1.001, ((cy + 0.5) * CELL_M) / cellM);
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const u = fx - i;
      const v = fy - j;
      const k = j * postsX + i;
      valley[cy * n + cx] =
        ((vp[k] as number) * (1 - u) + (vp[k + 1] as number) * u) * (1 - v) +
        ((vp[k + postsX] as number) * (1 - u) + (vp[k + postsX + 1] as number) * u) * v;
    }
  }

  // Woods: scanline fill of each polygon over the cell centres.
  const wood = new Uint8Array(N);
  for (const wd of features.woods) {
    const ring = wd.ring;
    const ys = ring.map((p) => p[1]);
    const cy0 = Math.max(0, Math.floor(Math.min(...ys) / CELL_M));
    const cy1 = Math.min(n - 1, Math.floor(Math.max(...ys) / CELL_M));
    for (let cy = cy0; cy <= cy1; cy++) {
      const y = (cy + 0.5) * CELL_M;
      const xs: number[] = [];
      for (let k = 1; k < ring.length; k++) {
        const [ax, ay] = ring[k - 1] as Pt;
        const [bx, by] = ring[k] as Pt;
        if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((p, q) => p - q);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const cx0 = Math.max(0, Math.ceil((xs[m] as number) / CELL_M - 0.5));
        const cx1 = Math.min(n - 1, Math.floor((xs[m + 1] as number) / CELL_M - 0.5));
        for (let cx = cx0; cx <= cx1; cx++) wood[cy * n + cx] = 1;
      }
    }
  }
  return { n, e, band, road, urban, valley, wood };
}

// ---- placement ---------------------------------------------------------------------------------

interface Placed {
  kind: DebrisKind;
  x: number;
  y: number;
  rot: number;
  size: number;
  extra?: number;
  /** Loot this object holds ('' building when it is not in a building). */
  loot?: { building: string; items: GroundItemRow[] };
  /** A door: the building and whether it is locked. */
  door?: { building: string; locked: boolean };
}

/** Radians clockwise from north for a direction (dx east, dy north). */
const heading = (dx: number, dy: number): number => Math.atan2(dx, dy);

/** Number of objects for an expected count lambda: one draw, always. */
function countFor(rng: Rng, lambda: number): number {
  const base = Math.floor(lambda);
  return base + (rng.next() < lambda - base ? 1 : 0);
}

export interface GroundStats {
  counts: Record<DebrisKind, number>;
  thinned: number;
}

/** The tile files to write, before serialising. */
export function buildGroundFiles(w: GroundWorld = loadGroundWorld()): { files: GroundFile[]; stats: GroundStats } {
  const { terrain, features, districts } = w;
  const R = buildRasters(w);
  const { n } = R;
  const size = n * CELL_M;
  const cellOf = (x: number, y: number): number => {
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x / CELL_M)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y / CELL_M)));
    return cy * n + cx;
  };
  const isBelow = (b: number): boolean => b === Band.Strandline || b === Band.Scour;
  const inWrackLine = (k: number): boolean => (R.e[k] as number) <= 0 && (R.e[k] as number) > -WRACK_LINE_M;
  /** Downhill heading at (x, y) from the 50 m terrain, or undefined on the flat. */
  const downhill = (x: number, y: number): number | undefined => {
    const d = 25;
    const gx = heightAt(terrain, x + d, y) - heightAt(terrain, x - d, y);
    const gy = heightAt(terrain, x, y + d) - heightAt(terrain, x, y - d);
    return Math.hypot(gx, gy) < 0.05 ? undefined : heading(-gx, -gy);
  };
  const rngFor = (k: number): Rng => mulberry32((SEED + Math.imul(k + 1, 0x9e3779b1)) >>> 0);

  const zones: StrikeZone[] = districts.tiles.flatMap((t) => t.strikeZones);
  const craters: Spot[] = districts.tiles.flatMap((t) => t.craters);
  const inSpot = (spots: readonly Spot[], x: number, y: number): boolean => spots.some((s) => Math.hypot(x - s.x, y - s.y) <= s.r);

  const placed: Placed[] = [];

  // Barriers.
  const barrierRng = rngFor(0);
  const standingBelow: { x: number; y: number; ux: number; uy: number; len: number }[] = [];
  const barriers = ((features as unknown as { barriers?: BarrierFeature[] }).barriers ?? []).filter((b) => b.kind !== 'fence');
  for (const b of barriers) {
    let run = 0;
    let runBand = -1;
    let standing = true;
    for (let k = 1; k < b.pts.length; k++) {
      const [ax, ay] = b.pts[k - 1] as Pt;
      const [bx, by] = b.pts[k] as Pt;
      const L = Math.hypot(bx - ax, by - ay);
      if (L === 0) continue;
      const pieces = Math.ceil(L / BARRIER_PIECE_M);
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      for (let p = 0; p < pieces; p++) {
        const t = (p + 0.5) / pieces;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const band = R.band[cellOf(x, y)] as BandCode;
        const roll = barrierRng.next();
        if (run === 0 || band !== runBand) {
          standing = roll < BARRIER_STAND_P[band];
          runBand = band;
          run = BARRIER_RUN;
        }
        run--;
        placed.push({
          kind: b.kind as DebrisKind,
          x,
          y,
          rot: heading(ux, uy),
          size: L / pieces,
          extra: standing ? BARRIER_STANDING : BARRIER_BROKEN,
        });
        if (standing && isBelow(band)) standingBelow.push({ x, y, ux, uy, len: L / pieces });
      }
    }
  }

  // Rubble at ruined buildings.
  const rubbleRng = rngFor(1);
  const ruined = (x: number, y: number): boolean =>
    isBelow(R.band[cellOf(x, y)] as number) || inSpot(zones, x, y) || inSpot(craters, x, y);
  for (const b of features.buildings) {
    const [cx, cy] = ringCentre(b.ring);
    if (!ruined(cx, cy)) continue;
    const area = ringArea(b.ring);
    const big = BIG_TYPES.has(b.type);
    const piles = Math.min(big ? 10 : 6, Math.max(1, Math.round(area / (big ? 90 : 70))));
    const xs = b.ring.map((p) => p[0]);
    const ys = b.ring.map((p) => p[1]);
    const hx = (Math.max(...xs) - Math.min(...xs)) * 0.4;
    const hy = (Math.max(...ys) - Math.min(...ys)) * 0.4;
    const scour = R.band[cellOf(cx, cy)] === Band.Scour;
    const down = downhill(cx, cy);
    for (let p = 0; p < piles; p++) {
      let x = cx + rubbleRng.float(-hx, hx);
      let y = cy + rubbleRng.float(-hy, hy);
      const wash = rubbleRng.float(0, 20);
      if (scour && down !== undefined) {
        x += Math.sin(down) * wash;
        y += Math.cos(down) * wash;
      }
      const s = Math.sqrt(area / piles) * rubbleRng.float(0.7, 1.1) * (scour ? 0.7 : 1);
      placed.push({ kind: 'rubble', x, y, rot: rubbleRng.float(0, 2 * Math.PI), size: Math.min(12, Math.max(2, s)) });
    }
  }

  // Cars.
  const carRng = rngFor(2);
  const dumpScore = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= size || y >= size) return -Infinity;
    const k = cellOf(x, y);
    const band = R.band[k] as number;
    if (!isBelow(band)) return -Infinity;
    return (R.valley[k] as number) + (inWrackLine(k) ? 1.2 : 0) + (band === Band.Strandline ? 0.4 : 0);
  };
  for (const r of features.roads) {
    if (r.cls !== 'A' && r.cls !== 'B' && r.cls !== 'minor') continue;
    let carry = carRng.float(0, CAR_STEP_M);
    for (let k = 1; k < r.pts.length; k++) {
      const [ax, ay] = r.pts[k - 1] as Pt;
      const [bx, by] = r.pts[k] as Pt;
      const L = Math.hypot(bx - ax, by - ay);
      if (L === 0) continue;
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      for (; carry < L; carry += CAR_STEP_M) {
        const sx = ax + ux * carry;
        const sy = ay + uy * carry;
        const kc = cellOf(sx, sy);
        const u = R.urban[kc] as number;
        const p = 0.01 + 0.3 * u ** 1.5 + (r.cls === 'A' ? 0.03 : 0);
        if (carRng.next() >= p) continue;
        const side = carRng.next() < 0.5 ? -1 : 1;
        const off = side * carRng.float(2.2, 3.5);
        let x = sx - uy * off;
        let y = sy + ux * off;
        let rot = heading(ux, uy) + (carRng.next() < 0.5 ? 0 : Math.PI) + carRng.normal(0, 0.05);
        const len = carRng.float(3.8, 4.8);
        const band = R.band[kc] as number;
        const carried = carRng.next() < (band === Band.Scour ? 0.9 : band === Band.Strandline ? 0.6 : band === Band.UnderWater ? 1 : 0);
        if (carried) {
          let best = -Infinity;
          let bxy: [number, number] | undefined;
          for (let t = 0; t < CAR_TRIES; t++) {
            const a = carRng.float(0, 2 * Math.PI);
            const d = CAR_CARRY_M * Math.sqrt(carRng.next());
            const qx = sx + Math.sin(a) * d;
            const qy = sy + Math.cos(a) * d;
            const s = dumpScore(qx, qy);
            if (s > best) {
              best = s;
              bxy = [qx, qy];
            }
          }
          rot = carRng.float(0, 2 * Math.PI);
          if (!bxy) continue; // Carried off the patch or into a lake.
          [x, y] = bxy;
        }
        placed.push({ kind: 'car', x, y, rot, size: len });
      }
      carry -= L;
    }
  }

  // Fallen trunks: woods below the mark lie downslope with the backwash; big strike zones throw them outward.
  const trunkRng = rngFor(3);
  const bigZones = zones.filter((z) => z.r >= BIG_ZONE_R);
  const nearZone = (x: number, y: number): boolean => bigZones.some((z) => Math.hypot(x - z.x, y - z.y) <= z.r * FALL_OUT_R);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const k = cy * n + cx;
      if (!R.wood[k]) continue;
      const band = R.band[k] as number;
      if (!isBelow(band)) continue;
      const x0 = cx * CELL_M;
      const y0 = cy * CELL_M;
      const c = countFor(trunkRng, band === Band.Scour ? 0.12 : 0.08);
      if (nearZone(x0 + CELL_M / 2, y0 + CELL_M / 2)) continue;
      for (let m = 0; m < c; m++) {
        const x = x0 + trunkRng.next() * CELL_M;
        const y = y0 + trunkRng.next() * CELL_M;
        const down = downhill(x, y) ?? trunkRng.float(0, 2 * Math.PI);
        placed.push({ kind: 'trunk', x, y, rot: down + trunkRng.normal(0, 0.35), size: trunkRng.float(9, 20) });
      }
    }
  }
  for (const z of bigZones) {
    const reach = z.r * FALL_OUT_R;
    for (let cy = Math.max(0, Math.floor((z.y - reach) / CELL_M)); cy <= Math.min(n - 1, Math.floor((z.y + reach) / CELL_M)); cy++) {
      for (let cx = Math.max(0, Math.floor((z.x - reach) / CELL_M)); cx <= Math.min(n - 1, Math.floor((z.x + reach) / CELL_M)); cx++) {
        const k = cy * n + cx;
        if (!R.wood[k] || R.band[k] === Band.UnderWater) continue;
        const d = Math.hypot((cx + 0.5) * CELL_M - z.x, (cy + 0.5) * CELL_M - z.y);
        if (d > reach || d < z.r * 0.7) continue;
        const c = countFor(trunkRng, 0.3 * (1 - (d - z.r * 0.7) / (reach - z.r * 0.7)) + 0.05);
        for (let m = 0; m < c; m++) {
          const x = cx * CELL_M + trunkRng.next() * CELL_M;
          const y = cy * CELL_M + trunkRng.next() * CELL_M;
          placed.push({ kind: 'trunk', x, y, rot: heading(x - z.x, y - z.y) + trunkRng.normal(0, 0.1), size: trunkRng.float(8, 18) });
        }
      }
    }
  }

  // Wrack: spread by roads and buildings, piled in valley bottoms, lined along the mark, heaped on standing barriers.
  const wrackRng = rngFor(4);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const k = cy * n + cx;
      const band = R.band[k] as number;
      if (!isBelow(band)) {
        wrackRng.next();
        continue;
      }
      const u = R.urban[k] as number;
      const v = R.valley[k] as number;
      const near = 0.003 + 0.02 * Math.exp(-(R.road[k] as number) / 60) + 0.08 * u;
      let lambda = near * (0.25 + 3 * v) * (band === Band.Strandline ? 1.5 : 1);
      if (inWrackLine(k)) lambda += 0.12 * (1 + (R.e[k] as number) / (2 * WRACK_LINE_M));
      const c = countFor(wrackRng, lambda);
      for (let m = 0; m < c; m++) {
        const x = (cx + wrackRng.next()) * CELL_M;
        const y = (cy + wrackRng.next()) * CELL_M;
        const rot = wrackRng.float(0, 2 * Math.PI);
        if (wrackRng.next() < 0.08) placed.push({ kind: 'trunk', x, y, rot, size: wrackRng.float(4, 10) });
        else placed.push({ kind: 'wrack', x, y, rot, size: wrackRng.float(1.5, 4) + 3 * v });
      }
    }
  }
  for (const s of standingBelow) {
    const k = cellOf(s.x, s.y);
    const c = countFor(wrackRng, Math.min(2, 0.25 + 1.5 * (R.urban[k] as number) + 1.2 * (R.valley[k] as number)));
    // The uphill face: backwash drove the debris down against it.
    const left = heightAt(terrain, s.x - s.uy * 5, s.y + s.ux * 5);
    const right = heightAt(terrain, s.x + s.uy * 5, s.y - s.ux * 5);
    const side = left >= right ? 1 : -1;
    for (let m = 0; m < c; m++) {
      const t = wrackRng.float(-s.len / 2, s.len / 2);
      const off = side * wrackRng.float(1.2, 2.2);
      placed.push({
        kind: 'wrack',
        x: s.x + s.ux * t - s.uy * off,
        y: s.y + s.uy * t + s.ux * off,
        rot: heading(s.ux, s.uy),
        size: wrackRng.float(2, 5),
      });
    }
  }

  // Small craters: the district density (PEAK_CRATERS_PER_TILE x pocked) times the curve's small-to-district ratio.
  const craterRng = rngFor(6);
  const perDistrictCrater = smallCratersPerDistrictCrater();
  for (const dt of districts.tiles) {
    const c = poisson(craterRng, PEAK_CRATERS_PER_TILE * dt.pocked * perDistrictCrater);
    for (let m = 0; m < c; m++) {
      const x = (dt.i + craterRng.next()) * TILE_M;
      const y = (dt.j + craterRng.next()) * TILE_M;
      const d = craterDiameter(craterRng, GROUND_CRATER_MIN_D, CRATER_MIN_D);
      const rot = craterRng.float(0, 2 * Math.PI);
      if (R.band[cellOf(x, y)] === Band.UnderWater || Math.hypot(x - START.x, y - START.y) < START_CLEAR_M + d / 2) continue;
      placed.push({ kind: 'crater', x, y, rot, size: d });
    }
  }

  // Buildings: a door on every standing one, loot by band. Standing: above the mark and not hit by a crater or strike zone.
  const lootRng = rngFor(7);
  const doorRng = rngFor(8);
  const fixed = new Map(w.fixedLoot.map((f) => [f.building, f]));
  const seenFixed = new Set<string>();
  for (const b of features.buildings) {
    const [cx, cy] = ringCentre(b.ring);
    const band = R.band[cellOf(cx, cy)] as BandCode;
    const standing = band === Band.Above && !inSpot(zones, cx, cy) && !inSpot(craters, cx, cy);
    const hand = fixed.get(b.id);
    if (hand) seenFixed.add(b.id);
    const area = ringArea(b.ring);
    // Hand-fixed loot is out in the open whatever the band: the camp is in the scour zone but its armoury is cracked open.
    let items: GroundItemRow[] = [];
    if (hand) items = hand.items.map(([id, qty]): GroundItemRow => [id, qty, 0]);
    else if (!NO_LOOT_TYPES.has(b.type) && area >= 12) {
      if (standing) items = rollBuildingLoot(lootRng, b.type).map(([id, qty]): GroundItemRow => [id, qty, 0]);
      // Scour: what the foundations and cellars hold, under the silt. Strandline loot is in the wrack instead.
      else if (band === Band.Scour) items = rollBuildingLoot(lootRng, b.type, SCOUR_LOOT_SCALE).map(([id, qty]): GroundItemRow => [id, qty, 1]);
    }
    if (items.length > 0) {
      placed.push({ kind: 'spot', x: cx, y: cy, rot: 0, size: Math.min(20, Math.sqrt(area)), loot: { building: b.id, items } });
    }
    if (!standing || NO_DOOR_TYPES.has(b.type)) continue;
    // The door goes mid-way along the longest wall, facing out (the right of the walking direction for a counter-clockwise ring).
    let best = 0;
    let at = 1;
    for (let k = 1; k < b.ring.length; k++) {
      const len = Math.hypot((b.ring[k] as Pt)[0] - (b.ring[k - 1] as Pt)[0], (b.ring[k] as Pt)[1] - (b.ring[k - 1] as Pt)[1]);
      if (len > best) {
        best = len;
        at = k;
      }
    }
    const [ax, ay] = b.ring[at - 1] as Pt;
    const [bx, by] = b.ring[at] as Pt;
    const ccw = ringSignedArea(b.ring) > 0 ? 1 : -1;
    const lockedRoll = doorRng.next();
    if (best < 2) continue;
    placed.push({
      kind: 'door',
      x: (ax + bx) / 2,
      y: (ay + by) / 2,
      rot: heading(((by - ay) / best) * ccw, (-(bx - ax) / best) * ccw),
      size: DOOR_W_M,
      door: { building: b.id, locked: hand ? hand.locked : lockedRoll < (LOCKED_P[b.type] ?? 0.5) },
    });
  }
  for (const f of w.fixedLoot) if (!seenFixed.has(f.building)) throw new Error(`ground: hand-fixed loot in ${f.building}: no such building`);

  // Into tiles, by final position. A tile over the object cap or the file budget is thinned: wrack first, then small
  // craters, then rolled loot spots; everything else stays.
  const perTile: Placed[][] = Array.from({ length: TILES_PER_SIDE * TILES_PER_SIDE }, () => []);
  for (const p of placed) {
    if (!(p.x >= 0 && p.y >= 0 && p.x < size && p.y < size)) continue;
    const t = tileOf(p.x, p.y);
    (perTile[t.j * TILES_PER_SIDE + t.i] as Placed[]).push(p);
  }
  const thinRng = rngFor(5);
  let thinned = 0;
  const counts = Object.fromEntries(DEBRIS_KINDS.map((k) => [k, 0])) as Record<DebrisKind, number>;
  const toItems = (rows: GroundItemRow[]): GroundLoot['items'] => rows.map(([itemId, qty, buried]) => ({ itemId, qty, buried: buried === 1 }));
  /** The tile's file for these placed objects; strandline wrack may carry sealed tins. */
  const fileFor = (i: number, j: number, list: readonly Placed[]): GroundFile => {
    const id = tileId(i, j);
    const wrackRng = rngFor(100 + j * TILES_PER_SIDE + i);
    const loot: GroundLoot[] = [];
    const doors: GroundDoor[] = [];
    const objects = list.map((p, k): GroundObject => {
      const o: GroundObject = {
        key: objectKey(id, k),
        kind: p.kind,
        x: Math.min((i + 1) * TILE_M, Math.max(i * TILE_M, p.x)),
        y: Math.min((j + 1) * TILE_M, Math.max(j * TILE_M, p.y)),
        rot: p.rot,
        size: p.size,
      };
      if (p.extra !== undefined) o.extra = p.extra;
      if (p.loot) loot.push({ obj: o.key, building: p.loot.building, items: toItems(p.loot.items) });
      if (p.door) doors.push({ obj: o.key, building: p.door.building, locked: p.door.locked });
      if (p.kind === 'wrack' && R.band[cellOf(p.x, p.y)] === Band.Strandline) {
        const items = rollWrackLoot(wrackRng, R.urban[cellOf(p.x, p.y)] as number);
        if (items.length > 0) loot.push({ obj: o.key, building: '', items: toItems(items) });
      }
      return o;
    });
    return objects.length === 0 ? emptyGroundFile(id) : encodeGround({ tile: id, i, j, objects, loot, doors });
  };
  const files: GroundFile[] = [];
  for (let j = 0; j < TILES_PER_SIDE; j++) {
    for (let i = 0; i < TILES_PER_SIDE; i++) {
      const all = perTile[j * TILES_PER_SIDE + i] as Placed[];
      // Drop order: wrack in random order, then craters, then rolled loot spots; the rest (and hand-fixed spots) stays.
      const keyOf = (p: Placed): number =>
        p.kind === 'wrack' ? thinRng.next() : p.kind === 'crater' ? 1 + thinRng.next() : p.kind === 'spot' && !fixed.has(p.loot?.building ?? '') ? 2 + thinRng.next() : 9;
      const order = all
        .map((p, k) => ({ k, key: keyOf(p) }))
        .filter((d) => d.key < 9)
        .sort((x, y) => x.key - y.key || x.k - y.k);
      let drop = Math.min(order.length, Math.max(0, all.length - MAX_OBJECTS_PER_TILE));
      let file: GroundFile;
      for (;;) {
        const gone = new Set(order.slice(0, drop).map((d) => d.k));
        const list = gone.size === 0 ? all : all.filter((_, k) => !gone.has(k));
        file = fileFor(i, j, list);
        if (drop >= order.length || Buffer.byteLength(serialiseGround(file)) <= TILE_WARN_BYTES) {
          thinned = thinned + gone.size;
          for (const p of list) counts[p.kind]++;
          break;
        }
        drop = Math.min(order.length, drop + Math.ceil(all.length * 0.02));
      }
      files.push(file);
    }
  }
  return { files, stats: { counts, thinned } };
}

/** Budget problems for serialised files: warnings above TILE_WARN_BYTES each, an error above TOTAL_MAX_BYTES in all. */
export function checkGroundBudget(sizes: ReadonlyMap<string, number>): { warnings: string[]; error?: string } {
  const warnings: string[] = [];
  let total = 0;
  for (const [tile, bytes] of sizes) {
    total += bytes;
    if (bytes > TILE_WARN_BYTES) warnings.push(`${tile}: ${(bytes / 1024).toFixed(1)} KB (budget ${TILE_WARN_BYTES / 1024} KB)`);
  }
  const error = total > TOTAL_MAX_BYTES ? `total ${(total / 1048576).toFixed(2)} MB over ${TOTAL_MAX_BYTES / 1048576} MB` : undefined;
  return error ? { warnings, error } : { warnings };
}

export const groundStep: Step = {
  name: 'ground',
  run() {
    const { files, stats } = buildGroundFiles();
    const text = new Map<string, string>();
    const sizes = new Map<string, number>();
    for (const f of files) {
      const errs = validateGround(f, f.tile);
      if (errs.length > 0) throw new Error(`ground ${f.tile}: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
      const s = serialiseGround(f);
      text.set(f.tile, s);
      sizes.set(f.tile, Buffer.byteLength(s));
    }
    const budget = checkGroundBudget(sizes);
    for (const w of budget.warnings) console.warn(`[worldgen] ground: ${w}`);
    if (budget.error) throw new Error(`ground: ${budget.error}`);
    mkdirSync(`${dir}ground/`, { recursive: true });
    for (const [tile, s] of text) writeFileSync(`${dir}ground/${tile}.json`, s);
    const total = [...sizes.values()].reduce((a, b) => a + b, 0);
    const objects = files.reduce((a, f) => a + f.o.length, 0);
    const most = Math.max(...files.map((f) => f.o.length));
    console.log(
      `[worldgen] ground: ${files.length} tiles, ${objects} objects (${JSON.stringify(stats.counts)}, ${stats.thinned} wrack or craters thinned, ` +
        `most in a tile ${most}), ${(total / 1024).toFixed(1)} KB`,
    );
  },
};
