// Which 1 km tiles show their district damage (SX 04). A tile is shown once it has been visited (the player was in
// it or within about 1 km of it) or revealed through the scope: optic up, the tile in the scope's view (with a
// margin), in sight and in range, and held there for DWELL_S of real time. Nothing goes on the paper map.
// Pure; no three, no DOM.
import { TILES_PER_SIDE, TILE_M, tileId } from '../world/terrain';
import { curvatureDrop, tileSamples, tileVisible, visibleRange, TARGET_LIFT_M, type Eye, type HeightFn, type SmokeSource } from './visibility';
import type { Weather } from './weather';

/** Real seconds a tile must stay in view before it is revealed. */
export const DWELL_S = 0.75;
/** Extra angle round the scope's field of view that still counts as in view, degrees. */
export const CONE_MARGIN_DEG = 1.5;
/** Tiles within this distance of where the player has been are revealed by visiting, metres. */
export const VISIT_RADIUS_M = 1000;
/** Tiles in view within this distance also ask for their ground detail, metres. */
export const DETAIL_RADIUS_M = 2000;
/** Real seconds between line-of-sight checks while the scope is up. */
export const CHECK_INTERVAL_S = 0.2;

/** Where the scope is pointing. */
export interface ScopeView {
  eye: Eye;
  /** Degrees, 0 = north, clockwise. */
  yawDeg: number;
  /** Degrees, positive looks up. */
  pitchDeg: number;
  /** Vertical field of view, degrees. */
  vFovDeg: number;
  /** Width over height of the view. */
  aspect: number;
}

export interface RevealWorld {
  heightAt: HeightFn;
  weather: Weather;
  smoke: readonly SmokeSource[];
}

export interface RevealSave {
  revealed: string[];
  visited: string[];
}

interface TileRef {
  id: string;
  i: number;
  j: number;
}

const TILES: TileRef[] = [];
for (let j = 0; j < TILES_PER_SIDE; j++) for (let i = 0; i < TILES_PER_SIDE; i++) TILES.push({ id: tileId(i, j), i, j });
const TILE_IDS = new Set(TILES.map((t) => t.id));

const DEG = Math.PI / 180;
const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;

/** Distance from (x, y) to the nearest point of tile (i, j), metres; 0 inside. */
export function distanceToTile(x: number, y: number, i: number, j: number): number {
  const x0 = i * TILE_M;
  const y0 = j * TILE_M;
  return Math.hypot(Math.max(x0 - x, 0, x - (x0 + TILE_M)), Math.max(y0 - y, 0, y - (y0 + TILE_M)));
}

/**
 * Whether a tile lies in the scope's view, widened by CONE_MARGIN_DEG: the bearings of its corners must bracket
 * the view's horizontal extent, and the elevations of its sample points the vertical.
 */
export function inScopeCone(view: ScopeView, i: number, j: number, heightAt: HeightFn): boolean {
  const { eye } = view;
  if (distanceToTile(eye.x, eye.y, i, j) === 0) return true;
  const vHalf = view.vFovDeg / 2;
  const hHalf = Math.atan(Math.tan(vHalf * DEG) * view.aspect) / DEG;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [cx, cy] of [
    [i, j],
    [i + 1, j],
    [i, j + 1],
    [i + 1, j + 1],
  ] as const) {
    const b = wrap180(Math.atan2(cx * TILE_M - eye.x, cy * TILE_M - eye.y) / DEG - view.yawDeg);
    lo = Math.min(lo, b);
    hi = Math.max(hi, b);
  }
  // Corners either side of straight behind: the tile is at the viewer's back.
  if (hi - lo > 180) return false;
  if (lo - hHalf - CONE_MARGIN_DEG > 0 || hi + hHalf + CONE_MARGIN_DEG < 0) return false;
  let eLo = Infinity;
  let eHi = -Infinity;
  for (const s of tileSamples({ i, j }, heightAt)) {
    const d = Math.hypot(s.x - eye.x, s.y - eye.y);
    const e = Math.atan2(heightAt(s.x, s.y) + TARGET_LIFT_M - curvatureDrop(d) - eye.z, d) / DEG;
    eLo = Math.min(eLo, e);
    eHi = Math.max(eHi, e);
  }
  return view.pitchDeg >= eLo - vHalf - CONE_MARGIN_DEG && view.pitchDeg <= eHi + vHalf + CONE_MARGIN_DEG;
}

export class Reveal {
  private readonly revealedSet = new Set<string>();
  private readonly visitedSet = new Set<string>();
  /** Tile id to real seconds held in view so far. */
  private readonly dwell = new Map<string, number>();
  /** Tiles in view and in sight at the last check. */
  private inSight: string[] = [];
  private sinceCheck = Infinity;
  private readonly listeners = new Set<(ids: string[]) => void>();

  get revealed(): ReadonlySet<string> {
    return this.revealedSet;
  }

  get visited(): ReadonlySet<string> {
    return this.visitedSet;
  }

  /** Tiles in view and in sight at the last check (for the debug view). */
  get looking(): readonly string[] {
    return this.inSight;
  }

  /** True when the tile's district damage is shown: visited or revealed. */
  isShown(id: string): boolean {
    return this.visitedSet.has(id) || this.revealedSet.has(id);
  }

  /** Called with the ids that have just become shown. */
  subscribe(fn: (ids: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The player is at (x, y): every tile within VISIT_RADIUS_M is visited. Returns the newly shown ids. */
  visit(x: number, y: number): string[] {
    const shown: string[] = [];
    for (const t of TILES) {
      if (this.visitedSet.has(t.id) || distanceToTile(x, y, t.i, t.j) > VISIT_RADIUS_M) continue;
      this.visitedSet.add(t.id);
      this.dwell.delete(t.id);
      if (!this.revealedSet.has(t.id)) shown.push(t.id);
    }
    this.emit(shown);
    return shown;
  }

  /**
   * Call each frame with real seconds. `view` is null unless the optic is fully up (Scope.scoped). Tiles in sight
   * within DETAIL_RADIUS_M are passed to requestTileDetail at each check. Returns the newly revealed ids.
   */
  update(dtReal: number, view: ScopeView | null, world: RevealWorld, requestTileDetail?: (id: string) => void): string[] {
    if (!view) {
      this.dwell.clear();
      this.inSight = [];
      this.sinceCheck = Infinity;
      return [];
    }
    this.sinceCheck += dtReal;
    if (this.sinceCheck >= CHECK_INTERVAL_S) {
      this.sinceCheck = 0;
      this.inSight = this.check(view, world);
      if (requestTileDetail) {
        for (const id of this.inSight) {
          const t = TILES.find((q) => q.id === id) as TileRef;
          if (distanceToTile(view.eye.x, view.eye.y, t.i, t.j) <= DETAIL_RADIUS_M) requestTileDetail(id);
        }
      }
    }
    const now = new Set(this.inSight);
    for (const id of [...this.dwell.keys()]) if (!now.has(id)) this.dwell.delete(id);
    const shown: string[] = [];
    for (const id of this.inSight) {
      if (this.revealedSet.has(id)) continue;
      const held = (this.dwell.get(id) ?? 0) + dtReal;
      if (held < DWELL_S) {
        this.dwell.set(id, held);
        continue;
      }
      this.dwell.delete(id);
      this.revealedSet.add(id);
      if (!this.visitedSet.has(id)) shown.push(id);
    }
    this.emit(shown);
    return shown;
  }

  serialize(): RevealSave {
    return { revealed: [...this.revealedSet].sort(), visited: [...this.visitedSet].sort() };
  }

  load(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Partial<RevealSave>;
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && TILE_IDS.has(s)) : []);
    const shown = [...ids(d.revealed), ...ids(d.visited)].filter((id) => !this.isShown(id));
    for (const id of ids(d.revealed)) this.revealedSet.add(id);
    for (const id of ids(d.visited)) this.visitedSet.add(id);
    this.emit([...new Set(shown)]);
  }

  /** Tiles in the cone, in sight and in range; visited tiles are skipped unless they are near enough for detail. */
  private check(view: ScopeView, world: RevealWorld): string[] {
    const out: string[] = [];
    const { eye } = view;
    const range = (x: number, y: number): number => visibleRange(world.weather, { x0: eye.x, y0: eye.y, x1: x, y1: y }, world.smoke);
    for (const t of TILES) {
      const d = distanceToTile(eye.x, eye.y, t.i, t.j);
      if (this.visitedSet.has(t.id) && d > DETAIL_RADIUS_M) continue;
      if (!inScopeCone(view, t.i, t.j, world.heightAt)) continue;
      if (tileVisible(eye, t, world.heightAt, range)) out.push(t.id);
    }
    return out;
  }

  private emit(ids: string[]): void {
    if (ids.length === 0) return;
    for (const fn of this.listeners) fn(ids);
  }
}
