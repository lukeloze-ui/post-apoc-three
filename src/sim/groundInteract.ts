// Looking at, searching, digging and forcing things in the ground detail. Pure: no three, no DOM.
// The base tiles are never changed; every taking and forcing is recorded in the GroundDeltas (src/save/groundDeltas.ts).
import { forceDoor, takeFromGround, type GroundDeltas } from '../save/groundDeltas';
import type { GroundObject, GroundTile } from '../world/ground';
import { getItem } from './items';
import { loadShare, type Party } from './load';
import { addItem, carriedKg } from './pack';
import type { WalkState } from './walking';

/** How far, metres, from an object's edge (a door, the middle of a small thing) the player can reach it. */
export const REACH_M = 3;
/** Half the width of the view cone, degrees, in which an object counts as looked at. */
export const CONE_HALF_DEG = 40;
/** Large objects (a house) are reached from their edge, but only this much of their half-width counts. */
const MAX_EDGE_M = 10;

/** Game minutes. */
export const SEARCH_HOUSE_MIN = 10;
export const SEARCH_OTHER_MIN = 3;
export const FORCE_MIN = 5;
export const DIG_MIN = 30;
/** Forcing a door with no hatchet or crowbar takes this many times the time and effort. */
export const BARE_HANDS_FACTOR = 3;

/** Stamina (0..1) the person doing it loses: per minute of searching, and per forced door or dig. */
export const SEARCH_STAMINA_PER_MIN = 0.001;
export const FORCE_STAMINA = 0.06;
export const DIG_STAMINA = 0.12;

export type ActionKind = 'search' | 'dig' | 'force';

export interface Target {
  kind: ActionKind;
  /** The object looked at: the door, or what holds the loot. */
  obj: GroundObject;
  /** The base tile it is on. */
  tile: GroundTile;
  /** Metres from the player to the object's edge. */
  dist: number;
  /** Game minutes it will take. */
  minutes: number;
  /** Set when the player cannot do it yet (no spade). */
  blocked?: string;
}

export interface Found {
  itemId: string;
  qty: number;
  /** Id of the person who now carries it. */
  carrier: string;
}

export interface Outcome {
  /** Game minutes that passed. */
  minutes: number;
  found: Found[];
  /** What the HUD shows. */
  lines: string[];
}

interface Held {
  index: number;
  itemId: string;
  left: number;
  buried: boolean;
}

const OBJECT_NAME: Record<string, string> = {
  spot: 'house',
  car: 'car',
  wrack: 'wrack pile',
  rubble: 'rubble',
  trunk: 'fallen tree',
  door: 'door',
};

export const objectName = (kind: string): string => OBJECT_NAME[kind] ?? kind;

const byKeyCache = new WeakMap<GroundTile, Map<string, GroundObject>>();
function objectByKey(tile: GroundTile, key: string): GroundObject | undefined {
  let m = byKeyCache.get(tile);
  if (!m) {
    m = new Map(tile.objects.map((o) => [o.key, o]));
    byKeyCache.set(tile, m);
  }
  return m.get(key);
}

/**
 * The loot items an object holds, numbered per object in file order (the numbering the deltas use), with how many
 * are left. `tile` is the base tile, not the one with deltas applied.
 */
export function heldItems(tile: GroundTile, d: GroundDeltas, objKey: string): Held[] {
  const out: Held[] = [];
  for (const row of tile.loot) {
    if (row.obj !== objKey) continue;
    for (const it of row.items) {
      const index = out.length;
      out.push({ index, itemId: it.itemId, left: it.qty - (d.taken[`${objKey}:${index}`] ?? 0), buried: it.buried });
    }
  }
  return out;
}

const hasItem = (party: Party, itemId: string): boolean => party.pack.some((e) => e.itemId === itemId && e.qty > 0);
const hasForcingTool = (party: Party): boolean => hasItem(party, 'crowbar') || hasItem(party, 'hatchet');

/** True while some door of the building is still locked, so its loot cannot be reached. */
function buildingLocked(tiles: readonly GroundTile[], d: GroundDeltas, building: string): boolean {
  if (building === '') return false;
  const forced = new Set(d.forced);
  return tiles.some((t) => t.doors.some((dr) => dr.building === building && dr.locked && !forced.has(dr.obj)));
}

function edgeDistance(o: GroundObject, x: number, y: number): number {
  return Math.max(0, Math.hypot(o.x - x, o.y - y) - Math.min(o.size / 2, MAX_EDGE_M));
}

/** True when the object is straight enough ahead (yaw degrees, 0 north, clockwise). Right at its edge, any way will do. */
function inCone(o: GroundObject, x: number, y: number, yaw: number, edge: number): boolean {
  if (edge < 1) return true;
  const a = (yaw * Math.PI) / 180;
  const dx = o.x - x;
  const dy = o.y - y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const cos = (dx * Math.sin(a) + dy * Math.cos(a)) / len;
  return cos >= Math.cos((CONE_HALF_DEG * Math.PI) / 180);
}

function searchMinutes(o: GroundObject): number {
  return o.kind === 'spot' ? SEARCH_HOUSE_MIN : SEARCH_OTHER_MIN;
}

/**
 * The nearest lootable object or locked door within reach and ahead of the player, or undefined.
 * `tiles` are the loaded base tiles; what has been taken or forced comes from `d`.
 */
export function findTarget(
  tiles: readonly GroundTile[],
  d: GroundDeltas,
  party: Party,
  x: number,
  y: number,
  yaw: number,
): Target | undefined {
  let best: Target | undefined;
  const consider = (t: Target): void => {
    if (!best || t.dist < best.dist) best = t;
  };
  const forced = new Set(d.forced);
  for (const tile of tiles) {
    for (const door of tile.doors) {
      if (!door.locked || forced.has(door.obj)) continue;
      const o = objectByKey(tile, door.obj);
      if (!o || d.taken[o.key]) continue;
      const dist = edgeDistance(o, x, y);
      if (dist > REACH_M || !inCone(o, x, y, yaw, dist)) continue;
      const bare = !hasForcingTool(party);
      consider({ kind: 'force', obj: o, tile, dist, minutes: FORCE_MIN * (bare ? BARE_HANDS_FACTOR : 1) });
    }
    const seen = new Set<string>();
    for (const row of tile.loot) {
      if (seen.has(row.obj)) continue;
      seen.add(row.obj);
      const o = objectByKey(tile, row.obj);
      if (!o || d.taken[o.key]) continue;
      const dist = edgeDistance(o, x, y);
      if (dist > REACH_M || !inCone(o, x, y, yaw, dist)) continue;
      if (buildingLocked(tiles, d, row.building)) continue;
      const held = heldItems(tile, d, o.key).filter((h) => h.left > 0);
      if (held.some((h) => !h.buried)) consider({ kind: 'search', obj: o, tile, dist, minutes: searchMinutes(o) });
      else if (held.length > 0) {
        consider({
          kind: 'dig',
          obj: o,
          tile,
          dist,
          minutes: DIG_MIN,
          blocked: hasItem(party, 'spade') ? undefined : 'needs a spade',
        });
      }
    }
  }
  return best;
}

/** The HUD prompt for a target. */
export function promptText(t: Target): string {
  const name = objectName(t.obj.kind);
  const verb = t.kind === 'force' ? 'force' : t.kind === 'dig' ? 'dig out' : 'search';
  const cost = `${t.minutes} min`;
  return t.blocked ? `${verb} the ${name}: ${t.blocked}` : `E  ${verb} the ${name} (${cost})`;
}

/** Puts one item on the carrier with the lighter load (share of body weight), one unit at a time so a big find is split. */
function carryItem(party: Party, itemId: string, qty: number): Found[] {
  const counts = new Map<string, number>();
  for (let u = 0; u < qty; u++) {
    let pick = party.people[0]!;
    let low = Infinity;
    for (const p of party.people) {
      const share = loadShare(carriedKg(party.pack, p.id), p.bodyKg);
      if (share < low) {
        low = share;
        pick = p;
      }
    }
    addItem(party.pack, itemId, 1, pick.id);
    counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1);
  }
  return [...counts].map(([carrier, n]) => ({ itemId, qty: n, carrier }));
}

function spend(walk: WalkState, party: Party, amount: number): void {
  const who = party.people[0];
  if (who) walk.stamina[who.id] = Math.max(0, (walk.stamina[who.id] ?? 1) - amount);
}

const itemLine = (f: Found, party: Party): string =>
  `${f.qty} x ${getItem(f.itemId).name} (${party.people.find((p) => p.id === f.carrier)?.name ?? f.carrier})`;

/**
 * Does the action: records it in the deltas, moves what is found into the pack and spends stamina.
 * The caller advances the clock by `minutes` and reloads the tile it changed.
 */
export function perform(t: Target, d: GroundDeltas, party: Party, walk: WalkState): Outcome {
  const name = objectName(t.obj.kind);
  if (t.blocked) return { minutes: 0, found: [], lines: [`You can't: ${t.blocked}.`] };

  if (t.kind === 'force') {
    const bare = !hasForcingTool(party);
    forceDoor(d, t.obj.key);
    spend(walk, party, FORCE_STAMINA * (bare ? BARE_HANDS_FACTOR : 1));
    return { minutes: t.minutes, found: [], lines: [bare ? 'You break the door in with your shoulder.' : 'You force the door open.'] };
  }

  const digging = t.kind === 'dig';
  const found: Found[] = [];
  for (const h of heldItems(t.tile, d, t.obj.key)) {
    if (h.left <= 0 || h.buried !== digging) continue;
    takeFromGround(d, t.obj.key, { index: h.index, qty: h.left });
    found.push(...carryItem(party, h.itemId, h.left));
  }
  spend(walk, party, digging ? DIG_STAMINA : SEARCH_STAMINA_PER_MIN * t.minutes);
  const lines = found.length > 0 ? [`You ${digging ? 'dig out' : 'search'} the ${name} and find:`, ...found.map((f) => itemLine(f, party))] : [`The ${name} holds nothing.`];
  return { minutes: t.minutes, found, lines };
}
