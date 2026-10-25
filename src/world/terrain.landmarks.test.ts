// Checks the committed terrain against well-known heights. Real OS Terrain 50 needs a tight tolerance;
// the synthetic stand-in is only shaped to land near these numbers, so it gets a loose one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gridRefSX } from './geo';
import { START, YES_TOR, heightAt, isSynthetic, parseTerrain, type TerrainMeta } from './terrain';

const dir = 'public/world/';
const meta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
const t = parseTerrain(meta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
const tol = isSynthetic(meta) ? 40 : 15;

const HIGH_WILLHAYS = gridRefSX(580, 892);

/** Highest post-interpolated height within radius metres. A 50 m grid smooths summits, and the landmark refs are only to 100 m. */
function summit(x: number, y: number, radius = 150): number {
  let best = -Infinity;
  for (let dx = -radius; dx <= radius; dx += 10) {
    for (let dy = -radius; dy <= radius; dy += 10) {
      if (Math.hypot(dx, dy) <= radius) best = Math.max(best, heightAt(t, x + dx, y + dy));
    }
  }
  return best;
}
/** Okehampton town centre, SX 587 951. */
const TOWN = gridRefSX(587, 951);

describe(`terrain landmarks (${meta.source}, tolerance ${tol} m)`, () => {
  it('Yes Tor is about 619 m', () => {
    expect(Math.abs(summit(YES_TOR.x, YES_TOR.y) - 619)).toBeLessThanOrEqual(tol);
  });

  it('High Willhays is about 621 m', () => {
    expect(Math.abs(summit(HIGH_WILLHAYS.x, HIGH_WILLHAYS.y) - 621)).toBeLessThanOrEqual(tol);
  });

  it('the start is about 470 m', () => {
    expect(Math.abs(heightAt(t, START.x, START.y) - 470)).toBeLessThanOrEqual(tol);
  });

  it('Okehampton centre is below 200 m', () => {
    expect(heightAt(t, TOWN.x, TOWN.y)).toBeLessThan(200);
  });
});
