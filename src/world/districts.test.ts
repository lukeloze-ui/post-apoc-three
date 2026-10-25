import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { slopeDegAt } from '../../Tools/worldgen/steps/blockers';
import { splitRoad } from '../../Tools/worldgen/steps/districts';
import { LANDSLIP_MIN_SLOPE_DEG, MAX_SEGMENT_M, ringContains, validateDistricts, type Districts } from './districts';
import type { Features, Pt } from './features';
import { hwAt, parseFlood, type FloodMeta } from './flood';
import { TILE_M, heightAt, parseTerrain, tileBounds, type TerrainMeta } from './terrain';

const districts = JSON.parse(readFileSync('public/world/districts.json', 'utf8')) as Districts;
const features = JSON.parse(readFileSync('public/world/features.json', 'utf8')) as Features;
const tmeta = JSON.parse(readFileSync('public/world/terrain.json', 'utf8')) as TerrainMeta;
const terrain = parseTerrain(tmeta, readFileSync('public/world/terrain.bin'), readFileSync('public/world/landcover.bin'));
const fmeta = JSON.parse(readFileSync('public/world/flood.json', 'utf8')) as FloodMeta;
const flood = parseFlood(fmeta, readFileSync('public/world/bands.bin'), terrain);

describe('districts.json', () => {
  it('validates against features.json', () => {
    expect(validateDistricts(districts, features)).toEqual([]);
  });

  it('covers all 100 tiles in order', () => {
    expect(districts.tiles).toHaveLength(100);
    expect(new Set(districts.tiles.map((t) => t.id)).size).toBe(100);
  });

  it('has every features.json bridge, and the survivors stand', () => {
    const ids = new Set(districts.bridges.map((b) => b.id));
    for (const b of features.bridges) expect(ids.has(b.id), b.id).toBe(true);
    expect(districts.survivors.length).toBeGreaterThanOrEqual(2);
    for (const s of districts.survivors) {
      for (const id of s.bridgeIds) {
        const b = districts.bridges.find((x) => x.id === id);
        expect(b?.standing, id).toBe(true);
        expect(b?.reason, id).toBe('survivor');
      }
    }
    const meldon = districts.bridges.find((b) => b.id === 'br-w1119234348');
    expect(meldon?.depthBelowMark).toBeGreaterThan(100);
  });

  it('keeps each segment inside its tile and every road covered', () => {
    for (const s of districts.roadSegments) {
      const i = Number(s.tile.slice(2, 4)) - 52;
      const j = Number(s.tile.slice(4, 6)) - 88;
      const b = tileBounds(i, j);
      for (const [x, y] of s.pts) {
        expect(x >= b.x0 - 0.06 && x <= b.x1 + 0.06 && y >= b.y0 - 0.06 && y <= b.y1 + 0.06, s.id).toBe(true);
      }
    }
    const roads = new Set(districts.roadSegments.map((s) => s.roadId));
    for (const r of features.roads) expect(roads.has(r.id), r.id).toBe(true);
  });
});

describe('terrain blockers', () => {
  const tiles = districts.tiles;
  type Tile = Districts['tiles'][number];
  const all = <K extends 'wrackDams' | 'landslips' | 'siltFlats' | 'fallenWood'>(k: K): Tile[K] =>
    tiles.flatMap((t) => t[k] as unknown[]) as Tile[K];

  it('has some of each', () => {
    expect(all('wrackDams').some((w) => w.kind === 'bridge')).toBe(true);
    expect(all('wrackDams').some((w) => w.kind === 'narrows')).toBe(true);
    expect(all('landslips').length).toBeGreaterThan(0);
    expect(all('siltFlats').length).toBeGreaterThan(0);
    expect(all('siltFlats').some((f) => f.softPatches.length > 0)).toBe(true);
    expect(all('fallenWood').length).toBeGreaterThan(0);
  });

  it('puts wrack dams only below the mark', () => {
    for (const w of all('wrackDams')) {
      expect(heightAt(terrain, w.x, w.y), w.id).toBeLessThan(hwAt(flood.hw, w.x, w.y));
    }
  });

  it('puts landslips only on slopes over 25 degrees', () => {
    const cellM = tmeta.cellM;
    for (const l of all('landslips')) {
      let n = 0;
      for (let cy = Math.floor(l.y / cellM) - 25; cy <= Math.floor(l.y / cellM) + 25; cy++) {
        for (let cx = Math.floor(l.x / cellM) - 25; cx <= Math.floor(l.x / cellM) + 25; cx++) {
          const x = (cx + 0.5) * cellM;
          const y = (cy + 0.5) * cellM;
          if (!ringContains(l.ring, x, y)) continue;
          n++;
          expect(slopeDegAt(terrain, x, y), l.id).toBeGreaterThan(LANDSLIP_MIN_SLOPE_DEG);
        }
      }
      expect(n, l.id).toBeGreaterThan(0);
    }
  });

  it('keeps soft patches, circle and all, inside their silt flat', () => {
    for (const f of all('siltFlats')) {
      for (const p of f.softPatches) {
        for (let a = 0; a < 8; a++) {
          const x = p.x + p.r * Math.cos((a * Math.PI) / 4);
          const y = p.y + p.r * Math.sin((a * Math.PI) / 4);
          expect(ringContains(f.ring, x, y), p.id).toBe(true);
        }
      }
    }
  });

  it('refers to real woods', () => {
    const woods = new Map(features.woods.map((w) => [w.id, w]));
    for (const f of all('fallenWood')) expect(woods.has(f.woodId), f.id).toBe(true);
  });
});

describe('validateDistricts', () => {
  it('rejects a soft patch outside its silt flat and a gentle landslip', () => {
    const broken = structuredClone(districts);
    const flatTile = broken.tiles.find((t) => t.siltFlats.length > 0);
    const slipTile = broken.tiles.find((t) => t.landslips.length > 0);
    const flat = flatTile?.siltFlats[0];
    const slip = slipTile?.landslips[0];
    if (!flat || !slip) throw new Error('no silt flat or landslip to break');
    flat.softPatches.push({ id: 'bad', x: flat.x + 1e5, y: flat.y, r: 5 });
    slip.slopeDeg = 20;
    const errs = validateDistricts(broken, features);
    expect(errs.some((e) => e.includes('outside the silt flat'))).toBe(true);
    expect(errs.some((e) => e.includes('slopeDeg'))).toBe(true);
  });

  it('reports a bad reference and a missing tile', () => {
    const broken = structuredClone(districts);
    (broken.bridges[0] as { refId: string }).refId = 'nope';
    broken.tiles.pop();
    const errs = validateDistricts(broken, features);
    expect(errs.some((e) => e.includes('refId'))).toBe(true);
    expect(errs.some((e) => e.includes('tiles: expected 100'))).toBe(true);
  });
});

describe('splitRoad', () => {
  const never = (): boolean => false;
  it('cuts at tile edges', () => {
    const pts: Pt[] = [
      [TILE_M - 100, 50],
      [TILE_M + 100, 50],
    ];
    const pieces = splitRoad(pts, never);
    expect(pieces).toEqual([
      [
        [TILE_M - 100, 50],
        [TILE_M, 50],
      ],
      [
        [TILE_M, 50],
        [TILE_M + 100, 50],
      ],
    ]);
  });
  it('cuts at junctions and into equal pieces of at most 250 m', () => {
    const pts: Pt[] = [
      [10, 10],
      [110, 10],
      [710, 10],
    ];
    const pieces = splitRoad(pts, (p) => p[0] === 110);
    expect(pieces[0]).toEqual([
      [10, 10],
      [110, 10],
    ]);
    // 600 m after the junction: three pieces of 200 m.
    expect(pieces.slice(1).map((p) => p.map((q) => q[0]))).toEqual([
      [110, 310],
      [310, 510],
      [510, 710],
    ]);
    for (const p of pieces) expect(Math.abs((p.at(-1) as Pt)[0] - (p[0] as Pt)[0])).toBeLessThanOrEqual(MAX_SEGMENT_M);
  });
});
