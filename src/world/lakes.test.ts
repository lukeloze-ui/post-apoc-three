import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { labelLakes, priorityFlood } from './fill';
import { Band } from './flood';
import {
  DRAIN_END_DAY,
  FALL_RATE_M_PER_DAY,
  bandWithLakes,
  isUnderWater,
  lakeLevelAt,
  parseLakes,
  type Lake,
  type LakesMeta,
} from './lakes';
import { parseTerrain, type Terrain, type TerrainMeta } from './terrain';

const salt: Lake = { id: 1, spill: 20, area: 900, volume: 5000, maxDepth: 16, floor: 19.9, x: 0, y: 0, salt: true };

describe('lakeLevelAt', () => {
  it('holds the spill level through day 5', () => {
    expect(lakeLevelAt(salt, 0)).toBe(20);
    expect(lakeLevelAt(salt, DRAIN_END_DAY)).toBe(20);
  });
  it('falls 0.03 m a day afterwards', () => {
    const deep = { ...salt, floor: 10 };
    expect(FALL_RATE_M_PER_DAY).toBe(0.03);
    expect(lakeLevelAt(deep, DRAIN_END_DAY + 1)).toBeCloseTo(19.97, 9);
    expect(lakeLevelAt(deep, DRAIN_END_DAY + 10)).toBeCloseTo(19.7, 9);
  });
  it('stops at the floor', () => {
    expect(lakeLevelAt(salt, DRAIN_END_DAY + 3)).toBeCloseTo(19.91, 9);
    expect(lakeLevelAt(salt, DRAIN_END_DAY + 4)).toBe(19.9);
    expect(lakeLevelAt(salt, DRAIN_END_DAY + 400)).toBe(19.9);
  });
  it('keeps a fresh lake level', () => {
    expect(lakeLevelAt({ ...salt, salt: false }, DRAIN_END_DAY + 400)).toBe(20);
  });
});

// A 5 x 5 bowl, 10 m cells: rim 20, ring 10, floor 4.
const heights = [
  20, 20, 20, 20, 20, //
  20, 10, 10, 10, 20,
  20, 10, 4, 10, 20,
  20, 10, 10, 10, 20,
  20, 20, 20, 20, 20,
];
const toyTerrain: Terrain = {
  meta: { version: 1, source: 'test', crs: 'EPSG:27700', originE: 0, originN: 0, cellM: 10, postsX: 5, postsY: 5, heightUnit: 'dm' },
  sizeX: 40,
  sizeY: 40,
  heightsDm: Int16Array.from(heights, (m) => m * 10),
  landcover: new Uint8Array(16),
};

function toyLakes(isSalt: boolean) {
  const { lakes, ids } = labelLakes(heights, priorityFlood(heights, 5, 5), 5, 5, {
    cellM: 10,
    markAt: () => (isSalt ? 100 : 0),
  });
  const meta: LakesMeta = { version: 1, method: 'test', cellM: 10, postsX: 5, postsY: 5, lakes };
  const bytes = Buffer.alloc(50);
  ids.forEach((id, k) => bytes.writeUInt16LE(id, k * 2));
  return parseLakes(meta, bytes, toyTerrain);
}

describe('isUnderWater', () => {
  it('is under water in the bowl and dry on the rim', () => {
    const lakes = toyLakes(true);
    expect(isUnderWater(lakes, toyTerrain, 20, 20, 1)).toBe(true);
    expect(isUnderWater(lakes, toyTerrain, 0, 0, 1)).toBe(false);
    expect(bandWithLakes(lakes, toyTerrain, Band.Scour, 20, 20, 1)).toBe(Band.UnderWater);
    expect(bandWithLakes(lakes, toyTerrain, Band.Scour, 0, 0, 1)).toBe(Band.Scour);
  });
  it('dries out as a salt lake falls to its floor but not a fresh one', () => {
    const salty = toyLakes(true);
    const fresh = toyLakes(false);
    // Floor 4, spill 20: 16 m at 0.03 m/day = 534 days after day 5.
    expect(isUnderWater(salty, toyTerrain, 20, 20, 5 + 500)).toBe(true);
    expect(isUnderWater(salty, toyTerrain, 20, 20, 5 + 600)).toBe(false);
    expect(isUnderWater(fresh, toyTerrain, 20, 20, 5 + 600)).toBe(true);
  });
  it('shrinks to the deepest ground as the level falls', () => {
    const lakes = toyLakes(true);
    // At day 5 + 400 the level is 8 m: the ring (10 m) is dry, the floor (4 m) is wet.
    expect(isUnderWater(lakes, toyTerrain, 10, 10, 405)).toBe(false);
    expect(isUnderWater(lakes, toyTerrain, 20, 20, 405)).toBe(true);
  });
});

describe('committed lakes', () => {
  const dir = 'public/world/';
  const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
  const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
  const meta = JSON.parse(readFileSync(dir + 'lakes.json', 'utf8')) as LakesMeta;
  const lakes = parseLakes(meta, readFileSync(dir + 'lakeid.bin'), terrain);

  it('matches a recomputation from the committed terrain', () => {
    const h = Float64Array.from(terrain.heightsDm, (dm) => dm / 10);
    const { lakes: again, ids } = labelLakes(h, priorityFlood(h, tmeta.postsX, tmeta.postsY), tmeta.postsX, tmeta.postsY, {
      cellM: tmeta.cellM,
    });
    expect(again.map((l) => l.id)).toEqual(meta.lakes.map((l) => l.id));
    expect(Array.from(ids)).toEqual(Array.from(lakes.ids));
  });
  it('never lets a fresh lake fall and every lake have positive depth', () => {
    for (const l of meta.lakes) {
      expect(l.maxDepth).toBeGreaterThan(0.5);
      if (!l.salt) expect(lakeLevelAt(l, 1000)).toBe(l.spill);
    }
  });
});
