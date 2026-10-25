// Trapped lakes: the hollows found by fill.ts, their level over time, and whether a point is under water.
// Local frame as in terrain.ts: x metres east, y metres north from the patch's SW corner.
import { Band, type BandCode } from './flood';
import { heightAt, type Bytes, type Terrain } from './terrain';

/** Draining runs to the end of day 5; game days count from 0 at d1-00:00, so day 5 ends at gameDay 5. */
export const DRAIN_END_DAY = 5;
/** Trapped salt lakes fall this far per game day once draining is over, metres. */
export const FALL_RATE_M_PER_DAY = 0.03;

export interface Lake {
  /** 1-based; the value in lakeid.bin. */
  id: number;
  spill: number;
  area: number;
  volume: number;
  maxDepth: number;
  floor: number;
  x: number;
  y: number;
  salt: boolean;
}

export interface LakesMeta {
  version: number;
  method: string;
  cellM: number;
  postsX: number;
  postsY: number;
  lakes: Lake[];
}

export interface Lakes {
  meta: LakesMeta;
  /** Lake id per height post (not per cell), row-major, row 0 = south; 0 = none. */
  ids: Uint16Array;
}

/** Builds Lakes from parsed lakes.json and the raw bytes of lakeid.bin (Uint16 little-endian per post). */
export function parseLakes(meta: LakesMeta, idBytes: Bytes, terrain?: Terrain): Lakes {
  const bytes =
    idBytes instanceof ArrayBuffer
      ? new Uint8Array(idBytes)
      : new Uint8Array(idBytes.buffer, idBytes.byteOffset, idBytes.byteLength);
  const posts = meta.postsX * meta.postsY;
  if (bytes.byteLength !== posts * 2) throw new Error(`lakeid.bin: expected ${posts * 2} bytes, got ${bytes.byteLength}`);
  if (terrain && (terrain.meta.postsX !== meta.postsX || terrain.meta.postsY !== meta.postsY)) {
    throw new Error('lakes.json: post grid does not match the terrain');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids = new Uint16Array(posts);
  for (let k = 0; k < posts; k++) ids[k] = dv.getUint16(k * 2, true);
  meta.lakes.forEach((l, i) => {
    if (l.id !== i + 1) throw new Error(`lakes.json: lake ${l.id} out of order at index ${i}`);
  });
  return { meta, ids };
}

/** Fetches lakes.json and lakeid.bin (browser). */
export async function fetchLakes(
  baseUrl = '/world/',
  terrain?: Terrain,
  fetchFn: typeof fetch = fetch,
): Promise<Lakes> {
  const get = async (name: string): Promise<Response> => {
    const res = await fetchFn(baseUrl + name);
    if (!res.ok) throw new Error(`fetch ${baseUrl + name}: ${res.status}`);
    return res;
  };
  const [meta, ids] = await Promise.all([
    get('lakes.json').then((r) => r.json() as Promise<LakesMeta>),
    get('lakeid.bin').then((r) => r.arrayBuffer()),
  ]);
  return parseLakes(meta, ids, terrain);
}

/** Surface level of a lake on gameDay (days since d1-00:00), metres. Fresh lakes never fall; salt lakes stop at their floor. */
export function lakeLevelAt(lake: Lake, gameDay: number): number {
  if (!lake.salt) return lake.spill;
  const fallen = Math.max(0, gameDay - DRAIN_END_DAY) * FALL_RATE_M_PER_DAY;
  return Math.max(lake.floor, lake.spill - fallen);
}

/** Lake owning the posts around local (x, y): the nearest corner post of the surrounding square that has one. */
export function lakeAt(lakes: Lakes, x: number, y: number): Lake | undefined {
  const { cellM, postsX, postsY } = lakes.meta;
  const fx = Math.min(postsX - 1, Math.max(0, x / cellM));
  const fy = Math.min(postsY - 1, Math.max(0, y / cellM));
  const i = Math.min(Math.floor(fx), postsX - 2);
  const j = Math.min(Math.floor(fy), postsY - 2);
  const u = fx - i;
  const v = fy - j;
  let best = 0;
  let bestD = Infinity;
  for (let dj = 0; dj < 2; dj++) {
    for (let di = 0; di < 2; di++) {
      const id = lakes.ids[(j + dj) * postsX + i + di] as number;
      if (id === 0) continue;
      const d = (u - di) ** 2 + (v - dj) ** 2;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
  }
  return best === 0 ? undefined : lakes.meta.lakes[best - 1];
}

/** True when a lake stands above the ground at local (x, y) on gameDay. */
export function isUnderWater(lakes: Lakes, terrain: Terrain, x: number, y: number, gameDay: number): boolean {
  const lake = lakeAt(lakes, x, y);
  return lake !== undefined && lakeLevelAt(lake, gameDay) > heightAt(terrain, x, y);
}

/** Band at (x, y): UnderWater (3) where a lake covers the ground, else the given base band. */
export function bandWithLakes(
  lakes: Lakes,
  terrain: Terrain,
  base: BandCode,
  x: number,
  y: number,
  gameDay: number,
): BandCode {
  return isUnderWater(lakes, terrain, x, y, gameDay) ? Band.UnderWater : base;
}
