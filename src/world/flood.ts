// The tsunami high-water mark: one value per 1 km tile, and the band each 50 m cell falls in.
// Local frame as in terrain.ts: x metres east, y metres north from the patch's SW corner.
import { ORIGIN_E, ORIGIN_N } from './geo';
import { TILES_PER_SIDE, TILE_M, heightAt, tileId, type Bytes, type Terrain } from './terrain';

export const Band = {
  Above: 0,
  Strandline: 1,
  Scour: 2,
  /** Reserved for trapped lakes. */
  UnderWater: 3,
} as const;

export type BandCode = (typeof Band)[keyof typeof Band];

/** Names and colours shared by the debug view and the renderer. Indexed by band code. */
export const BAND_INFO: readonly { code: BandCode; name: string; color: string }[] = [
  { code: Band.Above, name: 'Above the mark', color: '#4f8a3a' },
  { code: Band.Strandline, name: 'Strandline', color: '#d9b84a' },
  { code: Band.Scour, name: 'Scour zone', color: '#8c4a2f' },
  { code: Band.UnderWater, name: 'Under water', color: '#2f6fb0' },
];

/** Depth of the strandline band below the mark, metres. */
export const STRANDLINE_M = 20;

/** High Willhays and Priddy, OSGB metres: the ends of the line the mark falls along. */
export const LINE_START = { e: 258000, n: 89200 };
export const LINE_END = { e: 352700, n: 150900 };
export const HW_START_M = 430;
export const HW_DROP_M = 150;

export interface FloodTile {
  id: string;
  i: number;
  j: number;
  hw: number;
}

export interface FloodMeta {
  version: number;
  method: string;
  tiles: FloodTile[];
}

export interface Sinusoid {
  amp: number;
  /** Cycles across the patch. */
  kx: number;
  ky: number;
  phase: number;
}

export interface Flood {
  meta: FloodMeta;
  /** Mark per tile, row-major (j * 10 + i). */
  hw: Float64Array;
  /** One band code per 50 m cell, row-major, row 0 = south. */
  bands: Uint8Array;
}

/** Smooth fall of the mark along the High Willhays -> Priddy line, metres, for OSGB (e, n). */
export function hwBase(e: number, n: number): number {
  const dx = LINE_END.e - LINE_START.e;
  const dy = LINE_END.n - LINE_START.n;
  const t = ((e - LINE_START.e) * dx + (n - LINE_START.n) * dy) / (dx * dx + dy * dy);
  return HW_START_M - HW_DROP_M * Math.min(1, Math.max(0, t));
}

/** Mark for tile (i, j): the line value at the tile centre plus the low-frequency field. */
export function hwForTile(i: number, j: number, field: readonly Sinusoid[]): number {
  const u = (i + 0.5) / TILES_PER_SIDE;
  const v = (j + 0.5) / TILES_PER_SIDE;
  let hw = hwBase(ORIGIN_E + (i + 0.5) * TILE_M, ORIGIN_N + (j + 0.5) * TILE_M);
  for (const s of field) hw += s.amp * Math.sin(2 * Math.PI * (s.kx * u + s.ky * v) + s.phase);
  return hw;
}

/** Mark at local (x, y), bilinear between tile centres (clamped beyond the outermost centres). */
export function hwAt(hw: ArrayLike<number>, x: number, y: number): number {
  const last = TILES_PER_SIDE - 1;
  const fx = Math.min(last, Math.max(0, x / TILE_M - 0.5));
  const fy = Math.min(last, Math.max(0, y / TILE_M - 0.5));
  const i = Math.min(Math.floor(fx), last - 1);
  const j = Math.min(Math.floor(fy), last - 1);
  const u = fx - i;
  const v = fy - j;
  const k = j * TILES_PER_SIDE + i;
  const a = hw[k] as number;
  const b = hw[k + 1] as number;
  const c = hw[k + TILES_PER_SIDE] as number;
  const d = hw[k + TILES_PER_SIDE + 1] as number;
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Band for ground height h (m) against mark hw (m). Under water (3) is not decided here. */
export function bandFor(h: number, hw: number): BandCode {
  if (h > hw) return Band.Above;
  if (h > hw - STRANDLINE_M) return Band.Strandline;
  return Band.Scour;
}

/** Classifies every cell of the terrain (height at the cell centre) against the interpolated mark. */
export function classifyCells(terrain: Terrain, hw: ArrayLike<number>): Uint8Array {
  const { cellM, postsX, postsY } = terrain.meta;
  const nx = postsX - 1;
  const ny = postsY - 1;
  const out = new Uint8Array(nx * ny);
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      const x = (cx + 0.5) * cellM;
      const y = (cy + 0.5) * cellM;
      out[cy * nx + cx] = bandFor(heightAt(terrain, x, y), hwAt(hw, x, y));
    }
  }
  return out;
}

/** Builds a Flood from parsed flood.json and the raw bytes of bands.bin. */
export function parseFlood(meta: FloodMeta, bandBytes: Bytes, terrain?: Terrain): Flood {
  const n = TILES_PER_SIDE * TILES_PER_SIDE;
  if (meta.tiles.length !== n) throw new Error(`flood.json: expected ${n} tiles, got ${meta.tiles.length}`);
  const hw = new Float64Array(n);
  for (const t of meta.tiles) {
    if (t.id !== tileId(t.i, t.j)) throw new Error(`flood.json: tile ${t.id} does not match (${t.i},${t.j})`);
    hw[t.j * TILES_PER_SIDE + t.i] = t.hw;
  }
  const bb =
    bandBytes instanceof ArrayBuffer
      ? new Uint8Array(bandBytes)
      : new Uint8Array(bandBytes.buffer, bandBytes.byteOffset, bandBytes.byteLength);
  if (terrain) {
    const cells = (terrain.meta.postsX - 1) * (terrain.meta.postsY - 1);
    if (bb.byteLength !== cells) throw new Error(`bands.bin: expected ${cells} bytes, got ${bb.byteLength}`);
  }
  return { meta, hw, bands: Uint8Array.from(bb) };
}

/** Fetches flood.json and bands.bin (browser). */
export async function fetchFlood(
  baseUrl = '/world/',
  terrain?: Terrain,
  fetchFn: typeof fetch = fetch,
): Promise<Flood> {
  const get = async (name: string): Promise<Response> => {
    const res = await fetchFn(baseUrl + name);
    if (!res.ok) throw new Error(`fetch ${baseUrl + name}: ${res.status}`);
    return res;
  };
  const [meta, bands] = await Promise.all([
    get('flood.json').then((r) => r.json() as Promise<FloodMeta>),
    get('bands.bin').then((r) => r.arrayBuffer()),
  ]);
  return parseFlood(meta, bands, terrain);
}

/** Band of the cell containing local (x, y). Clamped to the patch. */
export function bandAt(f: Flood, cellM: number, cellsPerSide: number, x: number, y: number): BandCode {
  const cx = Math.min(cellsPerSide - 1, Math.max(0, Math.floor(x / cellM)));
  const cy = Math.min(cellsPerSide - 1, Math.max(0, Math.floor(y / cellM)));
  return f.bands[cy * cellsPerSide + cx] as BandCode;
}
