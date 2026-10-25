// District level (SX 02): the hidden 1 km damage layer. Built once by Tools/worldgen/steps/districts.ts, shipped as
// public/world/districts.json, loaded by the game but never shown to the player directly.
// Local frame as in terrain.ts: x metres east, y metres north from the patch's SW corner.
import type { BandCode } from './flood';
import type { Features } from './features';
import { TILES_PER_SIDE, TILE_M, tileId } from './terrain';

export const DISTRICTS_VERSION = 1;

/** Roads are split at tile edges and junctions, then into equal pieces no longer than this, metres. */
export const MAX_SEGMENT_M = 250;

export type Compass = 'north' | 'north-east' | 'east' | 'south-east' | 'south' | 'south-west' | 'west' | 'north-west';

/** The storm of strikes that came with the wave: hand-picked in Tools/worldgen/decisions.ts. */
export interface StormDecision {
  /** Which side of the moor took the worst of it. */
  worstSide: Compass;
  /** Strike density peaks here and thins with distance. OSGB metres and local metres. */
  centre: { e: number; n: number; x: number; y: number };
  why: string;
}

/** A hand-picked surviving structure; one structure can be several bridge records (both carriageways, rail and path). */
export interface SurvivorDecision {
  name: string;
  bridgeIds: string[];
  why: string;
}

/**
 * Why a bridge stands or fell. 'survivor' = hand-picked in decisions.ts; 'undecided' = no damage rolled yet.
 * The bridge-state step adds its own codes (for example fell below the mark, wrack dam, strike).
 */
export type BridgeReason = 'survivor' | 'undecided' | (string & {});

export interface DistrictBridge {
  /** 'br-<way>' for OSM bridge records (the features.json id); 'xb-<way>-<river>-<n>' for a crossing with no record. */
  id: string;
  source: 'osm' | 'crossing';
  x: number;
  y: number;
  /** Estimated deck height, metres: mean ground height at the ends, at least DECK_CLEARANCE_M over the ground beneath. */
  deckH: number;
  /** Mark at (x, y), metres. */
  hwAt: number;
  /** hwAt - deckH: positive when the deck was under the wave. */
  depthBelowMark: number;
  major: boolean;
  on: 'road' | 'rail';
  /** Id of the road or rail feature that carries it. */
  refId: string;
  /** Id of the river or stream feature beneath, or null (over a road, a rail line or a dry valley). */
  crosses: string | null;
  standing: boolean;
  reason: BridgeReason;
}

/** What blocks a road segment. The blocker steps add to this list. */
export type BlockCause =
  | 'bridge'
  | 'crater'
  | 'strike'
  | 'fire'
  | 'gas'
  | 'wrack'
  | 'landslip'
  | 'silt'
  | 'fallenWood'
  | 'water';

export const BLOCK_CAUSES: readonly BlockCause[] = [
  'bridge',
  'crater',
  'strike',
  'fire',
  'gas',
  'wrack',
  'landslip',
  'silt',
  'fallenWood',
  'water',
];

export interface RoadSegment {
  /** '<roadId>-<n>', n counting from 0 along the road. */
  id: string;
  roadId: string;
  /** Tile id (tileId) holding the segment; segments never cross a tile edge. */
  tile: string;
  pts: [number, number][];
  /** Metres along pts. */
  length: number;
  /** At least half of the segment lies inside a woods polygon. */
  inWood: boolean;
  /** Deepest band sampled along the segment (3 where a trapped lake covers it at its spill level). */
  band: BandCode;
  blocked: boolean;
  cause: BlockCause | null;
}

/** Shared shape of a round damage feature: centre and radius, local metres. */
export interface Spot {
  id: string;
  x: number;
  y: number;
  r: number;
}

/** 5 to 50 m across; large ones have an ejecta ring and sometimes standing water. */
export interface Crater extends Spot {
  water: boolean;
}

/** 100 m and up: burning or glassy ground, visible from tors as smoke. */
export interface StrikeZone extends Spot {
  kind: 'burning' | 'glassy';
}

export interface Fire extends Spot {
  /** Game day (GameClock.gameDays) it burns out. */
  untilDay: number;
}

/** Valley floors, days 1 to 5 only. */
export interface GasHollow extends Spot {
  untilDay: number;
}

export interface WrackDam extends Spot {
  bridgeId: string | null;
}

export type Landslip = Spot;

export interface SiltPatch extends Spot {
  /** Soft patches can trap you. */
  soft: boolean;
}

export interface FallenWood {
  id: string;
  /** The woods feature it lies in. */
  woodId: string;
}

export type AnimalKind = 'rabbit' | 'pony' | 'roeDeer' | 'redDeer' | 'sheep';
export const ANIMAL_KINDS: readonly AnimalKind[] = ['rabbit', 'pony', 'roeDeer', 'redDeer', 'sheep'];

export interface DistrictTile {
  id: string;
  i: number;
  j: number;
  /** Mark for the tile (flood.json). */
  hw: number;
  craters: Crater[];
  strikeZones: StrikeZone[];
  fires: Fire[];
  gasHollows: GasHollow[];
  /** Head count per kind; a missing kind is none. */
  animals: Partial<Record<AnimalKind, number>>;
  /** Small-strike density, 0 (none) to 1 (worst); slows walking. */
  pocked: number;
  wrackDams: WrackDam[];
  landslips: Landslip[];
  silt: SiltPatch[];
  fallenWoods: FallenWood[];
}

export interface Districts {
  version: number;
  method: string;
  storm: StormDecision;
  survivors: SurvivorDecision[];
  bridges: DistrictBridge[];
  roadSegments: RoadSegment[];
  /** 100 tiles, row-major (j * 10 + i). */
  tiles: DistrictTile[];
}

const SPOT_LISTS = ['craters', 'strikeZones', 'fires', 'gasHollows', 'wrackDams', 'landslips', 'silt'] as const;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

/**
 * Checks parsed districts.json. Returns a list of errors (empty when valid).
 * With features, also checks every bridge and segment references a real feature.
 */
export function validateDistricts(d: unknown, features?: Features): string[] {
  const errs: string[] = [];
  if (!isObj(d)) return ['districts: not an object'];
  if (d.version !== DISTRICTS_VERSION) errs.push(`version: expected ${DISTRICTS_VERSION}, got ${String(d.version)}`);
  if (!isStr(d.method)) errs.push('method: missing');

  const storm = d.storm;
  if (!isObj(storm)) errs.push('storm: missing');
  else {
    if (!isStr(storm.worstSide)) errs.push('storm.worstSide: missing');
    const c = storm.centre;
    if (!isObj(c) || !isNum(c.e) || !isNum(c.n) || !isNum(c.x) || !isNum(c.y)) errs.push('storm.centre: bad');
    if (!isStr(storm.why)) errs.push('storm.why: missing');
  }

  const roads = new Set(features?.roads.map((r) => r.id));
  const rail = new Set(features?.rail.map((r) => r.id));
  const rivers = new Set(features?.rivers.map((r) => r.id));
  const woods = new Set(features?.woods.map((w) => w.id));
  const osmBridges = new Set(features?.bridges.map((b) => b.id));

  const bridgeIds = new Set<string>();
  if (!Array.isArray(d.bridges)) errs.push('bridges: not an array');
  else {
    d.bridges.forEach((b: unknown, k) => {
      const at = `bridges[${k}]`;
      if (!isObj(b)) return void errs.push(`${at}: not an object`);
      if (!isStr(b.id)) return void errs.push(`${at}.id: missing`);
      if (bridgeIds.has(b.id)) errs.push(`${at}: duplicate id ${b.id}`);
      bridgeIds.add(b.id);
      if (b.source !== 'osm' && b.source !== 'crossing') errs.push(`${at}.source: bad`);
      for (const f of ['x', 'y', 'deckH', 'hwAt', 'depthBelowMark'] as const) {
        if (!isNum(b[f])) errs.push(`${at}.${f}: not a number`);
      }
      if (isNum(b.hwAt) && isNum(b.deckH) && isNum(b.depthBelowMark) && Math.abs(b.hwAt - b.deckH - b.depthBelowMark) > 0.011) {
        errs.push(`${at}.depthBelowMark: not hwAt - deckH`);
      }
      if (typeof b.major !== 'boolean') errs.push(`${at}.major: not a boolean`);
      if (typeof b.standing !== 'boolean') errs.push(`${at}.standing: not a boolean`);
      if (!isStr(b.reason)) errs.push(`${at}.reason: missing`);
      if (b.on !== 'road' && b.on !== 'rail') errs.push(`${at}.on: bad`);
      if (!isStr(b.refId)) errs.push(`${at}.refId: missing`);
      if (b.crosses !== null && !isStr(b.crosses)) errs.push(`${at}.crosses: not a string or null`);
      if (features) {
        if (isStr(b.refId) && !(b.on === 'rail' ? rail : roads).has(b.refId)) errs.push(`${at}.refId: no ${String(b.on)} ${b.refId}`);
        if (isStr(b.crosses) && !rivers.has(b.crosses)) errs.push(`${at}.crosses: no river ${b.crosses}`);
        if (b.source === 'osm' && !osmBridges.has(b.id)) errs.push(`${at}: no features bridge ${b.id}`);
      }
    });
  }

  if (!Array.isArray(d.survivors)) errs.push('survivors: not an array');
  else {
    d.survivors.forEach((s: unknown, k) => {
      if (!isObj(s) || !isStr(s.name) || !isStr(s.why) || !Array.isArray(s.bridgeIds)) {
        return void errs.push(`survivors[${k}]: bad`);
      }
      for (const id of s.bridgeIds) if (!bridgeIds.has(id as string)) errs.push(`survivors[${k}]: no bridge ${String(id)}`);
    });
  }

  const tileIds = new Set<string>();
  for (let j = 0; j < TILES_PER_SIDE; j++) for (let i = 0; i < TILES_PER_SIDE; i++) tileIds.add(tileId(i, j));

  if (!Array.isArray(d.roadSegments)) errs.push('roadSegments: not an array');
  else {
    const segIds = new Set<string>();
    d.roadSegments.forEach((s: unknown, k) => {
      const at = `roadSegments[${k}]`;
      if (!isObj(s)) return void errs.push(`${at}: not an object`);
      if (!isStr(s.id)) return void errs.push(`${at}.id: missing`);
      if (segIds.has(s.id)) errs.push(`${at}: duplicate id ${s.id}`);
      segIds.add(s.id);
      if (!isStr(s.roadId)) errs.push(`${at}.roadId: missing`);
      else if (features && !roads.has(s.roadId)) errs.push(`${at}.roadId: no road ${s.roadId}`);
      if (!isStr(s.tile) || !tileIds.has(s.tile)) errs.push(`${at}.tile: bad ${String(s.tile)}`);
      if (!Array.isArray(s.pts) || s.pts.length < 2 || !s.pts.every(isPt)) errs.push(`${at}.pts: need two or more points`);
      if (!isNum(s.length) || s.length < 0 || s.length > MAX_SEGMENT_M + 1) errs.push(`${at}.length: bad ${String(s.length)}`);
      if (typeof s.inWood !== 'boolean') errs.push(`${at}.inWood: not a boolean`);
      if (s.band !== 0 && s.band !== 1 && s.band !== 2 && s.band !== 3) errs.push(`${at}.band: bad`);
      if (typeof s.blocked !== 'boolean') errs.push(`${at}.blocked: not a boolean`);
      if (s.cause !== null && !BLOCK_CAUSES.includes(s.cause as BlockCause)) errs.push(`${at}.cause: bad`);
      if (s.blocked === true && s.cause === null) errs.push(`${at}: blocked without a cause`);
    });
  }

  if (!Array.isArray(d.tiles)) errs.push('tiles: not an array');
  else {
    if (d.tiles.length !== TILES_PER_SIDE * TILES_PER_SIDE) errs.push(`tiles: expected 100, got ${d.tiles.length}`);
    d.tiles.forEach((t: unknown, k) => {
      const at = `tiles[${k}]`;
      if (!isObj(t)) return void errs.push(`${at}: not an object`);
      const i = k % TILES_PER_SIDE;
      const j = Math.floor(k / TILES_PER_SIDE);
      if (t.i !== i || t.j !== j || (j < TILES_PER_SIDE && t.id !== tileId(i, j))) {
        errs.push(`${at}: expected ${j < TILES_PER_SIDE ? tileId(i, j) : '?'} at (${i},${j})`);
      }
      if (!isNum(t.hw)) errs.push(`${at}.hw: not a number`);
      if (!isNum(t.pocked) || t.pocked < 0 || t.pocked > 1) errs.push(`${at}.pocked: not in 0..1`);
      for (const list of SPOT_LISTS) {
        const v = t[list];
        if (!Array.isArray(v)) {
          errs.push(`${at}.${list}: not an array`);
          continue;
        }
        v.forEach((s: unknown, n) => {
          if (!isObj(s) || !isStr(s.id) || !isNum(s.x) || !isNum(s.y) || !isNum(s.r) || s.r <= 0) {
            errs.push(`${at}.${list}[${n}]: bad spot`);
          } else if (s.x < i * TILE_M || s.x > (i + 1) * TILE_M || s.y < j * TILE_M || s.y > (j + 1) * TILE_M) {
            errs.push(`${at}.${list}[${n}]: outside the tile`);
          }
        });
      }
      if (!Array.isArray(t.fallenWoods)) errs.push(`${at}.fallenWoods: not an array`);
      else {
        t.fallenWoods.forEach((w: unknown, n) => {
          if (!isObj(w) || !isStr(w.id) || !isStr(w.woodId)) errs.push(`${at}.fallenWoods[${n}]: bad`);
          else if (features && !woods.has(w.woodId)) errs.push(`${at}.fallenWoods[${n}]: no wood ${w.woodId}`);
        });
      }
      if (!isObj(t.animals)) errs.push(`${at}.animals: not an object`);
      else {
        for (const [kind, n] of Object.entries(t.animals)) {
          if (!ANIMAL_KINDS.includes(kind as AnimalKind)) errs.push(`${at}.animals: unknown kind ${kind}`);
          if (!isNum(n) || n < 0 || !Number.isInteger(n)) errs.push(`${at}.animals.${kind}: bad count`);
        }
      }
    });
  }
  return errs;
}

/** Throws with every error if d is not valid districts data. */
export function parseDistricts(d: unknown, features?: Features): Districts {
  const errs = validateDistricts(d, features);
  if (errs.length > 0) throw new Error(`districts.json: ${errs.length} error(s):\n  ${errs.slice(0, 20).join('\n  ')}`);
  return d as Districts;
}

/** Fetches and validates districts.json (browser). */
export async function fetchDistricts(
  baseUrl = '/world/',
  features?: Features,
  fetchFn: typeof fetch = fetch,
): Promise<Districts> {
  const res = await fetchFn(baseUrl + 'districts.json');
  if (!res.ok) throw new Error(`fetch ${baseUrl}districts.json: ${res.status}`);
  return parseDistricts(await res.json(), features);
}

/** Tile record for tile (i, j). */
export function districtTile(d: Districts, i: number, j: number): DistrictTile | undefined {
  return d.tiles[j * TILES_PER_SIDE + i];
}
