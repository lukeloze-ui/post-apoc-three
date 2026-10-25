// Imports OS Terrain 50 (ESRI ASCII grid) and writes terrain.json and terrain.bin for the patch.
// Raw downloads are untrusted: they live in their own folder, are extracted with tar and the .asc is only parsed as text.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { ORIGIN_E, ORIGIN_N } from '../../../src/world/geo';
import type { TerrainMeta } from '../../../src/world/terrain';
import type { Step } from '../steps';
import { WORLD_DIR } from '../synthetic';

const LISTING_URL = 'https://api.os.uk/downloads/v1/products/Terrain50/downloads';
const PRODUCT_FORMAT = 'ASCII Grid and GML (Grid)';
const RAW_DIR = join(import.meta.dirname, '..', 'raw', 'terrain50');
const ZIP_PATH = join(RAW_DIR, 'terr50_gagg_gb.zip');
const CELL = 50;
const POSTS = 201;
const SQUARE_M = 10000;
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

export interface AscGrid {
  ncols: number;
  nrows: number;
  /** Easting/northing of the first sample (the cell centre, whatever the header said). */
  e0: number;
  n0: number;
  cellsize: number;
  nodata: number;
  /** Row-major, row 0 = south (the file lists north first; flipped on parse). */
  values: Float32Array;
}

/** Parses an ESRI ASCII grid. Handles xllcorner (cell corner, so samples sit half a cell in) and xllcenter. */
export function parseAsc(text: string): AscGrid {
  const lines = text.split(/\r?\n/);
  const hdr = new Map<string, number>();
  let k = 0;
  for (; k < lines.length; k++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[k] as string);
    if (!m) break;
    hdr.set((m[1] as string).toLowerCase(), Number(m[2]));
  }
  const need = (key: string): number => {
    const v = hdr.get(key);
    if (v === undefined || !Number.isFinite(v)) throw new Error(`asc: missing header ${key}`);
    return v;
  };
  const ncols = need('ncols');
  const nrows = need('nrows');
  const cellsize = need('cellsize');
  const nodata = hdr.get('nodata_value') ?? -9999;
  const corner = hdr.has('xllcorner');
  const xll = corner ? need('xllcorner') : need('xllcenter');
  const yll = corner ? need('yllcorner') : need('yllcenter');
  const values = new Float32Array(ncols * nrows);
  let row = 0;
  for (; k < lines.length && row < nrows; k++) {
    const line = (lines[k] as string).trim();
    if (!line) continue;
    const cells = line.split(/\s+/);
    if (cells.length !== ncols) throw new Error(`asc: row ${row} has ${cells.length} values, expected ${ncols}`);
    const dst = (nrows - 1 - row) * ncols;
    for (let c = 0; c < ncols; c++) values[dst + c] = Number(cells[c]);
    row++;
  }
  if (row !== nrows) throw new Error(`asc: expected ${nrows} rows, got ${row}`);
  const half = corner ? cellsize / 2 : 0;
  return { ncols, nrows, e0: xll + half, n0: yll + half, cellsize, nodata, values };
}

/** Bilinear sampler over several grids of one cell size. Throws on missing tiles or nodata. */
export function makeSampler(grids: readonly AscGrid[]): (e: number, n: number) => number {
  const cell = (e: number, n: number): number => {
    for (const g of grids) {
      const c = Math.round((e - g.e0) / g.cellsize);
      const r = Math.round((n - g.n0) / g.cellsize);
      if (c >= 0 && c < g.ncols && r >= 0 && r < g.nrows) {
        const v = g.values[r * g.ncols + c] as number;
        if (v === g.nodata) throw new Error(`terrain50: nodata at ${e}, ${n}`);
        return v;
      }
    }
    throw new Error(`terrain50: no grid covers ${e}, ${n}`);
  };
  const g0 = grids[0] as AscGrid;
  return (e, n) => {
    const fc = (e - g0.e0) / g0.cellsize;
    const fr = (n - g0.n0) / g0.cellsize;
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const u = fc - c;
    const v = fr - r;
    const at = (dc: number, dr: number): number => cell(g0.e0 + (c + dc) * g0.cellsize, g0.n0 + (r + dr) * g0.cellsize);
    // Skip neighbours with zero weight so exact-on-sample posts do not need the next tile.
    const h00 = at(0, 0);
    const h10 = u > 0 ? at(1, 0) : h00;
    const h01 = v > 0 ? at(0, 1) : h00;
    const h11 = u > 0 && v > 0 ? at(1, 1) : u > 0 ? h10 : v > 0 ? h01 : h00;
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  };
}

/** Resamples onto the patch's posts and packs Int16 little-endian decimetres, row 0 = south. */
export function buildHeightBytes(sample: (e: number, n: number) => number): Buffer {
  const out = Buffer.alloc(POSTS * POSTS * 2);
  for (let j = 0; j < POSTS; j++) {
    for (let i = 0; i < POSTS; i++) {
      const dm = Math.round(sample(ORIGIN_E + i * CELL, ORIGIN_N + j * CELL) * 10);
      if (dm < -32768 || dm > 32767) throw new Error(`terrain50: height ${dm} dm out of Int16 range`);
      out.writeInt16LE(dm, (j * POSTS + i) * 2);
    }
  }
  return out;
}

async function download(): Promise<void> {
  console.log(`[terrain50] fetching download list ${LISTING_URL}`);
  const list = (await (await fetch(LISTING_URL)).json()) as { md5: string; url: string; format: string; area: string }[];
  const entry = list.find((d) => d.format === PRODUCT_FORMAT && d.area === 'GB');
  if (!entry) throw new Error(`terrain50: no "${PRODUCT_FORMAT}" GB download in the listing`);
  mkdirSync(RAW_DIR, { recursive: true });
  console.log(`[terrain50] downloading ${entry.url}`);
  const res = await fetch(entry.url);
  if (!res.ok || !res.body) throw new Error(`terrain50: download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(ZIP_PATH));
  const hash = createHash('md5');
  await pipeline(createReadStream(ZIP_PATH), hash);
  if (hash.digest('hex') !== entry.md5) throw new Error('terrain50: md5 of the download does not match the listing');
}

function untar(archive: string, dest: string, patterns: string[] = []): void {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync(TAR, ['-xf', archive, '-C', dest, ...patterns], { stdio: 'inherit', cwd: dest });
  if (r.status !== 0) throw new Error(`terrain50: tar failed extracting ${archive}`);
}

/** 10 km squares (lowercase OS names like 'sx58') overlapping the patch plus a one-cell margin. */
export function neededSquares(): string[] {
  const out: string[] = [];
  const e0 = Math.floor((ORIGIN_E - CELL) / SQUARE_M);
  const e1 = Math.floor((ORIGIN_E + (POSTS - 1) * CELL + CELL) / SQUARE_M);
  const n0 = Math.floor((ORIGIN_N - CELL) / SQUARE_M);
  const n1 = Math.floor((ORIGIN_N + (POSTS - 1) * CELL + CELL) / SQUARE_M);
  for (let e = e0; e <= e1; e++) {
    for (let n = n0; n <= n1; n++) {
      // 100 km square SX is (2, 0): easting 200-300 km, northing 0-100 km. Every patch square lies in it.
      if (e < 20 || e > 29 || n < 0 || n > 9) throw new Error(`terrain50: square ${e},${n} is outside SX`);
      out.push(`sx${e - 20}${n}`);
    }
  }
  return out;
}

function findFiles(dir: string, re: RegExp): string[] {
  const found: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) found.push(...findFiles(p, re));
    else if (re.test(ent.name)) found.push(p);
  }
  return found.sort();
}

async function run(): Promise<void> {
  if (!existsSync(ZIP_PATH)) await download();
  const squares = neededSquares();
  const outer = join(RAW_DIR, 'gb');
  const inner = join(RAW_DIR, 'squares');
  if (!existsSync(outer)) untar(ZIP_PATH, outer, squares.map((s) => `data/${s.slice(0, 2)}/${s}_*`));
  const grids: AscGrid[] = [];
  let release = '';
  for (const sq of squares) {
    const zips = findFiles(outer, new RegExp(`^${sq}_OST50GRID_(\\d{8})\\.zip$`, 'i'));
    if (zips.length !== 1) throw new Error(`terrain50: expected one zip for ${sq}, found ${zips.length}`);
    const zip = zips[0] as string;
    const date = /_(\d{8})\.zip$/i.exec(zip)?.[1] as string;
    if (release && release !== date) console.warn(`[terrain50] ${sq} release ${date} differs from ${release}`);
    release = release > date ? release : date;
    const dest = join(inner, sq);
    if (!existsSync(dest)) untar(zip, dest);
    const asc = findFiles(dest, new RegExp(`^${sq}\\.asc$`, 'i'));
    if (asc.length !== 1) throw new Error(`terrain50: no ${sq}.asc in ${zip}`);
    grids.push(parseAsc(readFileSync(asc[0] as string, 'utf8')));
  }
  const cs = grids[0]?.cellsize;
  if (grids.some((g) => g.cellsize !== CELL || g.cellsize !== cs)) throw new Error('terrain50: unexpected cell size');
  // Mosaic: stitch the squares into one grid so the sampler needs only one origin.
  const e0 = Math.min(...grids.map((g) => g.e0));
  const n0 = Math.min(...grids.map((g) => g.n0));
  const ncols = Math.round((Math.max(...grids.map((g) => g.e0 + g.ncols * CELL)) - e0) / CELL);
  const nrows = Math.round((Math.max(...grids.map((g) => g.n0 + g.nrows * CELL)) - n0) / CELL);
  const values = new Float32Array(ncols * nrows).fill(-9999);
  for (const g of grids) {
    const c0 = Math.round((g.e0 - e0) / CELL);
    const r0 = Math.round((g.n0 - n0) / CELL);
    for (let r = 0; r < g.nrows; r++) {
      for (let c = 0; c < g.ncols; c++) values[(r0 + r) * ncols + c0 + c] = g.values[r * g.ncols + c] as number;
    }
  }
  const sample = makeSampler([{ ncols, nrows, e0, n0, cellsize: CELL, nodata: -9999, values }]);
  const heights = buildHeightBytes(sample);
  const year = release.slice(0, 4) || String(new Date().getFullYear());
  const iso = release ? `${release.slice(0, 4)}-${release.slice(4, 6)}-${release.slice(6, 8)}` : 'unknown release';
  const meta: TerrainMeta & { attribution: string } = {
    version: 1,
    source: `OS Terrain 50 (${iso})`,
    attribution: `Contains OS data (c) Crown copyright and database right ${year}`,
    crs: 'EPSG:27700',
    originE: ORIGIN_E,
    originN: ORIGIN_N,
    cellM: CELL,
    postsX: POSTS,
    postsY: POSTS,
    heightUnit: 'dm',
  };
  mkdirSync(WORLD_DIR, { recursive: true });
  writeFileSync(join(WORLD_DIR, 'terrain.json'), JSON.stringify(meta, null, 2) + '\n');
  writeFileSync(join(WORLD_DIR, 'terrain.bin'), heights);
  console.log(`[terrain50] wrote ${meta.source}, ${POSTS}x${POSTS} posts`);
}

/** Replaces the synthetic heights with real ones. If the data cannot be had, the synthetic stand-in stays and this warns. */
export const terrain50Step: Step = {
  name: 'OS Terrain 50 heights',
  async run() {
    try {
      await run();
    } catch (err) {
      console.warn(`[worldgen:import] WARNING: OS Terrain 50 import failed, keeping SYNTHETIC heights: ${String(err)}`);
    }
  },
};
