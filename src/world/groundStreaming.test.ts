import { describe, expect, it } from 'vitest';
import { GroundStreaming, tilesAround } from './groundStreaming';
import { TILE_M, tileId } from './terrain';

describe('ground streaming', () => {
  it('wants the 3x3 block at a tile corner', () => {
    // Exactly on the corner shared by tiles (3..4, 5..6): the point belongs to tile (4, 6).
    const want: string[] = [];
    for (let j = 5; j <= 7; j++) for (let i = 3; i <= 5; i++) want.push(tileId(i, j));
    expect(tilesAround(4 * TILE_M, 6 * TILE_M)).toEqual(want);
  });

  it('clips the block at the patch corners', () => {
    expect(tilesAround(0, 0)).toEqual([tileId(0, 0), tileId(1, 0), tileId(0, 1), tileId(1, 1)]);
    expect(tilesAround(10 * TILE_M, 10 * TILE_M)).toEqual([tileId(8, 8), tileId(9, 8), tileId(8, 9), tileId(9, 9)]);
  });

  it('adds scope requests until they expire', () => {
    const s = new GroundStreaming();
    const far = tileId(9, 9);
    s.requestTileDetail(far, 1000, 500);
    s.requestTileDetail('nonsense', 1000);
    expect(s.wanted(500, 500, 1200)).toContain(far);
    expect(s.wanted(500, 500, 1200)).toHaveLength(5);
    expect(s.wanted(500, 500, 1500)).not.toContain(far);
    // A request inside the block is not listed twice.
    s.requestTileDetail(tileId(0, 0), 0);
    expect(s.wanted(500, 500, 1)).toHaveLength(4);
  });
});
