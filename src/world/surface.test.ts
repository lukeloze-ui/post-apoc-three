import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LandCover, heightAt, parseTerrain, type Terrain, type TerrainMeta } from './terrain';
import {
  MAX_ROUGHNESS_M,
  ROUGHNESS_M,
  baseHeight,
  createSurface,
  roughnessAt,
  smoothSurfaceHeight,
  surfaceHeight,
} from './surface';

const dir = 'public/world/';
const meta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
const t: Terrain = parseTerrain(meta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
const s = createSurface(t);

/** Fixed spread of sample points over the patch (no RNG needed). */
const points: Array<[number, number]> = [];
for (let k = 0; k < 400; k++) points.push([((k * 7919.37) % 10000 + 10000) % 10000, ((k * 3571.91) % 10000 + 10000) % 10000]);

describe('surface', () => {
  it('is deterministic across calls and separately built surfaces', () => {
    const s2 = createSurface(parseTerrain(meta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin')));
    for (const [x, y] of points) {
      const h = surfaceHeight(s, x, y);
      expect(surfaceHeight(s, x, y)).toBe(h);
      expect(surfaceHeight(s2, x, y)).toBe(h);
    }
  });

  it('passes through the posts, within the roughness amplitude', () => {
    for (let j = 0; j < meta.postsY; j += 7) {
      for (let i = 0; i < meta.postsX; i += 7) {
        const x = i * meta.cellM;
        const y = j * meta.cellM;
        const post = heightAt(t, x, y);
        expect(baseHeight(t, x, y)).toBeCloseTo(post, 9);
        expect(Math.abs(surfaceHeight(s, x, y) - post)).toBeLessThanOrEqual(MAX_ROUGHNESS_M + 1e-9);
      }
    }
  });

  it('stays near bilinear between posts', () => {
    for (const [x, y] of points) {
      expect(Math.abs(baseHeight(t, x, y) - heightAt(t, x, y))).toBeLessThan(8);
    }
  });

  it('is continuous across post cells, noise lattice lines and the edge fallback', () => {
    const eps = 1e-6;
    const lines = [0.5, 50, 100, 2500, 9950, 9999.5, 8 * 311, 2.5 * 1001];
    for (const line of lines) {
      for (let k = 0; k < 40; k++) {
        const other = 37 + k * 247.3;
        expect(Math.abs(surfaceHeight(s, line - eps, other) - surfaceHeight(s, line + eps, other))).toBeLessThan(1e-3);
        expect(Math.abs(surfaceHeight(s, other, line - eps) - surfaceHeight(s, other, line + eps))).toBeLessThan(1e-3);
      }
    }
  });

  it('keeps roughness within the landcover amplitude, rock rougher than fields', () => {
    const sumSq: Record<number, { s: number; n: number }> = {};
    const cells = meta.postsX - 1;
    for (let cy = 1; cy < cells - 1; cy += 3) {
      for (let cx = 1; cx < cells - 1; cx += 3) {
        const code = t.landcover[cy * cells + cx] as number;
        for (let k = 0; k < 6; k++) {
          const x = (cx + 0.5) * meta.cellM + (k - 2.5) * 1.3;
          const y = (cy + 0.5) * meta.cellM + (k - 2.5) * 0.9;
          const r = roughnessAt(s, x, y);
          expect(Math.abs(r)).toBeLessThanOrEqual(MAX_ROUGHNESS_M + 1e-9);
          expect(surfaceHeight(s, x, y) - smoothSurfaceHeight(s, x, y)).toBeCloseTo(r, 9);
          const e = (sumSq[code] ??= { s: 0, n: 0 });
          e.s += r * r;
          e.n++;
        }
      }
    }
    const rms = (c: number): number => Math.sqrt((sumSq[c]?.s ?? 0) / (sumSq[c]?.n || 1));
    if (sumSq[LandCover.Rock] && sumSq[LandCover.Field]) expect(rms(LandCover.Rock)).toBeGreaterThan(rms(LandCover.Field));
    expect(ROUGHNESS_M[LandCover.Rock]).toBeGreaterThan(ROUGHNESS_M[LandCover.Field] as number);
  });

  it('applies height modifiers in order, only inside their bounds', () => {
    const crater = createSurface(t, [
      { bounds: { x0: 4000, y0: 4000, x1: 4100, y1: 4100 }, apply: (_x, _y, h) => h - 5 },
      { apply: (_x, _y, h) => h * 2 },
    ]);
    const inside = surfaceHeight(s, 4050, 4050);
    const outside = surfaceHeight(s, 6000, 6000);
    expect(surfaceHeight(crater, 4050, 4050)).toBeCloseTo((inside - 5) * 2, 9);
    expect(surfaceHeight(crater, 6000, 6000)).toBeCloseTo(outside * 2, 9);
  });

  it('is finite outside the patch', () => {
    for (const [x, y] of [[-500, 300], [10600, -20], [5000, 12000]] as const) {
      expect(Number.isFinite(surfaceHeight(s, x, y))).toBe(true);
    }
  });
});
