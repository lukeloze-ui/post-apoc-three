// What the player changed in the ground detail, and only that: items taken, doors forced, carcasses (and other objects) added.
// Whole tiles are never saved; the committed tile files are the base and these deltas sit on top.
import type { GroundObject, GroundTile } from '../world/ground';
import type { SaveGame } from './save';

export const GROUND_SECTION = 'ground';

/** An object the player added (a carcass, say). Its key is `${tile}:+${n}`, so it never clashes with a file index. */
export type AddedObject = Omit<GroundObject, 'key'> & { key?: string };

export interface GroundDeltas {
  /**
   * Taken, by key. `${tile}:${obj}` takes the whole object (it no longer shows);
   * `${tile}:${obj}:${n}` takes that many of loot item n held by the object (summed over all loot rows on it).
   */
  taken: Record<string, number>;
  /** Door object keys that have been forced open. */
  forced: string[];
  /** Added objects by tile id. */
  added: Record<string, GroundObject[]>;
}

export function emptyGroundDeltas(): GroundDeltas {
  return { taken: {}, forced: [], added: {} };
}

/** Takes a whole object (qty undefined) or qty of loot item n on it. */
export function takeFromGround(d: GroundDeltas, objKey: string, item?: { index: number; qty: number }): void {
  const key = item ? `${objKey}:${item.index}` : objKey;
  d.taken[key] = (d.taken[key] ?? 0) + (item ? item.qty : 1);
}

export function forceDoor(d: GroundDeltas, objKey: string): void {
  if (!d.forced.includes(objKey)) d.forced.push(objKey);
}

/** Adds an object to a tile and returns it with its key. */
export function addToGround(d: GroundDeltas, tile: string, obj: AddedObject): GroundObject {
  const list = (d.added[tile] ??= []);
  const added: GroundObject = { ...obj, key: `${tile}:+${list.length}` };
  list.push(added);
  return added;
}

/**
 * The tile as the player now finds it: taken objects hidden, taken loot reduced (empty items dropped),
 * forced doors unlocked, added objects appended. The input tile is not changed.
 */
export function applyDeltas(tile: GroundTile, d: GroundDeltas): GroundTile {
  const objects = tile.objects.filter((o) => !d.taken[o.key]).concat((d.added[tile.tile] ?? []).map((o) => ({ ...o })));
  const shown = new Set(objects.map((o) => o.key));
  const forced = new Set(d.forced);
  // Loot items are numbered per object in file order, so a key stays put when other loot on the tile changes.
  const nextIndex = new Map<string, number>();
  const loot = tile.loot
    .filter((l) => shown.has(l.obj))
    .map((l) => {
      const items = l.items.flatMap((it) => {
        const n = nextIndex.get(l.obj) ?? 0;
        nextIndex.set(l.obj, n + 1);
        const left = it.qty - (d.taken[`${l.obj}:${n}`] ?? 0);
        return left > 0 ? [{ ...it, qty: left }] : [];
      });
      return { ...l, items };
    })
    .filter((l) => l.items.length > 0);
  const doors = tile.doors
    .filter((dr) => shown.has(dr.obj))
    .map((dr) => ({ ...dr, locked: dr.locked && !forced.has(dr.obj) }));
  return { ...tile, objects, loot, doors };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseObject(v: unknown): GroundObject | undefined {
  const o = v as Partial<GroundObject> | null;
  if (!o || typeof o.key !== 'string' || typeof o.kind !== 'string') return undefined;
  if (!isNum(o.x) || !isNum(o.y) || !isNum(o.rot) || !isNum(o.size)) return undefined;
  const out: GroundObject = { key: o.key, kind: o.kind, x: o.x, y: o.y, rot: o.rot, size: o.size };
  if (isNum(o.extra)) out.extra = o.extra;
  return out;
}

/** Saved deltas, keeping only well-formed entries. */
export function parseGroundDeltas(data: unknown): GroundDeltas {
  const out = emptyGroundDeltas();
  const d = data as Partial<Record<keyof GroundDeltas, unknown>> | null;
  if (!d || typeof d !== 'object') return out;
  if (d.taken && typeof d.taken === 'object') {
    for (const [k, v] of Object.entries(d.taken)) if (isNum(v) && v > 0) out.taken[k] = v;
  }
  if (Array.isArray(d.forced)) out.forced = d.forced.filter((k): k is string => typeof k === 'string');
  if (d.added && typeof d.added === 'object') {
    for (const [tile, list] of Object.entries(d.added)) {
      if (!Array.isArray(list)) continue;
      const objs = list.map(parseObject).filter((o): o is GroundObject => o !== undefined);
      if (objs.length > 0) out.added[tile] = objs;
    }
  }
  return out;
}

/** Registers the 'ground' save section. The deltas object is loaded in place. */
export function registerGroundSection(save: SaveGame, deltas: GroundDeltas): void {
  save.registerSection(
    GROUND_SECTION,
    () => ({ taken: { ...deltas.taken }, forced: [...deltas.forced], added: structuredClone(deltas.added) }),
    (data) => {
      const p = parseGroundDeltas(data);
      deltas.taken = p.taken;
      deltas.forced = p.forced;
      deltas.added = p.added;
    },
  );
}
