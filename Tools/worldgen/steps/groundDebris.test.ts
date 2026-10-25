// Committed-data checks on the ground debris (spec SX 02, debris near towns and roads; SX 03 bands).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Features, Pt } from '../../../src/world/features';
import { Band, bandFor, hwAt } from '../../../src/world/flood';
import { BARRIER_BROKEN, parseGround, serialiseGround, type GroundFile, type GroundTile } from '../../../src/world/ground';
import { heightAt, TILES_PER_SIDE, tileId, tileOf } from '../../../src/world/terrain';
import { BARRIER_STAND_P, loadGroundWorld, MAX_OBJECTS_PER_TILE, TILE_WARN_BYTES, TOTAL_MAX_BYTES } from './ground';

const world = loadGroundWorld();
const { terrain, flood } = world;
const features = world.features as Features & { barriers: { kind: string; pts: Pt[] }[] };
const raw = new Map<string, string>();
const tiles: GroundTile[] = [];
for (let j = 0; j < TILES_PER_SIDE; j++) {
  for (let i = 0; i < TILES_PER_SIDE; i++) {
    const id = tileId(i, j);
    const text = readFileSync(`public/world/ground/${id}.json`, 'utf8');
    raw.set(id, text);
    tiles.push(parseGround(JSON.parse(text), id));
  }
}
const objects = tiles.flatMap((t) => t.objects);
const DEBRIS = new Set(['rubble', 'car', 'trunk', 'wrack']);
const tileIdx = (x: number, y: number): number => {
  const t = tileOf(x, y);
  return t.j * TILES_PER_SIDE + t.i;
};

/** Share of each tile's 50 m cells in each band (bands.bin, lakes not counted). */
const cellsPerSide = terrain.meta.postsX - 1;
const perTile = (cellsPerSide / TILES_PER_SIDE) ** 2;
const bandShare = tiles.map(() => [0, 0, 0, 0]);
for (let cy = 0; cy < cellsPerSide; cy++) {
  for (let cx = 0; cx < cellsPerSide; cx++) {
    const k = tileIdx((cx + 0.5) * terrain.meta.cellM, (cy + 0.5) * terrain.meta.cellM);
    (bandShare[k] as number[])[flood.bands[cy * cellsPerSide + cx] as number]! += 1 / perTile;
  }
}

describe('ground debris', () => {
  it('scour tiles with many buildings carry more debris than open-field ones', () => {
    const buildings = tiles.map(() => 0);
    for (const b of features.buildings) {
      const [x, y] = b.ring[0] as Pt;
      buildings[tileIdx(x, y)]!++;
    }
    const debris = tiles.map((t) => t.objects.filter((o) => DEBRIS.has(o.kind)).length);
    const scour = tiles.map((_, k) => k).filter((k) => (bandShare[k] as number[])[Band.Scour]! >= 0.6);
    const dense = scour.filter((k) => buildings[k]! >= 100);
    const open = scour.filter((k) => buildings[k]! <= 5);
    expect(dense.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    const mean = (ks: number[]): number => ks.reduce((s, k) => s + debris[k]!, 0) / ks.length;
    expect(mean(dense)).toBeGreaterThan(3 * mean(open));
  });

  it('valley bottoms carry more wrack than slopes, below the mark', () => {
    // Valley bottom: within 25 m of a river or stream. Slope: steeper than 1 in 8 and 200 m or more from one.
    const G = 25;
    const n = Math.round(terrain.sizeX / G);
    const riverNear = new Float32Array(n * n).fill(Infinity);
    for (const r of features.rivers) {
      for (let k = 1; k < r.pts.length; k++) {
        const [ax, ay] = r.pts[k - 1] as Pt;
        const [bx, by] = r.pts[k] as Pt;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 5));
        for (let s = 0; s <= steps; s++) {
          const x = ax + ((bx - ax) * s) / steps;
          const y = ay + ((by - ay) * s) / steps;
          for (let dy = -9; dy <= 9; dy++) {
            for (let dx = -9; dx <= 9; dx++) {
              const cx = Math.floor(x / G) + dx;
              const cy = Math.floor(y / G) + dy;
              if (cx < 0 || cy < 0 || cx >= n || cy >= n) continue;
              const d = Math.hypot((cx + 0.5) * G - x, (cy + 0.5) * G - y);
              if (d < (riverNear[cy * n + cx] as number)) riverNear[cy * n + cx] = d;
            }
          }
        }
      }
    }
    const wrack = new Uint16Array(n * n);
    for (const o of objects) {
      if (o.kind !== 'wrack') continue;
      const cx = Math.min(n - 1, Math.floor(o.x / G));
      const cy = Math.min(n - 1, Math.floor(o.y / G));
      wrack[cy * n + cx]!++;
    }
    let vSum = 0;
    let vN = 0;
    let sSum = 0;
    let sN = 0;
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const x = (cx + 0.5) * G;
        const y = (cy + 0.5) * G;
        const h = heightAt(terrain, x, y);
        if (bandFor(h, hwAt(flood.hw, x, y)) === Band.Above) continue;
        const slope = Math.hypot(heightAt(terrain, x + 25, y) - heightAt(terrain, x - 25, y), heightAt(terrain, x, y + 25) - heightAt(terrain, x, y - 25)) / 50;
        const d = riverNear[cy * n + cx] as number;
        const w = wrack[cy * n + cx] as number;
        if (d <= 25) {
          vSum += w;
          vN++;
        } else if (d >= 200 && slope > 1 / 8) {
          sSum += w;
          sN++;
        }
      }
    }
    expect(vN).toBeGreaterThan(100);
    expect(sN).toBeGreaterThan(100);
    expect(vSum / vN).toBeGreaterThan(2 * (sSum / sN));
  });

  it('tiles above the mark carry almost no wrack', () => {
    const above = tiles.map((_, k) => k).filter((k) => (bandShare[k] as number[])[Band.Above]! >= 0.98);
    expect(above.length).toBeGreaterThan(0);
    for (const k of above) {
      const t = tiles[k] as GroundTile;
      expect(t.objects.filter((o) => o.kind === 'wrack').length, t.tile).toBeLessThanOrEqual(10);
    }
  });

  it('barriers stand above the mark and break below it in about the planned shares', () => {
    const tally = [0, 1, 2].map(() => ({ standing: 0, all: 0 }));
    for (const o of objects) {
      if (o.kind !== 'wall' && o.kind !== 'hedgebank') continue;
      const band = bandFor(heightAt(terrain, o.x, o.y), hwAt(flood.hw, o.x, o.y));
      const t = tally[band]!;
      t.all++;
      if (o.extra !== BARRIER_BROKEN) t.standing++;
    }
    expect(tally[Band.Above]!.standing).toBe(tally[Band.Above]!.all);
    for (const b of [Band.Strandline, Band.Scour] as const) {
      const t = tally[b]!;
      expect(t.all).toBeGreaterThan(100);
      expect(Math.abs(t.standing / t.all - BARRIER_STAND_P[b])).toBeLessThan(0.1);
    }
  });

  it('holds the size budget', () => {
    let total = 0;
    for (const t of tiles) {
      const bytes = Buffer.byteLength(raw.get(t.tile) as string);
      total += bytes;
      expect(t.objects.length, t.tile).toBeLessThanOrEqual(MAX_OBJECTS_PER_TILE);
      expect(bytes, t.tile).toBeLessThanOrEqual(TILE_WARN_BYTES);
      expect(serialiseGround(JSON.parse(raw.get(t.tile) as string) as GroundFile)).toBe(raw.get(t.tile));
    }
    expect(total).toBeLessThanOrEqual(TOTAL_MAX_BYTES);
    expect(objects.length).toBeGreaterThan(10_000);
  });

  it('places every debris kind', () => {
    const kinds = new Set(objects.map((o) => o.kind));
    for (const k of ['wall', 'hedgebank', 'rubble', 'car', 'trunk', 'wrack']) expect(kinds.has(k), k).toBe(true);
  });
});
