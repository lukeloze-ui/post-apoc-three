// Line of sight for the scope (SX 04): how far the air lets you see along a ray, and whether a 1 km tile shows
// over the ground in between. Pure; no three, no DOM. Local metres as in world/terrain.ts.
import type { DistrictTile } from '../world/districts';
import { TILE_M, type TileIndex } from '../world/terrain';
import { VISIBILITY_M, type Weather } from './weather';

/** A smoke plume, seen from above: a circle the sight line has to pass through. */
export interface SmokeSource {
  x: number;
  y: number;
  r: number;
}

/** A horizontal ray from (x0, y0) towards (x1, y1); only its direction matters past the start. */
export interface Ray {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Eye {
  x: number;
  y: number;
  /** Height of the eye, metres above datum. */
  z: number;
}

export type HeightFn = (x: number, y: number) => number;

/** Each metre of smoke on the ray uses up this many metres of the clear-air range. */
export const SMOKE_COST = 12;
/** A tile shows when at least this many of its sample points can be seen. */
export const MIN_VISIBLE_SAMPLES = 2;
/** The sight line aims this far above the ground at a sample: a heap, a bridge deck, a scorched hedge. */
export const TARGET_LIFT_M = 2;
/** Ray-march step, metres (half a terrain cell). */
const STEP_M = 25;
/** Ground this close to the target is its own ground, not something in the way. */
const FAR_SKIP_M = 20;
/** Earth's radius with the usual refraction allowance (k = 0.13), for the drop of distant ground. */
const R_EFF_M = 6_371_000 / 0.87;
/** Highest-post samples per tile, and how far apart they must be. */
const HIGH_POSTS = 4;
const HIGH_POST_SEP_M = 250;
/** Corner samples sit this far inside the tile. */
const CORNER_INSET_M = 25;
const POST_M = 50;

/** The smoke burning at a game day: burning strike zones (while their fire lasts) and the fires. */
export function activeSmoke(tiles: readonly DistrictTile[], gameDays: number): SmokeSource[] {
  const out: SmokeSource[] = [];
  for (const t of tiles) {
    for (const z of t.strikeZones) {
      if (z.kind !== 'burning') continue;
      const f = t.fires.find((q) => Math.hypot(q.x - z.x, q.y - z.y) < 1);
      if (f && (gameDays < f.fromDay || gameDays >= f.toDay)) continue;
      out.push({ x: z.x, y: z.y, r: z.r });
    }
    for (const f of t.fires) {
      if (gameDays < f.fromDay || gameDays >= f.toDay) continue;
      if (t.strikeZones.some((z) => z.kind === 'burning' && Math.hypot(f.x - z.x, f.y - z.y) < 1)) continue;
      out.push({ x: f.x, y: f.y, r: 0.6 * f.r + 6 });
    }
  }
  return out;
}

/**
 * How far the scope can make out damage along a ray, metres: the weather's range, cut where smoke crosses the ray
 * (each metre inside a plume costs SMOKE_COST metres of range; overlapping plumes add up).
 */
export function visibleRange(weather: Weather, ray: Ray, smokeSources: readonly SmokeSource[]): number {
  const base = VISIBILITY_M[weather];
  const dx = ray.x1 - ray.x0;
  const dy = ray.y1 - ray.y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return base;
  const ux = dx / len;
  const uy = dy / len;
  // Each plume the ray crosses becomes an interval [in, out] of distance along the ray.
  const edges: { t: number; d: number }[] = [];
  for (const s of smokeSources) {
    const ox = s.x - ray.x0;
    const oy = s.y - ray.y0;
    const along = ox * ux + oy * uy;
    const off2 = ox * ox + oy * oy - along * along;
    if (off2 >= s.r * s.r) continue;
    const half = Math.sqrt(s.r * s.r - off2);
    const tIn = Math.max(0, along - half);
    const tOut = along + half;
    if (tOut <= 0 || tIn >= base) continue;
    edges.push({ t: tIn, d: 1 }, { t: tOut, d: -1 });
  }
  if (edges.length === 0) return base;
  edges.sort((a, b) => a.t - b.t);
  let budget = base;
  let t = 0;
  let inside = 0;
  for (const e of edges) {
    const cost = 1 + (SMOKE_COST - 1) * inside;
    const seg = e.t - t;
    if (seg * cost >= budget) return t + budget / cost;
    budget -= seg * cost;
    t = e.t;
    inside += e.d;
  }
  return t + budget;
}

interface Sample {
  x: number;
  y: number;
}

const sampleCache = new WeakMap<HeightFn, Map<string, Sample[]>>();

/** About 9 points a tile is judged by: the centre, the corners (just inside) and the highest posts, spread apart. */
export function tileSamples(tile: TileIndex, heightAt: HeightFn): readonly Sample[] {
  let byTile = sampleCache.get(heightAt);
  if (!byTile) sampleCache.set(heightAt, (byTile = new Map()));
  const key = `${tile.i},${tile.j}`;
  const hit = byTile.get(key);
  if (hit) return hit;
  const x0 = tile.i * TILE_M;
  const y0 = tile.j * TILE_M;
  const out: Sample[] = [
    { x: x0 + TILE_M / 2, y: y0 + TILE_M / 2 },
    { x: x0 + CORNER_INSET_M, y: y0 + CORNER_INSET_M },
    { x: x0 + TILE_M - CORNER_INSET_M, y: y0 + CORNER_INSET_M },
    { x: x0 + CORNER_INSET_M, y: y0 + TILE_M - CORNER_INSET_M },
    { x: x0 + TILE_M - CORNER_INSET_M, y: y0 + TILE_M - CORNER_INSET_M },
  ];
  const posts: { x: number; y: number; h: number }[] = [];
  for (let y = y0 + POST_M / 2; y < y0 + TILE_M; y += POST_M) {
    for (let x = x0 + POST_M / 2; x < x0 + TILE_M; x += POST_M) posts.push({ x, y, h: heightAt(x, y) });
  }
  posts.sort((a, b) => b.h - a.h || a.y - b.y || a.x - b.x);
  const high: Sample[] = [];
  for (const p of posts) {
    if (high.length >= HIGH_POSTS) break;
    if (high.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < HIGH_POST_SEP_M)) continue;
    high.push({ x: p.x, y: p.y });
  }
  out.push(...high);
  byTile.set(key, out);
  return out;
}

/** Drop of the ground below the eye's tangent plane at a distance, metres. */
export const curvatureDrop = (d: number): number => (d * d) / (2 * R_EFF_M);

/** True when nothing on the ground stands between the eye and a point TARGET_LIFT_M above (x, y). */
export function sightClear(eye: Eye, x: number, y: number, heightAt: HeightFn): boolean {
  const dx = x - eye.x;
  const dy = y - eye.y;
  const dist = Math.hypot(dx, dy);
  const tz = heightAt(x, y) + TARGET_LIFT_M - curvatureDrop(dist);
  const n = Math.ceil(dist / STEP_M);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const d = t * dist;
    if (dist - d < FAR_SKIP_M) break;
    const line = eye.z + (tz - eye.z) * t;
    if (heightAt(eye.x + dx * t, eye.y + dy * t) - curvatureDrop(d) > line) return false;
  }
  return true;
}

/**
 * Whether a tile can be seen from the eye: ray-march to each sample point and count those in range and in clear
 * sight; MIN_VISIBLE_SAMPLES or more makes it visible. `range` is a fixed range, or the range towards a point.
 */
export function tileVisible(eye: Eye, tile: TileIndex, heightAt: HeightFn, range: number | ((x: number, y: number) => number)): boolean {
  let seen = 0;
  for (const s of tileSamples(tile, heightAt)) {
    const r = typeof range === 'number' ? range : range(s.x, s.y);
    if (Math.hypot(s.x - eye.x, s.y - eye.y) > r) continue;
    if (!sightClear(eye, s.x, s.y, heightAt)) continue;
    if (++seen >= MIN_VISIBLE_SAMPLES) return true;
  }
  return false;
}
