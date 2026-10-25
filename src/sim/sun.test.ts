import { describe, expect, it } from 'vitest';
import { gameMinutesToUtcMs, parseGameTime } from './time';
import { sunPosition } from './sun';

const alt = (t: string): number => sunPosition(gameMinutesToUtcMs(parseGameTime(t)!)).altitude;

/** First time in [from, to] (game minutes) the altitude crosses zero, searched by the minute. */
function crossing(fromT: string, toT: string, rising: boolean): number {
  const from = parseGameTime(fromT)!;
  const to = parseGameTime(toT)!;
  for (let m = from; m < to; m++) {
    const a = sunPosition(gameMinutesToUtcMs(m)).altitude;
    const b = sunPosition(gameMinutesToUtcMs(m + 1)).altitude;
    if (rising ? a < 0 && b >= 0 : a > 0 && b <= 0) return m + 1 - Math.floor((m + 1) / 1440) * 1440;
  }
  throw new Error('no crossing');
}

describe('sun position', () => {
  it('is near its peak on day 0 at 13:20 BST', () => {
    const a = alt('d0-13:20');
    expect(a).toBeGreaterThan(60.5);
    expect(a).toBeLessThan(62);
  });

  it('sets on day 0 between 21:15 and 21:35 BST', () => {
    const m = crossing('d0-20:00', 'd0-23:00', false);
    expect(m).toBeGreaterThanOrEqual(21 * 60 + 15);
    expect(m).toBeLessThanOrEqual(21 * 60 + 35);
  });

  it('rises on day 1 between 05:10 and 05:35 BST', () => {
    const m = crossing('d1-04:00', 'd1-07:00', true);
    expect(m).toBeGreaterThanOrEqual(5 * 60 + 10);
    expect(m).toBeLessThanOrEqual(5 * 60 + 35);
  });

  it('is south at noon, west-north-west at sunset, below horizon at midnight', () => {
    const noon = sunPosition(gameMinutesToUtcMs(parseGameTime('d0-13:22')!));
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(3);
    const set = sunPosition(gameMinutesToUtcMs(parseGameTime('d0-21:25')!));
    expect(set.azimuth).toBeGreaterThan(290);
    expect(set.azimuth).toBeLessThan(310);
    expect(alt('d1-00:30')).toBeLessThan(-6);
  });
});
