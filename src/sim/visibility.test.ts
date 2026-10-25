import { describe, expect, it } from 'vitest';
import { activeSmoke, tileVisible, visibleRange, type SmokeSource } from './visibility';
import { VISIBILITY_M, weatherAt } from './weather';
import type { DistrictTile } from '../world/districts';

/** Flat ground at 100 m with a 400 m ridge running north-south between x = 2500 and 2600. */
const ridge = (x: number): number => (x >= 2500 && x <= 2600 ? 400 : 100);
const ridgeHeight = (x: number): number => ridge(x);
/** Flat ground at 0 m. */
const flat = (): number => 0;

const rangeFn = (eye: { x: number; y: number }, weather: Parameters<typeof visibleRange>[0], smoke: SmokeSource[] = []) =>
  (x: number, y: number): number => visibleRange(weather, { x0: eye.x, y0: eye.y, x1: x, y1: y }, smoke);

describe('tileVisible', () => {
  const eye = { x: 500, y: 5500, z: 101.7 };
  it('sees a tile in front of a ridge and not one behind it', () => {
    expect(tileVisible(eye, { i: 1, j: 5 }, ridgeHeight, 8000)).toBe(true);
    expect(tileVisible(eye, { i: 2, j: 5 }, ridgeHeight, 8000)).toBe(true);
    expect(tileVisible(eye, { i: 4, j: 5 }, ridgeHeight, 8000)).toBe(false);
    expect(tileVisible(eye, { i: 6, j: 5 }, ridgeHeight, 8000)).toBe(false);
  });
  it('sees over the ridge from higher up', () => {
    expect(tileVisible({ ...eye, z: 900 }, { i: 6, j: 5 }, ridgeHeight, 8000)).toBe(true);
  });
});

describe('visibleRange by weather', () => {
  const eye = { x: 500, y: 5500, z: 300 };
  const see = (i: number, weather: Parameters<typeof visibleRange>[0]): boolean =>
    tileVisible(eye, { i, j: 5 }, flat, rangeFn(eye, weather));
  it('is the weather range with no smoke', () => {
    for (const w of ['clear', 'haze', 'rain', 'heavyRain'] as const) {
      expect(visibleRange(w, { x0: 0, y0: 0, x1: 1, y1: 0 }, [])).toBe(VISIBILITY_M[w]);
    }
  });
  it('limits how far tiles show', () => {
    expect(see(7, 'clear')).toBe(true);
    expect(see(7, 'haze')).toBe(false);
    expect(see(4, 'haze')).toBe(true);
    expect(see(2, 'rain')).toBe(true);
    expect(see(3, 'rain')).toBe(false);
    expect(see(1, 'heavyRain')).toBe(true);
    expect(see(2, 'heavyRain')).toBe(false);
  });
  it('follows the schedule: clear on the day 0 evening, haze on day 1, rain on day 2', () => {
    expect(weatherAt(0.8)).toBe('clear');
    expect(weatherAt(1.5)).toBe('haze');
    expect(['rain', 'heavyRain']).toContain(weatherAt(2.5));
  });
});

describe('smoke', () => {
  const plume: SmokeSource = { x: 2500, y: 0, r: 100 };
  it('shortens the range when a plume crosses the ray', () => {
    const r = visibleRange('clear', { x0: 500, y0: 0, x1: 9000, y1: 0 }, [plume]);
    // 1900 m of clear air, then 200 m of smoke at 12x, leaves 3700 m: 5800 m in all.
    expect(r).toBeCloseTo(5800, 6);
    expect(visibleRange('clear', { x0: 500, y0: 0, x1: 9000, y1: 500 }, [plume])).toBe(8000);
    expect(visibleRange('clear', { x0: 500, y0: 0, x1: -9000, y1: 0 }, [plume])).toBe(8000);
  });
  it('can hide a tile the clear air would show', () => {
    const eye = { x: 500, y: 5500, z: 300 };
    const smoke = [{ x: 3000, y: 5500, r: 400 }];
    expect(tileVisible(eye, { i: 7, j: 5 }, flat, rangeFn(eye, 'clear'))).toBe(true);
    expect(tileVisible(eye, { i: 7, j: 5 }, flat, rangeFn(eye, 'clear', smoke))).toBe(false);
  });
  it('comes from burning strike zones and live fires', () => {
    const tile = {
      strikeZones: [
        { id: 's1', x: 0, y: 0, r: 150, kind: 'burning' },
        { id: 's2', x: 500, y: 0, r: 120, kind: 'glassy' },
      ],
      fires: [{ id: 'f1', x: 900, y: 0, r: 20, fromDay: 1, toDay: 2 }],
    } as unknown as DistrictTile;
    expect(activeSmoke([tile], 0.5).map((s) => s.x)).toEqual([0]);
    expect(activeSmoke([tile], 1.5).map((s) => s.x)).toEqual([0, 900]);
  });
});
