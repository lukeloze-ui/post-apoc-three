import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitRoad } from '../../Tools/worldgen/steps/districts';
import { MAX_SEGMENT_M, validateDistricts, type Districts } from './districts';
import type { Features, Pt } from './features';
import { TILE_M, tileBounds } from './terrain';

const districts = JSON.parse(readFileSync('public/world/districts.json', 'utf8')) as Districts;
const features = JSON.parse(readFileSync('public/world/features.json', 'utf8')) as Features;

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

describe('validateDistricts', () => {
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
