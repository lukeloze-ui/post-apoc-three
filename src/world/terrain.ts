// Region-level terrain: 50 m height posts and 50 m landcover cells over the 10 km patch.
// Local frame: x metres east, y metres north from the patch's SW corner.
import { ORIGIN_E, ORIGIN_N, PATCH_M, gridRefSX, wgs84ToLocal } from './geo';

export interface TerrainMeta {
  version: number;
  source: string;
  crs: 'EPSG:27700';
  originE: number;
  originN: number;
  cellM: number;
  postsX: number;
  postsY: number;
  heightUnit: 'dm';
}

export const LandCover = {
  MoorGrass: 0,
  Heather: 1,
  Bog: 2,
  Rock: 3,
  Field: 4,
  Wood: 5,
  BuiltUp: 6,
  Water: 7,
  Quarry: 8,
} as const;

export const TILES_PER_SIDE = 10;
export const TILE_M = PATCH_M / TILES_PER_SIDE;

export interface Terrain {
  meta: TerrainMeta;
  /** Metres east/north of the patch extent (cellM * (posts - 1)). */
  sizeX: number;
  sizeY: number;
  /** Height posts in decimetres, row-major, row 0 = south, column 0 = west. */
  heightsDm: Int16Array;
  /** One code per cell ((postsX - 1) x (postsY - 1)), same ordering. */
  landcover: Uint8Array;
}

export type Bytes = ArrayBuffer | ArrayBufferView;

function toU8(b: Bytes): Uint8Array {
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/** Builds a Terrain from parsed metadata and the raw bytes of terrain.bin and landcover.bin. */
export function parseTerrain(meta: TerrainMeta, heightBytes: Bytes, landcoverBytes: Bytes): Terrain {
  if (meta.crs !== 'EPSG:27700') throw new Error(`terrain: unsupported crs ${String(meta.crs)}`);
  if (meta.heightUnit !== 'dm') throw new Error(`terrain: unsupported height unit ${String(meta.heightUnit)}`);
  const hb = toU8(heightBytes);
  const lb = toU8(landcoverBytes);
  const nPosts = meta.postsX * meta.postsY;
  const nCells = (meta.postsX - 1) * (meta.postsY - 1);
  if (hb.byteLength !== nPosts * 2) throw new Error(`terrain.bin: expected ${nPosts * 2} bytes, got ${hb.byteLength}`);
  if (lb.byteLength !== nCells) throw new Error(`landcover.bin: expected ${nCells} bytes, got ${lb.byteLength}`);
  // DataView keeps this independent of host endianness and buffer alignment.
  const dv = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  const heightsDm = new Int16Array(nPosts);
  for (let k = 0; k < nPosts; k++) heightsDm[k] = dv.getInt16(k * 2, true);
  return {
    meta,
    sizeX: meta.cellM * (meta.postsX - 1),
    sizeY: meta.cellM * (meta.postsY - 1),
    heightsDm,
    landcover: Uint8Array.from(lb),
  };
}

export function isSynthetic(meta: TerrainMeta): boolean {
  return meta.source.toUpperCase().startsWith('SYNTHETIC');
}

/** Fetches terrain.json, terrain.bin and landcover.bin from baseUrl (browser). Warns loudly if the data is a stand-in. */
export async function fetchTerrain(baseUrl = '/world/', fetchFn: typeof fetch = fetch): Promise<Terrain> {
  const get = async (name: string): Promise<Response> => {
    const res = await fetchFn(baseUrl + name);
    if (!res.ok) throw new Error(`fetch ${baseUrl + name}: ${res.status}`);
    return res;
  };
  const [meta, heights, landcover] = await Promise.all([
    get('terrain.json').then((r) => r.json() as Promise<TerrainMeta>),
    get('terrain.bin').then((r) => r.arrayBuffer()),
    get('landcover.bin').then((r) => r.arrayBuffer()),
  ]);
  const terrain = parseTerrain(meta, heights, landcover);
  if (isSynthetic(meta)) {
    console.warn(`[world] TERRAIN IS SYNTHETIC: "${meta.source}". This is not real Okehampton ground.`);
  }
  return terrain;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Height in metres at local (x, y), bilinear between the four surrounding posts. Clamped to the patch. */
export function heightAt(t: Terrain, x: number, y: number): number {
  const { cellM, postsX, postsY } = t.meta;
  const fx = clamp(x / cellM, 0, postsX - 1);
  const fy = clamp(y / cellM, 0, postsY - 1);
  const i = Math.min(Math.floor(fx), postsX - 2);
  const j = Math.min(Math.floor(fy), postsY - 2);
  const u = fx - i;
  const v = fy - j;
  const h = t.heightsDm;
  const k = j * postsX + i;
  const h00 = h[k] as number;
  const h10 = h[k + 1] as number;
  const h01 = h[k + postsX] as number;
  const h11 = h[k + postsX + 1] as number;
  return ((h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v) / 10;
}

/** Landcover code of the cell containing local (x, y). Clamped to the patch. */
export function landcoverAt(t: Terrain, x: number, y: number): number {
  const { cellM, postsX, postsY } = t.meta;
  const cx = clamp(Math.floor(x / cellM), 0, postsX - 2);
  const cy = clamp(Math.floor(y / cellM), 0, postsY - 2);
  return t.landcover[cy * (postsX - 1) + cx] as number;
}

export interface TileIndex {
  i: number;
  j: number;
}

/** 1 km tile (i east, j north, each 0..9) containing local (x, y). Clamped to the patch. */
export function tileOf(x: number, y: number): TileIndex {
  return {
    i: clamp(Math.floor(x / TILE_M), 0, TILES_PER_SIDE - 1),
    j: clamp(Math.floor(y / TILE_M), 0, TILES_PER_SIDE - 1),
  };
}

/** OS 4-figure reference of the tile's SW corner, e.g. tileId(0, 0) = 'SX5288'. The whole patch lies in square SX. */
export function tileId(i: number, j: number): string {
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= TILES_PER_SIDE || j >= TILES_PER_SIDE) {
    throw new RangeError(`tile (${i},${j}) outside the patch`);
  }
  const e = Math.floor((ORIGIN_E + i * TILE_M) / 1000) % 100;
  const n = Math.floor((ORIGIN_N + j * TILE_M) / 1000) % 100;
  return `SX${String(e).padStart(2, '0')}${String(n).padStart(2, '0')}`;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Local-metre extent of tile (i, j). */
export function tileBounds(i: number, j: number): Bounds {
  return { x0: i * TILE_M, y0: j * TILE_M, x1: (i + 1) * TILE_M, y1: (j + 1) * TILE_M };
}

/** Yes Tor summit, SX 580 901. */
export const YES_TOR = gridRefSX(580, 901);

/** Old target railway below Rowtor, 50.7024 N 3.9942 W. */
const startPos = wgs84ToLocal(50.7024, -3.9942);

/** Where the player starts: local metres, with yaw in degrees (0 = north, clockwise) facing Yes Tor (south-west). */
export const START = {
  x: startPos.x,
  y: startPos.y,
  yaw: ((Math.atan2(YES_TOR.x - startPos.x, YES_TOR.y - startPos.y) * 180) / Math.PI + 360) % 360,
};
