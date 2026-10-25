// A per-tile spatial index of road segments, so "is this point on a road?" is a short scan, not a scan of every road.
// Local frame as in terrain.ts: x metres east, y metres north from the patch's SW corner.
import type { RoadClass, RoadFeature } from './features';
import { TILES_PER_SIDE, tileOf } from './terrain';

/** Walkable half-width (metres) by class: half the drawn width, but never under 1.5 m so tracks and paths can be kept to. */
export const ROAD_HALF_WIDTH_M: Readonly<Record<RoadClass, number>> = { A: 4.5, B: 3.5, minor: 2.5, track: 1.5, path: 1.5 };

/** Best first: where roads overlap, the earlier class wins. */
const CLASS_ORDER: readonly RoadClass[] = ['A', 'B', 'minor', 'track', 'path'];

export interface RoadIndex {
  /** ax, ay, bx, by, half-width per segment. */
  segs: Float64Array;
  /** Index into CLASS_ORDER per segment. */
  cls: Uint8Array;
  /** Segment ids per 1 km tile, row-major (i + j * TILES_PER_SIDE). */
  tiles: Int32Array[];
}

export function buildRoadIndex(roads: readonly RoadFeature[]): RoadIndex {
  const segs: number[] = [];
  const cls: number[] = [];
  const tiles: number[][] = Array.from({ length: TILES_PER_SIDE * TILES_PER_SIDE }, () => []);
  for (const road of roads) {
    const c = CLASS_ORDER.indexOf(road.cls);
    const hw = ROAD_HALF_WIDTH_M[road.cls];
    for (let k = 0; k + 1 < road.pts.length; k++) {
      const [ax, ay] = road.pts[k] as readonly [number, number];
      const [bx, by] = road.pts[k + 1] as readonly [number, number];
      const id = cls.length;
      segs.push(ax, ay, bx, by, hw);
      cls.push(c);
      const t0 = tileOf(Math.min(ax, bx) - hw, Math.min(ay, by) - hw);
      const t1 = tileOf(Math.max(ax, bx) + hw, Math.max(ay, by) + hw);
      for (let j = t0.j; j <= t1.j; j++) for (let i = t0.i; i <= t1.i; i++) (tiles[i + j * TILES_PER_SIDE] as number[]).push(id);
    }
  }
  return { segs: Float64Array.from(segs), cls: Uint8Array.from(cls), tiles: tiles.map((t) => Int32Array.from(t)) };
}

/** The best road class whose half-width reaches local (x, y), or undefined off the roads. */
export function roadAt(index: RoadIndex, x: number, y: number): RoadClass | undefined {
  const t = tileOf(x, y);
  const ids = index.tiles[t.i + t.j * TILES_PER_SIDE] as Int32Array;
  const s = index.segs;
  let best = CLASS_ORDER.length;
  for (let n = 0; n < ids.length; n++) {
    const id = ids[n] as number;
    const c = index.cls[id] as number;
    if (c >= best) continue;
    const o = id * 5;
    const ax = s[o] as number;
    const ay = s[o + 1] as number;
    const dx = (s[o + 2] as number) - ax;
    const dy = (s[o + 3] as number) - ay;
    const hw = s[o + 4] as number;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
    const ex = x - (ax + u * dx);
    const ey = y - (ay + u * dy);
    if (ex * ex + ey * ey <= hw * hw) best = c;
  }
  return best < CLASS_ORDER.length ? CLASS_ORDER[best] : undefined;
}
