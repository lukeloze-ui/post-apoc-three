import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAND_INFO, Band, bandFor, classifyCells, hwAt, hwBase, parseFlood, type FloodMeta } from './flood';
import { START, TILE_M, heightAt, parseTerrain, type Terrain, type TerrainMeta } from './terrain';
import { gridRefSX } from './geo';

const dir = 'public/world/';
const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
const terrain: Terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
const fmeta = JSON.parse(readFileSync(dir + 'flood.json', 'utf8')) as FloodMeta;
const flood = parseFlood(fmeta, readFileSync(dir + 'bands.bin'), terrain);

describe('bandFor', () => {
  it('classifies the boundaries', () => {
    expect(bandFor(425.01, 425)).toBe(Band.Above);
    expect(bandFor(425, 425)).toBe(Band.Strandline);
    expect(bandFor(405.01, 425)).toBe(Band.Strandline);
    expect(bandFor(405, 425)).toBe(Band.Scour);
    expect(bandFor(100, 425)).toBe(Band.Scour);
  });
  it('names every band', () => {
    expect(BAND_INFO.map((b) => b.code)).toEqual([0, 1, 2, 3]);
  });
});

describe('hwBase', () => {
  it('falls along the line and clamps', () => {
    expect(hwBase(258000, 89200)).toBeCloseTo(430, 6);
    expect(hwBase(352700, 150900)).toBeCloseTo(280, 6);
    expect(hwBase(0, 0)).toBe(430);
    expect(hwBase(999999, 999999)).toBe(280);
  });
});

describe('hwAt', () => {
  it('is continuous across a tile edge', () => {
    const y = 4200;
    const edge = 5 * TILE_M;
    const a = hwAt(flood.hw, edge - 1e-6, y);
    const b = hwAt(flood.hw, edge + 1e-6, y);
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
  });
  it('equals the tile value at a tile centre', () => {
    expect(hwAt(flood.hw, 3.5 * TILE_M, 6.5 * TILE_M)).toBeCloseTo(fmeta.tiles.find((t) => t.i === 3 && t.j === 6)!.hw, 9);
  });
  it('stays in the expected range over the patch', () => {
    for (const t of fmeta.tiles) {
      expect(t.hw).toBeGreaterThan(415);
      expect(t.hw).toBeLessThan(435);
    }
  });
});

describe('committed bands', () => {
  const bandAtXY = (x: number, y: number): number => flood.bands[Math.floor(y / 50) * 200 + Math.floor(x / 50)] as number;

  it('has the start above the mark', () => {
    expect(heightAt(terrain, START.x, START.y)).toBeGreaterThan(450);
    expect(bandAtXY(START.x, START.y)).toBe(Band.Above);
  });
  it('has Yes Tor above the mark', () => {
    const p = gridRefSX(580, 901);
    expect(bandAtXY(p.x, p.y)).toBe(Band.Above);
  });
  it('has Okehampton in the scour zone', () => {
    const p = gridRefSX(595, 949);
    expect(bandAtXY(p.x, p.y)).toBe(Band.Scour);
  });
  it('equals recomputation from terrain and flood.json', () => {
    expect(Buffer.from(classifyCells(terrain, flood.hw)).equals(readFileSync(dir + 'bands.bin'))).toBe(true);
  });
});
