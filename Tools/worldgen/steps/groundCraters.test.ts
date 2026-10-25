// Committed-data checks on the small ground craters (spec SX 02, crater sizing).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Districts } from '../../../src/world/districts';
import { parseGround } from '../../../src/world/ground';
import { START, TILES_PER_SIDE, tileId } from '../../../src/world/terrain';
import { CRATER_MIN_D, GROUND_CRATER_MIN_D, craterCumulative, smallCratersPerDistrictCrater } from '../rules/craters';

const districts = JSON.parse(readFileSync('public/world/districts.json', 'utf8')) as Districts;
const perTile: number[] = [];
const sizes: number[] = [];
const nearStart: number[] = [];
for (let j = 0; j < TILES_PER_SIDE; j++) {
  for (let i = 0; i < TILES_PER_SIDE; i++) {
    const id = tileId(i, j);
    const craters = parseGround(JSON.parse(readFileSync(`public/world/ground/${id}.json`, 'utf8')), id).objects.filter((o) => o.kind === 'crater');
    perTile.push(craters.length);
    for (const c of craters) {
      sizes.push(c.size);
      nearStart.push(Math.hypot(c.x - START.x, c.y - START.y) - c.size / 2);
    }
  }
}
const district = districts.tiles.flatMap((t) => t.craters);

describe('ground craters', () => {
  it('stay between the ground minimum and the district threshold, and off the start', () => {
    expect(sizes.length).toBeGreaterThan(1000);
    for (const d of sizes) {
      expect(d).toBeGreaterThanOrEqual(GROUND_CRATER_MIN_D - 0.1);
      expect(d).toBeLessThanOrEqual(CRATER_MIN_D + 0.1);
    }
    expect(Math.min(...nearStart)).toBeGreaterThan(0);
  });

  it('are in the curve ratio to the district craters across the patch, within a factor of 2', () => {
    const want = smallCratersPerDistrictCrater();
    const got = sizes.length / district.length;
    expect(got).toBeGreaterThan(want / 2);
    expect(got).toBeLessThan(want * 2);
    // The spec's round numbers: about 10 of 15 m and about 100 of 5 m per 50 m crater, so 5 to 12 small per district crater.
    expect(want).toBeGreaterThan(5);
    expect(want).toBeLessThan(12);
  });

  it('follow the size curve: the share at 10 m and up is within a factor of 2 of the power law', () => {
    const share = sizes.filter((d) => d >= 10).length / sizes.length;
    const want = craterCumulative(10, GROUND_CRATER_MIN_D, CRATER_MIN_D);
    expect(share).toBeGreaterThan(want / 2);
    expect(share).toBeLessThan(want * 2);
  });

  it('follow the pocked falloff: pocked tiles hold more than quiet ones', () => {
    const pocked = districts.tiles.map((t) => t.pocked);
    const all = pocked.map((_, k) => k);
    const hi = all.filter((k) => pocked[k]! >= 0.5);
    const lo = all.filter((k) => pocked[k]! <= 0.1);
    expect(hi.length).toBeGreaterThan(0);
    expect(lo.length).toBeGreaterThan(0);
    const mean = (ks: number[]): number => ks.reduce((a, k) => a + perTile[k]!, 0) / ks.length;
    expect(mean(hi)).toBeGreaterThan(3 * mean(lo));
  });
});
