// Hint mode (SX 04): an optional, faint "you saw something here" dot on the paper map. Off by default. A hint is
// only a position, deduped per feature id; it carries no text and no kind of damage. Hints are recorded when a tile
// with notable damage is shown (visited or seen through the scope), and when the player walks within
// HINT_WALK_RADIUS_M of such a feature. With the mode off nothing is recorded. Pure; no three, no DOM.
import type { Districts } from '../world/districts';
import { TILES_PER_SIDE, TILE_M, tileId } from '../world/terrain';

export const HINT_WALK_RADIUS_M = 150;
/** A crater with at least this radius counts as notable, metres. */
export const HINT_CRATER_MIN_R_M = 10;

export interface Hint {
  id: string;
  x: number;
  y: number;
}

export interface HintsSave {
  hints: Hint[];
}

/** Notable features by tile id: fallen bridges, blocked road segments, strike zones and large craters. */
export function notableFeatures(d: Districts): Map<string, Hint[]> {
  const out = new Map<string, Hint[]>();
  const add = (tile: string, h: Hint): void => {
    const list = out.get(tile);
    if (list) list.push(h);
    else out.set(tile, [h]);
  };
  const inside = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < TILES_PER_SIDE && j < TILES_PER_SIDE;
  for (const b of d.bridges) {
    const i = Math.floor(b.x / TILE_M);
    const j = Math.floor(b.y / TILE_M);
    if (!b.standing && inside(i, j)) add(tileId(i, j), { id: b.id, x: b.x, y: b.y });
  }
  for (const s of d.roadSegments) {
    const m = s.pts[Math.floor(s.pts.length / 2)];
    if (!s.blocked || !m) continue;
    add(s.tile, { id: s.id, x: m[0], y: m[1] });
  }
  for (const t of d.tiles) {
    for (const z of t.strikeZones) add(t.id, { id: z.id, x: z.x, y: z.y });
    for (const c of t.craters) if (c.r >= HINT_CRATER_MIN_R_M) add(t.id, { id: c.id, x: c.x, y: c.y });
  }
  return out;
}

export class Hints {
  enabled = false;
  private readonly byId = new Map<string, Hint>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly features: ReadonlyMap<string, Hint[]>) {}

  get all(): readonly Hint[] {
    return [...this.byId.values()];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tiles have just been shown: hint every notable feature in them. */
  tilesShown(ids: readonly string[]): void {
    if (!this.enabled) return;
    let changed = false;
    for (const id of ids) for (const h of this.features.get(id) ?? []) changed = this.add(h) || changed;
    if (changed) this.emit();
  }

  /** The player is at (x, y): hint features within HINT_WALK_RADIUS_M. */
  walk(x: number, y: number): void {
    if (!this.enabled) return;
    const ti = Math.floor(x / TILE_M);
    const tj = Math.floor(y / TILE_M);
    let changed = false;
    for (let j = tj - 1; j <= tj + 1; j++) {
      for (let i = ti - 1; i <= ti + 1; i++) {
        if (i < 0 || j < 0 || i >= TILES_PER_SIDE || j >= TILES_PER_SIDE) continue;
        for (const h of this.features.get(tileId(i, j)) ?? []) {
          if (!this.byId.has(h.id) && Math.hypot(h.x - x, h.y - y) <= HINT_WALK_RADIUS_M) changed = this.add(h) || changed;
        }
      }
    }
    if (changed) this.emit();
  }

  serialize(): HintsSave {
    return { hints: this.all.map((h) => ({ ...h })) };
  }

  load(data: unknown): void {
    const list = (data as Partial<HintsSave> | null)?.hints;
    if (!Array.isArray(list)) return;
    for (const h of list as Array<Partial<Hint>>) {
      if (h && typeof h.id === 'string' && Number.isFinite(h.x) && Number.isFinite(h.y)) this.add({ id: h.id, x: h.x as number, y: h.y as number });
    }
  }

  private add(h: Hint): boolean {
    if (this.byId.has(h.id)) return false;
    this.byId.set(h.id, { id: h.id, x: h.x, y: h.y });
    return true;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
