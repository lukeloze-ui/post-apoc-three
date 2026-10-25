// Strikes and what they left: craters, strike zones, fires, gas hollows and animal counts per tile.
// Reads districts.json (written by the districts step just before) and fills the tile lists. Own RNG and seed.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  GAS_FROM_DAY,
  GAS_TO_DAY,
  validateDistricts,
  type AnimalKind,
  type Crater,
  type Districts,
  type Fire,
  type GasHollow,
  type StrikeZone,
} from '../../../src/world/districts';
import type { BuildingFeature, Features, Pt, WoodFeature } from '../../../src/world/features';
import { Band, bandAt, parseFlood, type BandCode, type FloodMeta } from '../../../src/world/flood';
import { osgbToLocal } from '../../../src/world/geo';
import { isUnderWater, parseLakes, type LakesMeta } from '../../../src/world/lakes';
import {
  LandCover,
  START,
  TILES_PER_SIDE,
  TILE_M,
  YES_TOR,
  landcoverAt,
  parseTerrain,
  tileOf,
  type TerrainMeta,
} from '../../../src/world/terrain';
import { STORM } from '../decisions';
import {
  CRATER_MAX_D,
  CRATER_MIN_D,
  PEAK_CRATERS_PER_TILE,
  canSee,
  craterDiameter,
  poisson,
  reliefAt,
  strikeDensity,
} from '../rules/craters';
import { mulberry32 } from '../rng';
import type { Step } from '../steps';
import { serialise } from './districts';

const dir = 'public/world/';
const SEED = 0xc4a7e25;

/** Craters keep this far from the start, metres. */
const START_CLEAR_M = 60;
/** Crater diameter from which a crater can hold standing water, and the relief (m) that counts as low ground. */
const WATER_MIN_D = 25;
const WATER_RELIEF_M = -3;
const WATER_CHANCE = 0.6;
/** A crater in a wood or on a building starts a fire with these chances. */
const WOOD_FIRE_CHANCE = 0.6;
const BUILDING_FIRE_CHANCE = 0.75;

/** Strike zones: 3 or 4 of 100 to 300 m across. Edge clearances from the start and from the camp's military buildings, metres. */
const ZONE_COUNT = 4;
const ZONE_MIN_D = 100;
const ZONE_MAX_D = 300;
const ZONE_START_CLEAR_M = 800;
const ZONE_CAMP_CLEAR_M = 500;
const ZONE_SPACING_M = 1000;
/** The first zone is a burning one seen from Yes Tor: within this range, with a plume this tall, from a walker's eye. */
const ZONE_SEEN_RANGE_M = 9000;
const PLUME_M = 60;
const EYE_M = 1.7;

/** Gas pools in cells this much below the mean of their 500 m neighbourhood (half as much in built-up cells). */
const GAS_RELIEF_M = -20;
const GAS_MIN_CELLS = 3;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ring: readonly Pt[];
}

function boxOf(ring: readonly Pt[]): Box {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), ring };
}

function inRing(ring: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
    const [xi, yi] = ring[k] as Pt;
    const [xj, yj] = ring[m] as Pt;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inAny = (boxes: readonly Box[], x: number, y: number): boolean =>
  boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && inRing(b.ring, x, y));

export const cratersStep: Step = {
  name: 'craters',
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
    const cellsPerSide = tmeta.postsX - 1;
    const cellsPerTile = TILE_M / cellM;

    const woods = features.woods.map((w: WoodFeature) => boxOf(w.ring));
    const buildings = features.buildings.map((b: BuildingFeature) => boxOf(b.ring));
    const military = features.buildings.filter((b) => b.type === 'military').flatMap((b) => b.ring);
    const camp = features.settlements?.find((s) => s.kind === 'camp');
    if (camp) military.push([camp.x, camp.y]);

    const rng = mulberry32(SEED);
    const centre = osgbToLocal(STORM.e, STORM.n);
    const densityAt = (x: number, y: number): number => strikeDensity(Math.hypot(x - centre.x, y - centre.y));
    const lc = (x: number, y: number): number => landcoverAt(terrain, x, y);
    const cellBand = (cx: number, cy: number): BandCode => {
      const x = (cx + 0.5) * cellM;
      const y = (cy + 0.5) * cellM;
      return isUnderWater(lakes, terrain, x, y, 0) ? Band.UnderWater : bandAt(flood, cellM, cellsPerSide, x, y);
    };

    // Strike zones. The first is a burning one that Yes Tor can see; the rest follow the storm density.
    const zones: StrikeZone[] = [];
    const MOOR_OR_WOOD: number[] = [LandCover.Wood, LandCover.MoorGrass, LandCover.Heather, LandCover.Bog];
    const burns = (x: number, y: number): boolean => inAny(woods, x, y) || MOOR_OR_WOOD.includes(lc(x, y));
    for (let attempt = 0; attempt < 200_000 && zones.length < ZONE_COUNT; attempt++) {
      const x = rng.float(300, TILES_PER_SIDE * TILE_M - 300);
      const y = rng.float(300, TILES_PER_SIDE * TILE_M - 300);
      const D = craterDiameter(rng, ZONE_MIN_D, ZONE_MAX_D);
      if (rng.next() > densityAt(x, y)) continue;
      const r = D / 2;
      if (lc(x, y) === LandCover.Water || isUnderWater(lakes, terrain, x, y, 0)) continue;
      if (Math.hypot(x - START.x, y - START.y) < r + ZONE_START_CLEAR_M) continue;
      if (military.some((p) => Math.hypot(x - p[0], y - p[1]) < r + ZONE_CAMP_CLEAR_M)) continue;
      if (zones.some((z) => Math.hypot(x - z.x, y - z.y) < ZONE_SPACING_M + z.r + r)) continue;
      const kind = burns(x, y) ? 'burning' : 'glassy';
      if (zones.length === 0) {
        if (kind !== 'burning' || Math.hypot(x - YES_TOR.x, y - YES_TOR.y) > ZONE_SEEN_RANGE_M) continue;
        if (!canSee(terrain, YES_TOR.x, YES_TOR.y, EYE_M, x, y, PLUME_M)) continue;
      }
      zones.push({ id: `sz-${zones.length}`, x: r1(x), y: r1(y), r: r1(r), kind });
    }
    if (zones.length < 2) throw new Error(`craters: only ${zones.length} strike zone(s) placed`);

    const crossesTile = (z: { x: number; y: number }): number => tileOf(z.x, z.y).j * TILES_PER_SIDE + tileOf(z.x, z.y).i;
    const tiles = districts.tiles;
    const fires: Fire[][] = tiles.map(() => []);
    const craters: Crater[][] = tiles.map(() => []);
    zones.forEach((z) => {
      if (z.kind === 'burning') {
        // Smoke for days.
        const toDay = 1 + rng.int(8, 14);
        fires[crossesTile(z)]?.push({ id: `fi-${z.id}`, x: z.x, y: z.y, r: z.r, fromDay: 1, toDay });
      }
    });
    zones.forEach((z) => tiles[crossesTile(z)]?.strikeZones.push(z));

    // Craters: per tile a Poisson count, thinned by position against the storm density.
    for (const tile of tiles) {
      const x0 = tile.i * TILE_M;
      const y0 = tile.j * TILE_M;
      const nearX = Math.min(Math.max(centre.x, x0), x0 + TILE_M);
      const nearY = Math.min(Math.max(centre.y, y0), y0 + TILE_M);
      const fMax = densityAt(nearX, nearY);
      const cx = x0 + TILE_M / 2;
      const cy = y0 + TILE_M / 2;
      const n = poisson(rng, PEAK_CRATERS_PER_TILE * densityAt(cx, cy));
      const list = craters[tile.j * TILES_PER_SIDE + tile.i] as Crater[];
      const tileFires = fires[tile.j * TILES_PER_SIDE + tile.i] as Fire[];
      for (let placed = 0, tries = 0; placed < n && tries < n * 200; tries++) {
        const x = rng.float(x0, x0 + TILE_M);
        const y = rng.float(y0, y0 + TILE_M);
        if (rng.next() * fMax > densityAt(x, y)) continue;
        const D = craterDiameter(rng);
        const r = D / 2;
        const waterRoll = rng.next();
        const fireRoll = rng.next();
        const fireDays = rng.int(1, 4);
        if (lc(x, y) === LandCover.Water || isUnderWater(lakes, terrain, x, y, 0)) continue;
        if (Math.hypot(x - START.x, y - START.y) < START_CLEAR_M + r) continue;
        if (zones.some((z) => Math.hypot(x - z.x, y - z.y) < z.r + r)) continue;
        const id = `cr-${tile.id}-${placed}`;
        const water = D >= WATER_MIN_D && reliefAt(terrain, x, y) <= WATER_RELIEF_M && waterRoll < WATER_CHANCE;
        list.push({ id, x: r1(x), y: r1(y), r: r1(r), water });
        const onBuilding = inAny(buildings, x, y);
        if (fireRoll < (onBuilding ? BUILDING_FIRE_CHANCE : inAny(woods, x, y) ? WOOD_FIRE_CHANCE : 0)) {
          tileFires.push({ id: `fi-${id}`, x: r1(x), y: r1(y), r: r1(Math.max(15, r * 2)), fromDay: 1, toDay: 1 + fireDays });
        }
        placed++;
      }
    }

    // Gas hollows: valley-floor cells low against their 500 m neighbourhood, joined within each tile.
    const gas: GasHollow[][] = tiles.map(() => []);
    let gasCells = 0;
    for (const tile of tiles) {
      const low = new Map<number, number>();
      for (let dy = 0; dy < cellsPerTile; dy++) {
        for (let dx = 0; dx < cellsPerTile; dx++) {
          const cx = tile.i * cellsPerTile + dx;
          const cy = tile.j * cellsPerTile + dy;
          const x = (cx + 0.5) * cellM;
          const y = (cy + 0.5) * cellM;
          const cover = landcoverAt(terrain, x, y);
          if (cover === LandCover.Water) continue;
          const relief = reliefAt(terrain, x, y);
          if (relief <= (cover === LandCover.BuiltUp ? GAS_RELIEF_M / 2 : GAS_RELIEF_M)) low.set(dy * cellsPerTile + dx, relief);
        }
      }
      const seen = new Set<number>();
      let n = 0;
      for (const start of [...low.keys()].sort((a, b) => a - b)) {
        if (seen.has(start)) continue;
        const stack = [start];
        const members: number[] = [];
        seen.add(start);
        while (stack.length > 0) {
          const k = stack.pop() as number;
          members.push(k);
          const kx = k % cellsPerTile;
          const ky = Math.floor(k / cellsPerTile);
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = kx + ox;
            const ny = ky + oy;
            if (nx < 0 || ny < 0 || nx >= cellsPerTile || ny >= cellsPerTile) continue;
            const nk = ny * cellsPerTile + nx;
            if (low.has(nk) && !seen.has(nk)) {
              seen.add(nk);
              stack.push(nk);
            }
          }
        }
        if (members.length < GAS_MIN_CELLS) continue;
        members.sort((a, b) => a - b);
        const cells = members.map((k): [number, number] => [tile.i * cellsPerTile + (k % cellsPerTile), tile.j * cellsPerTile + Math.floor(k / cellsPerTile)]);
        const mx = cells.reduce((s, c) => s + (c[0] + 0.5) * cellM, 0) / cells.length;
        const my = cells.reduce((s, c) => s + (c[1] + 0.5) * cellM, 0) / cells.length;
        const rad = Math.max(...cells.map((c) => Math.hypot((c[0] + 0.5) * cellM - mx, (c[1] + 0.5) * cellM - my))) + cellM / 2;
        const depth = -members.reduce((s, k) => s + (low.get(k) as number), 0) / members.length;
        // Deeper hollows hold the gas longer: 3 days at the threshold, the full 5 from 16 m down.
        const toDay = Math.min(GAS_TO_DAY, 3 + Math.floor((depth + GAS_RELIEF_M) / 4));
        gas[tile.j * TILES_PER_SIDE + tile.i]?.push({
          id: `gh-${tile.id}-${n++}`,
          x: r1(mx),
          y: r1(my),
          r: r1(rad),
          fromDay: GAS_FROM_DAY,
          toDay: Math.max(3, toDay),
          cells,
        });
        gasCells += cells.length;
      }
    }

    // Animals per tile, counted from the cells. Ground animals are never in a mostly-scour tile.
    const animalTotals: Partial<Record<AnimalKind, number>> = {};
    for (const tile of tiles) {
      const c = { above: 0, strand: 0, scour: 0, moor: 0, moorAbove: 0, field: 0, wood: 0, valleyWood: 0, builtAbove: 0, grassAbove: 0 };
      for (let dy = 0; dy < cellsPerTile; dy++) {
        for (let dx = 0; dx < cellsPerTile; dx++) {
          const cx = tile.i * cellsPerTile + dx;
          const cy = tile.j * cellsPerTile + dy;
          const band = cellBand(cx, cy);
          const x = (cx + 0.5) * cellM;
          const y = (cy + 0.5) * cellM;
          const cover = landcoverAt(terrain, x, y);
          const isMoor = cover === LandCover.MoorGrass || cover === LandCover.Heather || cover === LandCover.Bog || cover === LandCover.Rock;
          if (isMoor) c.moor++;
          if (band === Band.Strandline) c.strand++;
          else if (band >= Band.Scour) c.scour++;
          else {
            c.above++;
            if (isMoor) c.moorAbove++;
            if (cover === LandCover.MoorGrass || cover === LandCover.Heather) c.grassAbove++;
            if (cover === LandCover.BuiltUp) c.builtAbove++;
          }
          // No woods or fields lie above the mark in this patch, so these count at any height; a mostly-scour tile loses them below.
          if (cover === LandCover.Field) c.field++;
          if (cover === LandCover.Wood) {
            c.wood++;
            if (reliefAt(terrain, x, y) <= -2) c.valleyWood++;
          }
        }
      }
      const cells = cellsPerTile * cellsPerTile;
      const rabbitRoll = rng.float(0.6, 1.4);
            const roeCount = rng.int(2, 4);
      const ponyRoll = rng.next();
      const ponyCount = rng.int(2, 5);
      const sheepRoll = rng.next();
      const sheepCount = rng.int(2, 6);
      const birdRoll = [rng.float(0.6, 1.4), rng.float(0.6, 1.4), rng.float(0.6, 1.4), rng.float(0.6, 1.4)] as const;
      const ground = c.scour * 2 <= cells;
      const counts: Partial<Record<AnimalKind, number>> = {
        // Rabbits on the moor above the mark.
        rabbit: ground ? Math.round(c.grassAbove * 0.03 * rabbitRoll) : 0,
        // Roe deer: valley woods in tiles that reach the moor edge and are not mostly scour. A few fixed spots only.
        roeDeer: ground && c.moor >= cells * 0.1 && c.valleyWood >= 3 ? roeCount : 0,
        // Ponies on big open moor, sheep on enclosed fields: very rare.
        pony: ground && c.moorAbove >= cells * 0.5 && ponyRoll < 0.15 ? ponyCount : 0,
        sheep: ground && c.field >= 40 && sheepRoll < 0.1 ? sheepCount : 0,
        // Birds: pheasants in the woods and pigeons above the mark, gulls and crows on the strandline.
        pheasant: ground ? Math.round((c.wood * 0.1 + c.field * 0.01) * birdRoll[0]) : 0,
        pigeon: Math.round((c.above * 0.004 + c.builtAbove * 0.08 + (ground ? c.field * 0.01 : 0)) * birdRoll[1]),
        gull: Math.round(c.strand * 0.03 * birdRoll[2]),
        crow: Math.round(c.strand * 0.025 * birdRoll[3]),
      };
      const k = tile.j * TILES_PER_SIDE + tile.i;
      for (const kind of Object.keys(counts) as AnimalKind[]) {
        const v = counts[kind] ?? 0;
        if (v > 0) {
          tile.animals[kind] = v;
          animalTotals[kind] = (animalTotals[kind] ?? 0) + v;
        }
      }
      tile.pocked = r2(densityAt(tile.i * TILE_M + TILE_M / 2, tile.j * TILE_M + TILE_M / 2));
      tile.craters = (craters[k] as Crater[]).sort((a, b) => (a.id < b.id ? -1 : 1));
      tile.fires = fires[k] as Fire[];
      tile.gasHollows = gas[k] as GasHollow[];
    }

    const marker = ' [craters] ';
    districts.method =
      districts.method.split(marker)[0] +
      marker +
      `Craters of ${CRATER_MIN_D} to ${CRATER_MAX_D} m across on N(>D) ~ D^-1.91 (a Poisson count per tile of ` +
      `${PEAK_CRATERS_PER_TILE} x density, density = 0.05 + 0.95 exp(-(d/3500 m)^2) from the storm centre, thinned by position; pocked = ` +
      `the same density at the tile centre). Water in craters of ${WATER_MIN_D} m and up on low ground (${-WATER_RELIEF_M} m below the 500 m ` +
      `neighbourhood mean). ${zones.length} strike zones of ${ZONE_MIN_D} to ${ZONE_MAX_D} m: burning on woods or moor, else glassy; the ` +
      `first is burning and seen from Yes Tor; ${ZONE_START_CLEAR_M} m clear of the start and ${ZONE_CAMP_CLEAR_M} m of the camp. Burning zones burn ` +
      `9 to 15 game days; craters in woods or on buildings start fires lasting 1 to 4 days. Gas hollows are 4-connected runs of 50 m cells ` +
      `${-GAS_RELIEF_M} m (${-GAS_RELIEF_M / 2} m in built-up cells) below the 500 m neighbourhood mean, ${GAS_FROM_DAY} to 3-${GAS_TO_DAY} game days. ` +
      'Animals counted from cell cover: rabbits on moor above the mark, roe deer in valley woods at the moor edge, ponies and sheep very rare, ' +
      'pheasants and pigeons above the mark, gulls and crows on the strandline; no ground animals in a mostly-scour tile.';

    const errs = validateDistricts(districts, features);
    if (errs.length > 0) throw new Error(`craters: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
    writeFileSync(dir + 'districts.json', serialise(districts));
    const nCraters = tiles.reduce((s, t) => s + t.craters.length, 0);
    const nFires = tiles.reduce((s, t) => s + t.fires.length, 0);
    const nGas = tiles.reduce((s, t) => s + t.gasHollows.length, 0);
    console.log(
      `[worldgen] craters: ${nCraters} craters, ${zones.length} strike zones (${zones.map((z) => z.kind).join(', ')}), ${nFires} fires, ` +
        `${nGas} gas hollows (${gasCells} cells), animals ${JSON.stringify(animalTotals)}`,
    );
  },
};
