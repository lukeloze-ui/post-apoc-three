import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Districts } from '../../../src/world/districts';
import { Band, type BandCode } from '../../../src/world/flood';
import { mulberry32 } from '../rng';
import { bridgeFallProbability, bridgeFalls, rollRoadBlock, stormBump, type WoodClass } from './damage';

const N = 10_000;
const TOL = 0.03;

function fellRatio(depth: number, bump = 0): number {
  const rng = mulberry32(0xbad5eed);
  let fell = 0;
  for (let i = 0; i < N; i++) if (bridgeFalls(rng, depth, bump)) fell++;
  return fell / N;
}

function blockedRatio(band: BandCode, wood: WoodClass): number {
  const rng = mulberry32(0x5eed1234);
  let blocked = 0;
  for (let i = 0; i < N; i++) if (rollRoadBlock(rng, band, wood).blocked) blocked++;
  return blocked / N;
}

describe('bridge fall rule', () => {
  it.each([
    [-30, 0.1],
    [-5, 0.1],
    [40, 0.9],
    [80, 0.95],
  ])('depth %i m below the mark falls about %f of the time', (depth, target) => {
    expect(Math.abs(fellRatio(depth) - target)).toBeLessThan(TOL);
  });

  it('rises smoothly and never falls with depth', () => {
    let prev = 0;
    for (let d = -20; d <= 100; d += 1) {
      const p = bridgeFallProbability(d);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('the storm bump is small, positive at the centre and fades with distance', () => {
    expect(stormBump(0)).toBeGreaterThan(0);
    expect(stormBump(0)).toBeLessThanOrEqual(0.06);
    expect(stormBump(10_000)).toBeLessThan(0.001);
    expect(bridgeFallProbability(20, stormBump(0))).toBeGreaterThan(bridgeFallProbability(20));
  });
});

describe('road blocked rule', () => {
  it.each([
    ['below the mark, through a wood', Band.Scour, 'in', 0.95],
    ['below the mark, beside a wood', Band.Scour, 'beside', 0.95],
    ['below the mark, open (scour)', Band.Scour, 'none', 0.5],
    ['strandline, open (wrack)', Band.Strandline, 'none', 0.65],
    ['above the mark, through a wood', Band.Above, 'in', 0.35],
    ['above the mark, open moor', Band.Above, 'none', 0.03],
  ] as [string, BandCode, WoodClass, number][])('%s is blocked about %f of the time', (_name, band, wood, target) => {
    expect(Math.abs(blockedRatio(band, wood) - target)).toBeLessThan(TOL);
  });

  it('records a cause exactly when blocked', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const r = rollRoadBlock(rng, (i % 4) as BandCode, (['in', 'beside', 'none'] as const)[i % 3] as WoodClass);
      expect(r.cause !== null).toBe(r.blocked);
    }
  });
});

describe('districts.json damage', () => {
  const d = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'public', 'world', 'districts.json'), 'utf8')) as Districts;

  /** Ratio of items in a group satisfying pred; null (with a logged note) when the group has fewer than 5 items. */
  function ratio<T>(label: string, items: T[], pred: (t: T) => boolean): number | null {
    if (items.length < 5) {
      console.log(`districts damage: skipping "${label}", only ${items.length} item(s)`);
      return null;
    }
    return items.filter(pred).length / items.length;
  }

  it('bridges 30 m or more below the mark mostly fell', () => {
    const r = ratio('bridges >= 30 m below', d.bridges.filter((b) => b.depthBelowMark >= 30), (b) => !b.standing);
    if (r !== null) expect(r).toBeGreaterThanOrEqual(0.7);
  });

  it('bridges above the mark mostly stand', () => {
    const r = ratio('bridges above the mark', d.bridges.filter((b) => b.depthBelowMark <= 0), (b) => !b.standing);
    if (r !== null) expect(r).toBeLessThanOrEqual(0.3);
  });

  it('woodland roads below the mark are mostly blocked', () => {
    const r = ratio('wood roads below the mark', d.roadSegments.filter((s) => s.inWood && s.band >= Band.Strandline), (s) => s.blocked);
    if (r !== null) expect(r).toBeGreaterThanOrEqual(0.8);
  });

  it('open moor roads above the mark are rarely blocked', () => {
    const r = ratio('open roads above the mark', d.roadSegments.filter((s) => !s.inWood && s.band === Band.Above), (s) => s.blocked);
    if (r !== null) expect(r).toBeLessThanOrEqual(0.15);
  });

  it('survivors stand and every blocked segment has a cause', () => {
    for (const s of d.survivors) {
      for (const id of s.bridgeIds) expect(d.bridges.find((b) => b.id === id)?.standing, id).toBe(true);
    }
    expect(d.roadSegments.filter((s) => s.blocked && s.cause === null)).toEqual([]);
    expect(d.bridges.filter((b) => b.reason === 'undecided')).toEqual([]);
  });
});
