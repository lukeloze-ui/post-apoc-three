import { describe, expect, it } from 'vitest';
import { GameClock, START_MINUTES, formatGameTime, parseGameTime } from './time';

describe('game time', () => {
  it("parses 'd1-07:00'", () => {
    expect(parseGameTime('d1-07:00')).toBe(1440 + 7 * 60);
    expect(parseGameTime('d0-18:00')).toBe(START_MINUTES);
    expect(parseGameTime('d2')).toBe(2880);
    expect(parseGameTime('d1-25:00')).toBeUndefined();
    expect(parseGameTime('nope')).toBeUndefined();
  });

  it('formats and round-trips', () => {
    expect(formatGameTime(1440 + 7 * 60)).toBe('d1-07:00');
    expect(parseGameTime(formatGameTime(5000))).toBe(5000);
  });

  it('starts at day 0 18:00 and advances in game seconds', () => {
    const c = new GameClock();
    expect(c.format()).toBe('d0-18:00');
    c.advance(6 * 3600 + 30 * 60);
    expect(c.day).toBe(1);
    expect(c.hh).toBe(0);
    expect(c.mm).toBe(30);
    expect(c.format()).toBe('d1-00:30');
  });
});
