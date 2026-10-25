import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LandCover,
  START,
  YES_TOR,
  heightAt,
  landcoverAt,
  parseTerrain,
  tileBounds,
  tileId,
  tileOf,
  type Terrain,
  type TerrainMeta,
} from './terrain';

const dir = 'public/world/';
const meta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
const t: Terrain = parseTerrain(meta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));

describe('terrain loader', () => {
  it('round trips the committed files', () => {
    expect(meta.crs).toBe('EPSG:27700');
    expect(meta.postsX).toBe(201);
    expect(t.heightsDm.length).toBe(201 * 201);
    expect(t.landcover.length).toBe(200 * 200);
    expect(t.sizeX).toBe(10000);
  });

  it('decodes little-endian int16 from an unaligned view', () => {
    const small: TerrainMeta = { ...meta, postsX: 2, postsY: 2 };
    const raw = new Uint8Array(9);
    raw.set([0x10, 0x27, 0xf6, 0xff, 0x00, 0x01, 0x34, 0x12], 1);
    const tt = parseTerrain(small, raw.subarray(1), new Uint8Array([3]));
    expect(Array.from(tt.heightsDm)).toEqual([10000, -10, 256, 0x1234]);
    expect(landcoverAt(tt, 10, 10)).toBe(3);
  });

  it('rejects wrong sizes', () => {
    expect(() => parseTerrain(meta, new Uint8Array(10), new Uint8Array(40000))).toThrow();
    expect(() => parseTerrain(meta, new Uint8Array(80802), new Uint8Array(5))).toThrow();
  });
});

describe('heightAt', () => {
  it('equals the post value at posts', () => {
    for (const [i, j] of [[0, 0], [10, 20], [100, 100], [200, 200], [37, 150]] as const) {
      expect(heightAt(t, i * 50, j * 50)).toBeCloseTo((t.heightsDm[j * 201 + i] as number) / 10, 6);
    }
  });

  it('is bilinear at midpoints', () => {
    const p = (i: number, j: number): number => (t.heightsDm[j * 201 + i] as number) / 10;
    expect(heightAt(t, 25 + 50 * 40, 50 * 60)).toBeCloseTo((p(40, 60) + p(41, 60)) / 2, 6);
    expect(heightAt(t, 50 * 40, 25 + 50 * 60)).toBeCloseTo((p(40, 60) + p(40, 61)) / 2, 6);
    expect(heightAt(t, 25 + 50 * 40, 25 + 50 * 60)).toBeCloseTo((p(40, 60) + p(41, 60) + p(40, 61) + p(41, 61)) / 4, 6);
  });

  it('clamps outside the patch', () => {
    expect(heightAt(t, -100, -100)).toBe(heightAt(t, 0, 0));
    expect(heightAt(t, 20000, 20000)).toBe(heightAt(t, 10000, 10000));
  });
});

describe('landcover and tiles', () => {
  it('reads cells and clamps', () => {
    expect(landcoverAt(t, 0, 0)).toBe(t.landcover[0]);
    expect(landcoverAt(t, 10000, 10000)).toBe(t.landcover[200 * 200 - 1]);
    expect(Object.values(LandCover)).toContain(landcoverAt(t, START.x, START.y));
  });

  it('names tiles by the OS reference of their SW corner', () => {
    expect(tileId(0, 0)).toBe('SX5288');
    expect(tileId(9, 9)).toBe('SX6197');
    expect(tileOf(0, 0)).toEqual({ i: 0, j: 0 });
    expect(tileOf(9999.9, 5500)).toEqual({ i: 9, j: 5 });
    expect(tileOf(10000, 10000)).toEqual({ i: 9, j: 9 });
    expect(tileBounds(3, 4)).toEqual({ x0: 3000, y0: 4000, x1: 4000, y1: 5000 });
    expect(() => tileId(10, 0)).toThrow();
  });
});

describe('start and landmarks', () => {
  it('starts comfortably inside the patch, on the plateau, facing south-west', () => {
    for (const v of [START.x, START.y]) {
      expect(v).toBeGreaterThan(2000);
      expect(v).toBeLessThan(8000);
    }
    expect(heightAt(t, START.x, START.y)).toBeGreaterThan(430);
    expect(heightAt(t, START.x, START.y)).toBeLessThan(520);
    expect(START.yaw).toBeGreaterThan(180);
    expect(START.yaw).toBeLessThan(270);
  });

  it('has the Yes Tor / High Willhays ridge at about 620 m and the town low', () => {
    expect(heightAt(t, YES_TOR.x, YES_TOR.y)).toBeCloseTo(619, 0);
    expect(heightAt(t, 6000, 1200)).toBeCloseTo(621, 0);
    expect(Math.max(...t.heightsDm) / 10).toBeLessThan(625);
    expect(heightAt(t, 6700, 7100)).toBeLessThan(180);
    expect(heightAt(t, 6700, 7100)).toBeGreaterThan(100);
  });
});
