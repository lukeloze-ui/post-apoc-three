// Ground detail: one sparse object list per 1 km tile, in public/world/ground/<tileId>.json (spec SX 02, the Ground row).
// Stored compactly: coordinates in decimetres from the tile's SW corner, rotation as a byte, kinds by index.
// An object's stable key is `${tileId}:${index}`; saves reference it (see src/save/groundDeltas.ts).
import { ITEMS } from '../sim/items';
import { TILES_PER_SIDE, TILE_M, tileId } from './terrain';

export const GROUND_VERSION = 1;

/**
 * Debris kinds the worldgen ground step writes (spec SX 02, debris near towns and roads). Size is metres: a pile's
 * width, a car's length (centred on x, y), a trunk's length (root at x, y, crown along rot), a barrier segment's
 * length (centred on x, y, along rot), a small crater's diameter, a door's width (on the wall, rot pointing out), and
 * a spot's width (a building's loot spot, centred on the building).
 */
export const DEBRIS_KINDS = ['wall', 'hedgebank', 'rubble', 'car', 'trunk', 'wrack', 'crater', 'door', 'spot'] as const;
export type DebrisKind = (typeof DEBRIS_KINDS)[number];
/** Barrier segments (wall, hedgebank) carry extra: 0 standing, 1 broken. */
export const BARRIER_STANDING = 0;
export const BARRIER_BROKEN = 1;
/** Coordinates and sizes are stored in decimetres. */
const DM = 10;
const TILE_DM = TILE_M * DM;

/** [kindIdx, x_dm, y_dm, rot_byte, size_dm, extra?] */
export type GroundObjectRow = [number, number, number, number, number] | [number, number, number, number, number, number];
/** [itemId, qty, buried (0 or 1)] */
export type GroundItemRow = [string, number, 0 | 1];

export interface GroundLootRow {
  /** Index into `o` of the object holding the loot (a building's spot, a car, a wrack pile). */
  obj: number;
  /** features.json building id, or '' when the loot is not in a building. */
  building: string;
  items: GroundItemRow[];
}

export interface GroundDoorRow {
  /** Index into `o` of the door object. */
  obj: number;
  building: string;
  locked: boolean;
}

/** The file on disk. */
export interface GroundFile {
  v: number;
  tile: string;
  kinds: string[];
  o: GroundObjectRow[];
  loot: GroundLootRow[];
  doors: GroundDoorRow[];
}

export interface GroundObject {
  /** `${tileId}:${index}` for objects from the file. */
  key: string;
  kind: string;
  /** Local patch metres. */
  x: number;
  y: number;
  /** Radians, clockwise from north. */
  rot: number;
  /** Metres. */
  size: number;
  extra?: number;
}

export interface GroundItem {
  itemId: string;
  qty: number;
  buried: boolean;
}

export interface GroundLoot {
  /** Key of the object holding it. */
  obj: string;
  building: string;
  items: GroundItem[];
}

export interface GroundDoor {
  obj: string;
  building: string;
  locked: boolean;
}

/** A decoded tile. `objects[k].key` is `${tile}:${k}`. */
export interface GroundTile {
  tile: string;
  i: number;
  j: number;
  objects: GroundObject[];
  loot: GroundLoot[];
  doors: GroundDoor[];
}

const TILE_INDEX: ReadonlyMap<string, { i: number; j: number }> = (() => {
  const m = new Map<string, { i: number; j: number }>();
  for (let j = 0; j < TILES_PER_SIDE; j++) for (let i = 0; i < TILES_PER_SIDE; i++) m.set(tileId(i, j), { i, j });
  return m;
})();

/** Tile (i, j) for a tile id, or undefined if it is not in the patch. */
export function tileIndexOf(id: string): { i: number; j: number } | undefined {
  return TILE_INDEX.get(id);
}

export const objectKey = (tile: string, index: number): string => `${tile}:${index}`;

export function emptyGroundFile(tile: string): GroundFile {
  return { v: GROUND_VERSION, tile, kinds: [], o: [], loot: [], doors: [] };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Errors in a ground file; empty when it is valid. */
export function validateGround(f: unknown, expectTile?: string): string[] {
  const errs: string[] = [];
  if (!isObj(f)) return ['ground: not an object'];
  if (f.v !== GROUND_VERSION) errs.push(`v: expected ${GROUND_VERSION}, got ${String(f.v)}`);
  if (typeof f.tile !== 'string' || !TILE_INDEX.has(f.tile)) errs.push(`tile: not a patch tile: ${String(f.tile)}`);
  else if (expectTile !== undefined && f.tile !== expectTile) errs.push(`tile: expected ${expectTile}, got ${f.tile}`);

  let nKinds = 0;
  if (!Array.isArray(f.kinds)) errs.push('kinds: not an array');
  else {
    nKinds = f.kinds.length;
    if (f.kinds.some((k) => typeof k !== 'string' || k.length === 0)) errs.push('kinds: bad name');
    if (new Set(f.kinds).size !== f.kinds.length) errs.push('kinds: duplicate');
  }

  let nObj = 0;
  if (!Array.isArray(f.o)) errs.push('o: not an array');
  else {
    nObj = f.o.length;
    f.o.forEach((r: unknown, k) => {
      const at = `o[${k}]`;
      if (!Array.isArray(r) || (r.length !== 5 && r.length !== 6) || !r.every(isInt)) return void errs.push(`${at}: bad row`);
      const [kind, x, y, rot, size] = r as number[];
      if (kind! < 0 || kind! >= nKinds) errs.push(`${at}: kind ${kind} out of range`);
      if (x! < 0 || x! > TILE_DM || y! < 0 || y! > TILE_DM) errs.push(`${at}: outside the tile`);
      if (rot! < 0 || rot! > 255) errs.push(`${at}: rot not a byte`);
      if (size! < 0) errs.push(`${at}: negative size`);
    });
  }

  if (!Array.isArray(f.loot)) errs.push('loot: not an array');
  else {
    f.loot.forEach((l: unknown, k) => {
      const at = `loot[${k}]`;
      if (!isObj(l)) return void errs.push(`${at}: not an object`);
      if (!isInt(l.obj) || l.obj < 0 || l.obj >= nObj) errs.push(`${at}.obj: out of range`);
      if (typeof l.building !== 'string') errs.push(`${at}.building: missing`);
      if (!Array.isArray(l.items)) return void errs.push(`${at}.items: not an array`);
      l.items.forEach((it: unknown, n) => {
        if (!Array.isArray(it) || it.length !== 3) return void errs.push(`${at}.items[${n}]: bad row`);
        const [id, qty, buried] = it as unknown[];
        if (typeof id !== 'string' || !ITEMS[id]) errs.push(`${at}.items[${n}]: unknown item ${String(id)}`);
        if (typeof qty !== 'number' || !(qty > 0)) errs.push(`${at}.items[${n}]: bad qty`);
        if (buried !== 0 && buried !== 1) errs.push(`${at}.items[${n}]: buried not 0 or 1`);
      });
    });
  }

  if (!Array.isArray(f.doors)) errs.push('doors: not an array');
  else {
    f.doors.forEach((d: unknown, k) => {
      const at = `doors[${k}]`;
      if (!isObj(d)) return void errs.push(`${at}: not an object`);
      if (!isInt(d.obj) || d.obj < 0 || d.obj >= nObj) errs.push(`${at}.obj: out of range`);
      if (typeof d.building !== 'string') errs.push(`${at}.building: missing`);
      if (typeof d.locked !== 'boolean') errs.push(`${at}.locked: not a boolean`);
    });
  }
  return errs;
}

const ROT_STEPS = 256;

/** File to tile. Assumes the file is valid. */
export function decodeGround(f: GroundFile): GroundTile {
  const at = tileIndexOf(f.tile);
  if (!at) throw new RangeError(`ground: not a patch tile: ${f.tile}`);
  const x0 = at.i * TILE_M;
  const y0 = at.j * TILE_M;
  const objects = f.o.map((r, k): GroundObject => {
    const o: GroundObject = {
      key: objectKey(f.tile, k),
      kind: f.kinds[r[0]] as string,
      x: x0 + r[1] / DM,
      y: y0 + r[2] / DM,
      rot: (r[3] / ROT_STEPS) * 2 * Math.PI,
      size: r[4] / DM,
    };
    if (r.length === 6) o.extra = r[5];
    return o;
  });
  return {
    tile: f.tile,
    i: at.i,
    j: at.j,
    objects,
    loot: f.loot.map((l) => ({
      obj: objectKey(f.tile, l.obj),
      building: l.building,
      items: l.items.map(([itemId, qty, buried]) => ({ itemId, qty, buried: buried === 1 })),
    })),
    doors: f.doors.map((d) => ({ obj: objectKey(f.tile, d.obj), building: d.building, locked: d.locked })),
  };
}

/** Tile to file, the inverse of decodeGround. Kinds are listed in order of first use. */
export function encodeGround(t: GroundTile): GroundFile {
  const x0 = t.i * TILE_M;
  const y0 = t.j * TILE_M;
  const kinds: string[] = [];
  const kindIdx = new Map<string, number>();
  const index = new Map<string, number>();
  const o = t.objects.map((ob, k): GroundObjectRow => {
    index.set(ob.key, k);
    let ki = kindIdx.get(ob.kind);
    if (ki === undefined) {
      ki = kinds.push(ob.kind) - 1;
      kindIdx.set(ob.kind, ki);
    }
    const turn = ((ob.rot / (2 * Math.PI)) % 1 + 1) % 1;
    const row: GroundObjectRow = [
      ki,
      Math.round((ob.x - x0) * DM),
      Math.round((ob.y - y0) * DM),
      Math.round(turn * ROT_STEPS) % ROT_STEPS,
      Math.round(ob.size * DM),
    ];
    return ob.extra !== undefined ? [...row, ob.extra] : row;
  });
  const idx = (key: string): number => {
    const k = index.get(key);
    if (k === undefined) throw new Error(`ground: ${key} is not an object of ${t.tile}`);
    return k;
  };
  return {
    v: GROUND_VERSION,
    tile: t.tile,
    kinds,
    o,
    loot: t.loot.map((l) => ({
      obj: idx(l.obj),
      building: l.building,
      items: l.items.map((it): GroundItemRow => [it.itemId, it.qty, it.buried ? 1 : 0]),
    })),
    doors: t.doors.map((d) => ({ obj: idx(d.obj), building: d.building, locked: d.locked })),
  };
}

/** Validates then decodes; throws with the first errors. */
export function parseGround(raw: unknown, expectTile?: string): GroundTile {
  const errs = validateGround(raw, expectTile);
  if (errs.length > 0) throw new Error(`ground ${expectTile ?? ''}: ${errs.slice(0, 5).join('; ')}`);
  return decodeGround(raw as GroundFile);
}

/** JSON with one object row per line, so diffs stay readable. */
export function serialiseGround(f: GroundFile): string {
  const lines = Object.entries(f).map(([k, v]) => {
    if (Array.isArray(v) && v.length > 0 && k !== 'kinds') return `  ${JSON.stringify(k)}: [\n${v.map((e) => '    ' + JSON.stringify(e)).join(',\n')}\n  ]`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

export const GROUND_CACHE_TILES = 16;

/**
 * Fetches tiles from public/world/ground/ and keeps the most recently used ones (about 16).
 * In-flight fetches are shared; a failed fetch is dropped so it can be retried.
 */
export class GroundCache {
  private readonly tiles = new Map<string, Promise<GroundTile>>();

  constructor(
    private readonly baseUrl = '/world/ground/',
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    readonly capacity = GROUND_CACHE_TILES,
  ) {}

  get(tile: string): Promise<GroundTile> {
    let p = this.tiles.get(tile);
    if (p) {
      // Re-insert so Map order is least to most recently used.
      this.tiles.delete(tile);
      this.tiles.set(tile, p);
      return p;
    }
    p = this.load(tile);
    this.tiles.set(tile, p);
    p.catch(() => {
      if (this.tiles.get(tile) === p) this.tiles.delete(tile);
    });
    while (this.tiles.size > this.capacity) this.tiles.delete(this.tiles.keys().next().value as string);
    return p;
  }

  has(tile: string): boolean {
    return this.tiles.has(tile);
  }

  /** Cached tile ids, least recently used first. */
  keys(): string[] {
    return [...this.tiles.keys()];
  }

  private async load(tile: string): Promise<GroundTile> {
    if (!tileIndexOf(tile)) throw new RangeError(`ground: not a patch tile: ${tile}`);
    const url = `${this.baseUrl}${tile}.json`;
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    return parseGround(await res.json(), tile);
  }
}
