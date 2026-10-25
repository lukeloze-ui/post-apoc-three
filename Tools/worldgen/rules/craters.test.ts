import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BIRD_KINDS, GAS_FROM_DAY, GAS_TO_DAY, type AnimalKind, type Districts } from '../../../src/world/districts';
import type { Features } from '../../../src/world/features';
import { Band, bandAt, parseFlood, type FloodMeta } from '../../../src/world/flood';
import { START, TILE_M, YES_TOR, parseTerrain, type TerrainMeta } from '../../../src/world/terrain';
import { mulberry32 } from '../rng';
import { CRATER_MAX_D, CRATER_MIN_D, canSee, craterCumulative, craterDiameter, strikeDensity } from './craters';

const dir = 'public/world/';
const districts = JSON.parse(readFileSync(dir + 'districts.json', 'utf8')) as Districts;
const features = JSON.parse(readFileSync(dir + 'features.json', 'utf8')) as Features;
const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
const flood = parseFlood(JSON.parse(readFileSync(dir + 'flood.json', 'utf8')) as FloodMeta, readFileSync(dir + 'bands.bin'), terrain);

const withinFactor2 = (observed: number, expected: number): boolean => observed >= expected / 2 && observed <= expected * 2;

describe('crater size curve', () => {
  it('draws diameters inside the range', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 2000; i++) {
      const d = craterDiameter(rng);
      expect(d).toBeGreaterThanOrEqual(CRATER_MIN_D);
      expect(d).toBeLessThan(CRATER_MAX_D);
    }
  });

  it('gives about 10 of 15 m and about 100 of 5 m for each 50 m', () => {
    const rng = mulberry32(2);
    const sizes = Array.from({ length: 100_000 }, () => craterDiameter(rng, 5, 500));
    const n = (d: number): number => sizes.filter((s) => s >= d).length;
    expect(withinFactor2(n(5) / n(50), 100)).toBe(true);
    expect(withinFactor2(n(15) / n(50), 10)).toBe(true);
  });

  it('craterCumulative is 1 at the smallest size and 0 at the largest', () => {
    expect(craterCumulative(CRATER_MIN_D)).toBeCloseTo(1, 10);
    expect(craterCumulative(CRATER_MAX_D)).toBeCloseTo(0, 10);
  });

  it('thins with distance', () => {
    expect(strikeDensity(0)).toBeCloseTo(1, 10);
    expect(strikeDensity(2000)).toBeGreaterThan(strikeDensity(5000));
    expect(strikeDensity(20_000)).toBeGreaterThan(0);
  });
});

describe('districts.json strikes', () => {
  const craters = districts.tiles.flatMap((t) => t.craters);
  const zones = districts.tiles.flatMap((t) => t.strikeZones);

  it('has craters of 15 to 50 m on the size curve', () => {
    expect(craters.length).toBeGreaterThan(500);
    for (const c of craters) {
      expect(c.r * 2).toBeGreaterThanOrEqual(CRATER_MIN_D - 0.2);
      expect(c.r * 2).toBeLessThanOrEqual(CRATER_MAX_D + 0.2);
    }
    for (const d of [20, 25, 30, 40]) {
      const observed = craters.filter((c) => c.r * 2 >= d).length / craters.length;
      expect(withinFactor2(observed, craterCumulative(d)), `N(>=${d})`).toBe(true);
    }
  });

  it('puts standing water only in large craters', () => {
    const wet = craters.filter((c) => c.water);
    expect(wet.length).toBeGreaterThan(0);
    for (const c of wet) expect(c.r * 2).toBeGreaterThanOrEqual(25 - 0.2);
  });

  it('is denser near the storm centre', () => {
    const mean = (pick: (pocked: number) => boolean): number => {
      const tiles = districts.tiles.filter((t) => pick(t.pocked));
      return tiles.reduce((s, t) => s + t.craters.length, 0) / tiles.length;
    };
    expect(mean((p) => p > 0.6)).toBeGreaterThan(5 * mean((p) => p < 0.15));
    const centre = districts.storm.centre;
    const dist = (t: { i: number; j: number }): number => Math.hypot((t.i + 0.5) * TILE_M - centre.x, (t.j + 0.5) * TILE_M - centre.y);
    const sorted = [...districts.tiles].sort((a, b) => dist(a) - dist(b));
    expect(sorted[0]?.pocked).toBeGreaterThan(sorted[sorted.length - 1]?.pocked ?? 1);
  });

  it('has 2 to 5 strike zones, 100 m and up, burning or glassy', () => {
    expect(zones.length).toBeGreaterThanOrEqual(2);
    expect(zones.length).toBeLessThanOrEqual(5);
    for (const z of zones) expect(z.r * 2).toBeGreaterThanOrEqual(100);
    expect(zones.some((z) => z.kind === 'burning')).toBe(true);
  });

  it('keeps the start and the camp clear of strike zones', () => {
    const camp = features.settlements?.find((s) => s.kind === 'camp');
    expect(camp).toBeDefined();
    const military = features.buildings.filter((b) => b.type === 'military').flatMap((b) => b.ring);
    const sites: [number, number][] = [[camp?.x ?? 0, camp?.y ?? 0], ...military.map((p): [number, number] => [p[0], p[1]])];
    for (const z of zones) {
      expect(Math.hypot(z.x - START.x, z.y - START.y) - z.r).toBeGreaterThan(500);
      for (const [x, y] of sites) expect(Math.hypot(z.x - x, z.y - y) - z.r).toBeGreaterThan(400);
    }
    for (const c of craters) expect(Math.hypot(c.x - START.x, c.y - START.y)).toBeGreaterThan(c.r + 50);
  });

  it('shows smoke from Yes Tor, burning for days', () => {
    const burning = zones.filter((z) => z.kind === 'burning');
    expect(burning.some((z) => canSee(terrain, YES_TOR.x, YES_TOR.y, 1.7, z.x, z.y, 60))).toBe(true);
    const fires = districts.tiles.flatMap((t) => t.fires);
    for (const z of burning) {
      const fire = fires.find((f) => f.id === `fi-${z.id}`);
      expect(fire, z.id).toBeDefined();
      expect((fire?.toDay ?? 0) - (fire?.fromDay ?? 0)).toBeGreaterThanOrEqual(5);
    }
  });

  it('has fires from strikes into woods and buildings, each with a start and an end day', () => {
    const fires = districts.tiles.flatMap((t) => t.fires);
    expect(fires.length).toBeGreaterThan(zones.filter((z) => z.kind === 'burning').length);
    for (const f of fires) expect(f.toDay).toBeGreaterThan(f.fromDay);
  });

  it('has gas only on days 1 to 5, on cells inside the tile', () => {
    expect(districts.tiles.some((t) => t.gasHollows.length > 0)).toBe(true);
    const cellsPerTile = TILE_M / tmeta.cellM;
    for (const t of districts.tiles) {
      for (const g of t.gasHollows) {
        expect(g.fromDay).toBeGreaterThanOrEqual(GAS_FROM_DAY);
        expect(g.toDay).toBeLessThanOrEqual(GAS_TO_DAY);
        for (const [cx, cy] of g.cells) {
          expect(Math.floor(cx / cellsPerTile)).toBe(t.i);
          expect(Math.floor(cy / cellsPerTile)).toBe(t.j);
        }
      }
    }
  });

  it('has no ground animals in tiles that are mostly scour', () => {
    const cellsPerSide = tmeta.postsX - 1;
    const cellsPerTile = TILE_M / tmeta.cellM;
    let scourTiles = 0;
    for (const t of districts.tiles) {
      let scour = 0;
      for (let dy = 0; dy < cellsPerTile; dy++) {
        for (let dx = 0; dx < cellsPerTile; dx++) {
          const x = (t.i * cellsPerTile + dx + 0.5) * tmeta.cellM;
          const y = (t.j * cellsPerTile + dy + 0.5) * tmeta.cellM;
          if (bandAt(flood, tmeta.cellM, cellsPerSide, x, y) >= Band.Scour) scour++;
        }
      }
      if (scour * 2 <= cellsPerTile * cellsPerTile) continue;
      scourTiles++;
      for (const kind of Object.keys(t.animals) as AnimalKind[]) {
        if (!BIRD_KINDS.includes(kind)) expect.fail(`${t.id} (mostly scour) has ${kind}`);
      }
    }
    expect(scourTiles).toBeGreaterThan(20);
  });

  it('keeps the animals where the spec puts them', () => {
    const total = (kind: AnimalKind): number => districts.tiles.reduce((s, t) => s + (t.animals[kind] ?? 0), 0);
    expect(total('rabbit')).toBeGreaterThan(50);
    expect(total('roeDeer')).toBeGreaterThan(0);
    expect(total('pony')).toBeGreaterThan(0);
    expect(total('pony')).toBeLessThan(total('rabbit') / 4);
    expect(total('sheep')).toBeLessThan(total('rabbit') / 4);
    expect(total('gull')).toBeGreaterThan(0);
    expect(total('crow')).toBeGreaterThan(0);
    expect(total('redDeer')).toBe(0);
  });
});
