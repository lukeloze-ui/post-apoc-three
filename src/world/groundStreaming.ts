// Which tiles' ground detail should be loaded: the 3x3 block around the player, plus tiles the scope has asked for.
// Pure: the caller passes the time (any monotonic ms clock) and does the loading (GroundCache in ./ground).
import { TILES_PER_SIDE, tileId, tileOf } from './terrain';
import { tileIndexOf } from './ground';

/** How long a scope request keeps a tile wanted, ms. */
export const SCOPE_REQUEST_MS = 30_000;

/** Tile ids of the 3x3 block around local (x, y), clipped to the patch, row-major from the SW. */
export function tilesAround(x: number, y: number): string[] {
  const { i, j } = tileOf(x, y);
  const out: string[] = [];
  for (let jj = j - 1; jj <= j + 1; jj++) {
    for (let ii = i - 1; ii <= i + 1; ii++) {
      if (ii >= 0 && jj >= 0 && ii < TILES_PER_SIDE && jj < TILES_PER_SIDE) out.push(tileId(ii, jj));
    }
  }
  return out;
}

export class GroundStreaming {
  /** Tile id to the time its scope request runs out. */
  private readonly requests = new Map<string, number>();

  /** The scope is looking at this tile: keep it wanted until now + ttl. A repeat request extends it. */
  requestTileDetail(tile: string, now: number, ttl = SCOPE_REQUEST_MS): void {
    if (!tileIndexOf(tile)) return;
    this.requests.set(tile, Math.max(this.requests.get(tile) ?? -Infinity, now + ttl));
  }

  /** The wanted set: the block around the player, then live scope requests. Expired requests are dropped. */
  wanted(x: number, y: number, now: number): string[] {
    const out = tilesAround(x, y);
    const have = new Set(out);
    for (const [tile, until] of this.requests) {
      if (until <= now) this.requests.delete(tile);
      else if (!have.has(tile)) {
        out.push(tile);
        have.add(tile);
      }
    }
    return out;
  }
}
