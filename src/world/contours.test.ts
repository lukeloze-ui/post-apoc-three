import { describe, expect, it } from 'vitest';
import { contours, gridFromDm, levelsBetween, type ContourGrid } from './contours';

/** A cone of height 100 - 0.1 r centred on the grid, 10 m posts. */
function cone(n = 201, cellM = 10): ContourGrid {
  const heights = new Float32Array(n * n);
  const c = ((n - 1) / 2) * cellM;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) heights[j * n + i] = 100 - 0.1 * Math.hypot(i * cellM - c, j * cellM - c);
  }
  return { heights, nx: n, ny: n, cellM };
}

describe('contours', () => {
  it('turns a cone into closed rings at the expected radii', () => {
    const grid = cone();
    const c = 1000;
    const levels = [90, 80, 70, 60];
    const lines = contours(grid, levels);
    expect(lines).toHaveLength(levels.length);
    for (const line of lines) {
      expect(line.closed).toBe(true);
      expect(line.pts[0]).toEqual(line.pts[line.pts.length - 1]);
      const r = (100 - line.level) * 10;
      for (const [x, y] of line.pts) expect(Math.abs(Math.hypot(x - c, y - c) - r)).toBeLessThan(0.02 * r);
    }
  });

  it('gives open lines where a contour runs off the grid', () => {
    const grid = cone();
    // Level -10 is a circle of radius 1100 m: only the four corners of the 2 km grid fall outside it.
    const edge = contours(grid, [-10]);
    expect(edge).toHaveLength(4);
    expect(edge.every((l) => !l.closed)).toBe(true);
  });

  it('joins a ramp into one open line across the grid', () => {
    const n = 11;
    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = i;
    const lines = contours({ heights, nx: n, ny: n, cellM: 10 }, [4.5], { smooth: 0 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.closed).toBe(false);
    expect(line.pts).toHaveLength(n);
    for (const [x] of line.pts) expect(x).toBeCloseTo(45, 6);
  });

  it('does not put a vertex on a level when the post height equals it', () => {
    const n = 5;
    const heights = new Float32Array(n * n).fill(10);
    heights[12] = 0;
    const lines = contours({ heights, nx: n, ny: n, cellM: 1 }, [10], { smooth: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closed).toBe(true);
  });

  it('converts decimetre posts and lists levels', () => {
    const g = gridFromDm(Int16Array.from([100, 205, 0, 0]), 2, 2, 50);
    expect(Array.from(g.heights)).toEqual([10, 20.5, 0, 0]);
    expect(levelsBetween(12, 41, 10)).toEqual([20, 30, 40]);
  });
});
