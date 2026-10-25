import { describe, expect, it } from 'vitest';
import { ORIGIN_E, ORIGIN_N, gridRefSX, localToOsgb, osgbToLocal, wgs84ToOsgb } from './geo';

const dms = (d: number, m: number, s: number): number => d + m / 60 + s / 3600;

describe('geo', () => {
  it('converts a published ETRS89/WGS84 position to the grid (Caister water tower, OS worked example)', () => {
    const { e, n } = wgs84ToOsgb(dms(52, 39, 28.8282), dms(1, 42, 57.8663));
    // Published 651409.903, 313177.270; the Helmert shift is good to a few metres.
    expect(Math.abs(e - 651409.903)).toBeLessThan(8);
    expect(Math.abs(n - 313177.27)).toBeLessThan(8);
  });

  it('places the start near SX 588 911', () => {
    const { e, n } = wgs84ToOsgb(50.7024, -3.9942);
    expect(Math.abs(e - 258800)).toBeLessThan(800);
    expect(Math.abs(n - 91100)).toBeLessThan(800);
  });

  it('maps OSGB to the local frame and back', () => {
    expect(osgbToLocal(ORIGIN_E, ORIGIN_N)).toEqual({ x: 0, y: 0 });
    expect(gridRefSX(580, 901)).toEqual({ x: 6000, y: 2100 });
    expect(localToOsgb(1234, 5678)).toEqual({ e: ORIGIN_E + 1234, n: ORIGIN_N + 5678 });
  });
});
