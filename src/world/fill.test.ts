import { describe, expect, it } from 'vitest';
import { labelLakes, priorityFlood } from './fill';

/** Builds a w x h grid from rows written north (top) to south, so row 0 of the grid is the last string. */
function grid(rows: string[], key: Record<string, number>): { heights: number[]; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const heights: number[] = [];
  for (let y = 0; y < h; y++) for (const c of rows[h - 1 - y]!) heights.push(key[c] as number);
  return { heights, w, h };
}

const label = (g: { heights: number[]; w: number; h: number }, markAt?: (x: number, y: number) => number) =>
  labelLakes(g.heights, priorityFlood(g.heights, g.w, g.h), g.w, g.h, { cellM: 10, markAt });

describe('priorityFlood', () => {
  it('fills a single bowl to its lowest rim', () => {
    const g = grid(['99999', '95559', '95159', '95559', '99999'], { '9': 20, '5': 10, '1': 4 });
    const f = priorityFlood(g.heights, g.w, g.h);
    expect(f[2 * 5 + 2]).toBe(20);
    const { lakes, ids } = label(g);
    expect(lakes).toHaveLength(1);
    const lake = lakes[0]!;
    expect(lake).toMatchObject({ id: 1, spill: 20, floor: 4, maxDepth: 16, area: 900 });
    expect(lake.volume).toBe((10 * 8 + 16) * 100);
    expect(ids[2 * 5 + 2]).toBe(1);
    expect(ids[0]).toBe(0);
  });

  it('spills at the lowest point of the rim', () => {
    const g = grid(['99999', '95559', '95159', '95559', '99969'], { '9': 20, '6': 12, '5': 10, '1': 4 });
    const f = priorityFlood(g.heights, g.w, g.h);
    expect(f[2 * 5 + 2]).toBe(12);
    expect(label(g).lakes[0]!.spill).toBe(12);
  });

  it('gives a hollow open to the edge no lake', () => {
    const g = grid(['99999', '95559', '95159', '95159', '99199'], { '9': 20, '5': 10, '1': 4 });
    const f = priorityFlood(g.heights, g.w, g.h);
    expect(f[2 * 5 + 2]).toBe(4);
    expect(label(g).lakes).toHaveLength(0);
  });

  it('gives a flat plateau no lake', () => {
    const g = grid(['55555', '55555', '55555'], { '5': 10 });
    expect(Array.from(priorityFlood(g.heights, g.w, g.h))).toEqual(g.heights);
    expect(label(g).lakes).toHaveLength(0);
  });

  it('ignores hollows no deeper than 0.5 m', () => {
    const g = grid(['999', '989', '999'], { '9': 10, '8': 9.6 });
    expect(label(g).lakes).toHaveLength(0);
  });

  it('merges nested hollows once their sill is submerged', () => {
    // Two bowls (floors 2 and 4) divided by a sill at 8, inside a rim of 12.
    const g = grid(['rrrrrrr', 'r22s44r', 'r22s44r', 'rrrrrrr'], { r: 12, '2': 2, s: 8, '4': 4 });
    const { lakes } = label(g);
    expect(lakes).toHaveLength(1);
    expect(new Set(lakes.map((l) => l.spill))).toEqual(new Set([12]));
  });

  it('keeps two hollows separate when they share a spill point at the sill', () => {
    // Bowls A (x 1..2) and B (x 4..5) with a ridge column at x=3 exactly as high as the rim they spill over.
    const g = grid(['rrrrrrr', 'r11r11r', 'r11r11r', 'rrrrrrr'], { r: 12, '1': 2 });
    const { lakes, ids } = label(g);
    expect(lakes).toHaveLength(2);
    expect(lakes.map((l) => l.spill)).toEqual([12, 12]);
    expect(ids[1 * 7 + 1]).not.toBe(ids[1 * 7 + 4]);
  });

  it('keeps a lower neighbour separate when the upper hollow spills into it', () => {
    // A (floor 2, rim 15) drains over its sill into B (floor 1, outlet at 10 into the edge).
    const g = grid(['rrrrrrr', 'rAAsBBo', 'rAAsBBo', 'rrrrrrr'], { r: 30, A: 2, s: 15, B: 1, o: 10 });
    const { lakes } = label(g);
    expect(lakes.map((l) => l.spill).sort((a, b) => a - b)).toEqual([10, 15]);
  });

  it('marks a hollow salt only when its spill is at or below the mark', () => {
    const g = grid(['99999', '95559', '95159', '95559', '99999'], { '9': 20, '5': 10, '1': 4 });
    expect(label(g, () => 20).lakes[0]!.salt).toBe(true);
    expect(label(g, () => 19.9).lakes[0]!.salt).toBe(false);
    expect(label(g).lakes[0]!.salt).toBe(false);
  });

  it('lets isFresh override salt', () => {
    const g = grid(['99999', '95559', '95159', '95559', '99999'], { '9': 20, '5': 10, '1': 4 });
    const f = priorityFlood(g.heights, g.w, g.h);
    const out = labelLakes(g.heights, f, g.w, g.h, { cellM: 10, markAt: () => 100, isFresh: () => true });
    expect(out.lakes[0]!.salt).toBe(false);
  });
});
