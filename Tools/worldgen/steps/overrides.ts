// Hand fixes to the generated damage (SX 02: check by eye, fix anything implausible). Runs last, after every damage
// step, so the fixes survive regeneration. Each entry in Tools/worldgen/overrides.json names its record and says why.
import { readFileSync, writeFileSync } from 'node:fs';
import { validateDistricts, type Districts, type DistrictTile } from '../../../src/world/districts';
import type { Features } from '../../../src/world/features';
import { TILES_PER_SIDE, TILE_M } from '../../../src/world/terrain';
import type { Step } from '../steps';
import { serialise } from './districts';

const dir = 'public/world/';
export const OVERRIDES_PATH = 'Tools/worldgen/overrides.json';

/** Spot kinds an override can add, change or remove, and the tile list each lives in. */
const SPOT_LIST = {
  crater: 'craters',
  strikeZone: 'strikeZones',
  fire: 'fires',
  gasHollow: 'gasHollows',
} as const satisfies Record<string, keyof DistrictTile>;

export type OverrideKind = 'bridge' | 'roadSegment' | keyof typeof SPOT_LIST;

/**
 * One hand fix. `set` merges fields into the record with that id; `remove` drops it; `add` places a new spot record
 * (its id must be new; the tile comes from x, y). Bridges and segments can only be changed, not added or removed.
 */
export interface Override {
  kind: OverrideKind;
  id: string;
  reason: string;
  set?: Record<string, unknown>;
  remove?: true;
  add?: Record<string, unknown>;
}

/** Bridge reason recorded for a bridge whose standing was hand-set. */
export const OVERRIDE_REASON = 'override';

/** Applies the overrides in order to d (in place). Throws if an entry is malformed or its record is missing. */
export function applyOverrides(d: Districts, overrides: readonly Override[]): void {
  for (const [k, o] of overrides.entries()) {
    const at = `overrides[${k}] (${o.kind} ${o.id})`;
    if (typeof o.reason !== 'string' || o.reason.trim().length === 0) throw new Error(`${at}: needs a reason`);
    const ops = [o.set, o.remove, o.add].filter((v) => v !== undefined).length;
    if (ops !== 1) throw new Error(`${at}: needs exactly one of set, remove or add`);

    if (o.kind === 'bridge' || o.kind === 'roadSegment') {
      if (!o.set) throw new Error(`${at}: bridges and road segments can only be set`);
      const list: { id: string }[] = o.kind === 'bridge' ? d.bridges : d.roadSegments;
      const rec = list.find((r) => r.id === o.id);
      if (!rec) throw new Error(`${at}: no such record`);
      Object.assign(rec, o.set);
      if (o.kind === 'bridge' && 'standing' in o.set && !('reason' in o.set)) Object.assign(rec, { reason: OVERRIDE_REASON });
      if (o.kind === 'roadSegment' && o.set.blocked === false) Object.assign(rec, { cause: null });
      continue;
    }

    const listName = SPOT_LIST[o.kind];
    if (!listName) throw new Error(`${at}: unknown kind`);
    const holder = d.tiles.find((t) => (t[listName] as { id: string }[]).some((s) => s.id === o.id));
    if (o.add) {
      if (holder) throw new Error(`${at}: id already used`);
      const { x, y } = o.add;
      if (typeof x !== 'number' || typeof y !== 'number') throw new Error(`${at}: add needs x and y`);
      const i = Math.floor(x / TILE_M);
      const j = Math.floor(y / TILE_M);
      const tile = i >= 0 && j >= 0 && i < TILES_PER_SIDE && j < TILES_PER_SIDE ? d.tiles[j * TILES_PER_SIDE + i] : undefined;
      if (!tile) throw new Error(`${at}: outside the patch`);
      (tile[listName] as unknown[]).push({ id: o.id, ...o.add });
      continue;
    }
    if (!holder) throw new Error(`${at}: no such record`);
    const list = holder[listName] as { id: string }[];
    const n = list.findIndex((s) => s.id === o.id);
    if (o.remove) list.splice(n, 1);
    else Object.assign(list[n] as object, o.set);
  }
}

export function readOverrides(path = OVERRIDES_PATH): Override[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { overrides?: unknown };
  if (!Array.isArray(raw.overrides)) throw new Error(`${path}: no overrides array`);
  return raw.overrides as Override[];
}

export const overridesStep: Step = {
  name: 'overrides',
  run() {
    const features = JSON.parse(readFileSync(dir + 'features.json', 'utf8')) as Features;
    const districts = JSON.parse(readFileSync(dir + 'districts.json', 'utf8')) as Districts;
    const overrides = readOverrides();
    applyOverrides(districts, overrides);

    const marker = ' [overrides] ';
    districts.method =
      districts.method.split(marker)[0] +
      marker +
      `${overrides.length} hand fixes from ${OVERRIDES_PATH}, applied last; each entry there gives its reason. Bridges set by hand ` +
      `have reason '${OVERRIDE_REASON}'.`;

    const errs = validateDistricts(districts, features);
    if (errs.length > 0) throw new Error(`overrides: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
    writeFileSync(dir + 'districts.json', serialise(districts));
    const byKind: Record<string, number> = {};
    for (const o of overrides) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
    console.log(`[worldgen] overrides: ${overrides.length} applied ${JSON.stringify(byKind)}`);
  },
};
