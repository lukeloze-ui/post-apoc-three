// Ground conditions (SX 02, Damage blocks): one query merging landcover and roads, water, the district damage layer
// and the loaded ground objects into a speed factor, an effort factor, hazards and a line for the HUD.
// Each blocker is a cost, not a wall: only burning ground and live fires refuse the player outright.
// Local frame as in terrain.ts: x metres east, y metres north. Days are GameClock.gameDays.
import {
  ringContains,
  type BlockCause,
  type Crater,
  type Districts,
  type Fire,
  type GasHollow,
  type Landslip,
  type RoadSegment,
  type SiltFlat,
  type Spot,
  type StrikeZone,
  type WrackDam,
} from './districts';
import type { Pt, WoodFeature } from './features';
import type { GroundObject } from './ground';
import { spotGrid, type RoundSpot, type SpotGrid } from './surface';
import { TILES_PER_SIDE, tileOf } from './terrain';
import { GROUND_FACTOR, type GroundType } from '../sim/walking';

export const GROUND_LABEL: Record<GroundType, string> = {
  road: 'road',
  track: 'track',
  path: 'path',
  moor_grass: 'moor grass',
  field: 'field',
  heather: 'heather',
  bog: 'bog',
  rock: 'rock',
  wood: 'woodland',
  debris: 'debris',
  rubble: 'rubble',
};

/** Speed multipliers (on top of the ground type and slope) and effort multipliers for each blocker. */
export const POCKED_SLOW = 0.1;
/** Pocked density from which the ground is named on the HUD and trips you in the dark. */
export const POCKED_NOTICE = 0.5;
export const GLASSY_FACTOR = 0.6;
export const WRACK_FACTOR = 0.15;
export const LANDSLIP_FACTOR = 0.3;
export const FALLEN_WOOD_FACTOR = 0.2;
export const SILT_FACTOR = 0.5;
export const SILT_EFFORT = 1.6;
/** Risks are 0 (none) to 1 (high); what they cost is decided by the injury and trap tasks. */
export const WRACK_INJURY = 0.5;
export const LANDSLIP_INJURY = 0.4;
export const SOFT_PATCH_TRAP = 0.6;
/** Rubble, wrack and trunks on the ground count within this many metres of their edge. */
export const DEBRIS_REACH_M = 2;
/** A blocked road segment is blocked within this many metres of its middle. */
export const ROAD_BLOCK_REACH_M = 15;
/** Water deeper than this has to be waded or swum. */
export const WADE_FROM_M = 0.3;

export interface Hazards {
  /** Rough ground that trips you when walked in the dark. */
  tripInDark: boolean;
  injuryRisk: number;
  trapRisk: number;
  /** Standing in a gas hollow on one of its days. */
  gas: boolean;
  /** Metres of standing water; 0 when dry. */
  waterDepth: number;
  impassable: boolean;
}

export interface Conditions {
  groundType: GroundType;
  /** Multiplies walking speed (walking.ts extraFactor). */
  speedFactor: number;
  /** Multiplies fatigue (walking.ts extraEffort). */
  effortFactor: number;
  hazards: Hazards;
  /** For the HUD, e.g. 'fallen woodland - very slow'. */
  explanation: string;
}

interface FallenRing extends Spot {
  ring: readonly Pt[];
  tile: number;
}

interface BlockedSpot extends RoundSpot {
  cause: BlockCause;
}

/** The district damage layer, bucketed for point queries. */
export interface DamageIndex {
  pocked: Float32Array;
  craters: SpotGrid<Crater>;
  strikes: SpotGrid<StrikeZone>;
  fires: SpotGrid<Fire>;
  wrack: SpotGrid<WrackDam>;
  landslips: SpotGrid<Landslip>;
  silt: SpotGrid<SiltFlat>;
  soft: SpotGrid<Spot>;
  fallen: SpotGrid<FallenRing>;
  blocked: SpotGrid<BlockedSpot>;
  /** Gas hollows by 50 m terrain cell, key row * 4096 + column. */
  gas: Map<number, GasHollow[]>;
  cellM: number;
}

function ringSpot<T extends { ring: readonly Pt[] }>(o: T): T & RoundSpot {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of o.ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { ...o, x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: Math.hypot(x1 - x0, y1 - y0) / 2 };
}

/** The point halfway along a segment's polyline. */
function midpoint(seg: RoadSegment): [number, number] {
  let left = seg.length / 2;
  for (let k = 1; k < seg.pts.length; k++) {
    const [ax, ay] = seg.pts[k - 1]!;
    const [bx, by] = seg.pts[k]!;
    const d = Math.hypot(bx - ax, by - ay);
    if (d >= left && d > 0) return [ax + ((bx - ax) * left) / d, ay + ((by - ay) * left) / d];
    left -= d;
  }
  return seg.pts[seg.pts.length - 1] ?? [0, 0];
}

/** Index the districts once at load. woods are features.json woods (for the fallen ones); cellM is the terrain cell. */
export function buildDamageIndex(d: Districts, woods: readonly WoodFeature[], cellM = 50): DamageIndex {
  const ts = d.tiles;
  const woodById = new Map(woods.map((w) => [w.id, w]));
  const fallen: FallenRing[] = [];
  ts.forEach((t, k) => {
    for (const f of t.fallenWood) {
      const w = woodById.get(f.woodId);
      if (w) fallen.push(ringSpot({ id: f.id, x: 0, y: 0, r: 0, ring: w.ring, tile: k }));
    }
  });
  const gas = new Map<number, GasHollow[]>();
  for (const h of ts.flatMap((t) => t.gasHollows)) {
    for (const [c, r] of h.cells) {
      const key = r * 4096 + c;
      const list = gas.get(key);
      if (list) list.push(h);
      else gas.set(key, [h]);
    }
  }
  const blocked: BlockedSpot[] = d.roadSegments
    .filter((s) => s.blocked && s.cause)
    .map((s) => {
      const [x, y] = midpoint(s);
      return { x, y, r: ROAD_BLOCK_REACH_M, cause: s.cause as BlockCause };
    });
  const siltFlats = ts.flatMap((t) => t.siltFlats);
  return {
    pocked: Float32Array.from(ts.map((t) => t.pocked)),
    craters: spotGrid(ts.flatMap((t) => t.craters), 1),
    strikes: spotGrid(ts.flatMap((t) => t.strikeZones), 1),
    fires: spotGrid(ts.flatMap((t) => t.fires), 1),
    wrack: spotGrid(ts.flatMap((t) => t.wrackDams), 1),
    landslips: spotGrid(ts.flatMap((t) => t.landslips).map(ringSpot), 1),
    silt: spotGrid(siltFlats.map(ringSpot), 1),
    soft: spotGrid(siltFlats.flatMap((f) => f.softPatches), 1),
    fallen: spotGrid(fallen, 1),
    blocked: spotGrid(blocked, 1),
    gas,
    cellM,
  };
}

/** True if an active gas hollow (its days, as in conditionsAt) has a cell within reachM of (x, y): the cue to warn. */
export function gasNearby(dm: DamageIndex, x: number, y: number, gameDay: number, reachM: number): boolean {
  const day = Math.floor(gameDay);
  const c0 = Math.floor((x - reachM) / dm.cellM);
  const c1 = Math.floor((x + reachM) / dm.cellM);
  const r0 = Math.floor((y - reachM) / dm.cellM);
  const r1 = Math.floor((y + reachM) / dm.cellM);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (dm.gas.get(r * 4096 + c)?.some((h) => day >= h.fromDay && day <= h.toDay)) return true;
    }
  }
  return false;
}

interface DebrisSpot extends RoundSpot {
  ground: GroundType;
  label: string;
  /** Trunks: the far end of the trunk from (ax, ay); piles have none. */
  ax?: number;
  ay?: number;
  bx?: number;
  by?: number;
}

/** Rubble, wrack and fallen trunks of the loaded ground tiles. Tiles come and go with the ground streaming. */
export interface DebrisIndex {
  setTile(id: string, objects: readonly GroundObject[]): void;
  removeTile(id: string): void;
  /** The roughest debris within reach of (x, y), or undefined. */
  at(x: number, y: number): { ground: GroundType; label: string } | undefined;
}

function debrisSpot(o: GroundObject): DebrisSpot | undefined {
  const R = DEBRIS_REACH_M;
  if (o.kind === 'rubble') return { x: o.x, y: o.y, r: o.size / 2 + R, ground: 'rubble', label: 'rubble' };
  if (o.kind === 'wrack') return { x: o.x, y: o.y, r: o.size / 2 + R, ground: 'debris', label: 'wrack' };
  if (o.kind === 'trunk') {
    // Root at (x, y), crown along rot (clockwise from north).
    const bx = o.x + Math.sin(o.rot) * o.size;
    const by = o.y + Math.cos(o.rot) * o.size;
    return { x: (o.x + bx) / 2, y: (o.y + by) / 2, r: o.size / 2 + R, ground: 'debris', label: 'fallen trunk', ax: o.x, ay: o.y, bx, by };
  }
  return undefined;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function createDebrisIndex(): DebrisIndex {
  const tiles = new Map<string, SpotGrid<DebrisSpot>>();
  return {
    setTile(id, objects) {
      const spots = objects.map(debrisSpot).filter((s): s is DebrisSpot => s !== undefined);
      if (spots.length) tiles.set(id, spotGrid(spots, 1, 16));
      else tiles.delete(id);
    },
    removeTile(id) {
      tiles.delete(id);
    },
    at(x, y) {
      let best: DebrisSpot | undefined;
      for (const g of tiles.values()) {
        const b = g.bounds;
        if (!b || x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
        for (const s of g.near(x, y)) {
          const d = s.ax === undefined ? Math.hypot(x - s.x, y - s.y) - (s.r - DEBRIS_REACH_M) : segDist(x, y, s.ax, s.ay!, s.bx!, s.by!);
          if (d > DEBRIS_REACH_M) continue;
          if (!best || GROUND_FACTOR[s.ground] < GROUND_FACTOR[best.ground]) best = s;
        }
      }
      return best;
    },
  };
}

/** What conditionsAt reads. The damage and debris layers are optional so tests and early loading can leave them out. */
export interface ConditionsWorld {
  /** A road class within the road's half-width, otherwise the landcover type. */
  groundTypeAt(x: number, y: number): GroundType;
  /** Depth of standing water (lakes at their level on gameDay), metres; 0 or less when dry. */
  waterDepthAt?(x: number, y: number, gameDay: number): number;
  damage?: DamageIndex;
  debris?: DebrisIndex;
}

/** One thing the ground does here. pace ranks it for the HUD; speed and effort fold into the totals. */
interface Effect {
  label: string;
  pace: number;
  speed?: number;
  effort?: number;
  note?: string;
}

const inside = (s: RoundSpot, x: number, y: number): boolean => Math.hypot(x - s.x, y - s.y) <= s.r;
const inRing = (s: RoundSpot & { ring: readonly Pt[] }, x: number, y: number): boolean =>
  inside(s, x, y) && ringContains(s.ring, x, y);
/** Fires and strike plumes burn from fromDay up to (not including) toDay, as in render/damage.ts. */
const burning = (f: { fromDay: number; toDay: number }, day: number): boolean => day >= f.fromDay && day < f.toDay;

function paceWord(pace: number): string {
  if (pace <= 0.25) return 'very slow';
  if (pace <= 0.65) return 'slow';
  return 'a little slow';
}

const BLOCK_EFFECT: Partial<Record<BlockCause, Effect & { injury?: number }>> = {
  crater: { label: 'cratered road', pace: GROUND_FACTOR.rubble, speed: GROUND_FACTOR.rubble },
  strike: { label: 'glassy road', pace: GLASSY_FACTOR, speed: GLASSY_FACTOR },
  wrack: { label: 'wrack across the road', pace: WRACK_FACTOR, speed: WRACK_FACTOR, note: 'very slow, risk of injury', injury: WRACK_INJURY },
  landslip: { label: 'landslip across the road', pace: LANDSLIP_FACTOR, speed: LANDSLIP_FACTOR, note: 'very slow, risk of injury', injury: LANDSLIP_INJURY },
  silt: { label: 'silt over the road', pace: SILT_FACTOR, speed: SILT_FACTOR, effort: SILT_EFFORT, note: 'slow and tiring' },
  fallenWood: { label: 'fallen trees across the road', pace: FALLEN_WOOD_FACTOR, speed: FALLEN_WOOD_FACTOR },
};

/** Ground conditions at (x, y) on gameDay. */
export function conditionsAt(x: number, y: number, gameDay: number, world: ConditionsWorld): Conditions {
  let groundType = world.groundTypeAt(x, y);
  const hazards: Hazards = { tripInDark: false, injuryRisk: 0, trapRisk: 0, gas: false, waterDepth: 0, impassable: false };
  const effects: Effect[] = [];
  let blocker: Effect | undefined;

  const debris = world.debris?.at(x, y);
  if (debris && GROUND_FACTOR[debris.ground] < GROUND_FACTOR[groundType]) {
    groundType = debris.ground;
    hazards.tripInDark = true;
    effects.push({ label: debris.label, pace: GROUND_FACTOR[debris.ground] });
  }

  const dm = world.damage;
  if (dm) {
    const t = tileOf(x, y);
    const tile = t.j * TILES_PER_SIDE + t.i;
    const pocked = dm.pocked[tile] ?? 0;
    if (pocked > 0) {
      const f = 1 - POCKED_SLOW * pocked;
      if (pocked >= POCKED_NOTICE) {
        hazards.tripInDark = true;
        effects.push({ label: 'pocked ground', pace: f, speed: f });
      } else effects.push({ label: '', pace: 1, speed: f });
    }
    for (const c of dm.craters.near(x, y)) {
      if (inside(c, x, y)) effects.push({ label: c.water ? 'flooded crater' : 'crater', pace: 1, note: 'steep sides' });
    }
    for (const z of dm.strikes.near(x, y)) {
      if (!inside(z, x, y)) continue;
      const fire = dm.fires.near(z.x, z.y).find((f) => Math.hypot(f.x - z.x, f.y - z.y) < 1);
      if (z.kind === 'burning' && (!fire || burning(fire, gameDay))) {
        hazards.impassable = true;
        blocker ??= { label: 'burning ground', pace: 0, note: 'impassable' };
      } else {
        const label = z.kind === 'glassy' ? 'glassy strike ground' : 'burnt strike ground';
        effects.push({ label, pace: GLASSY_FACTOR, speed: GLASSY_FACTOR });
      }
    }
    for (const f of dm.fires.near(x, y)) {
      if (inside(f, x, y) && burning(f, gameDay)) {
        hazards.impassable = true;
        blocker ??= { label: 'fire', pace: 0, note: 'impassable' };
      }
    }
    if (dm.wrack.near(x, y).some((w) => inside(w, x, y))) {
      hazards.injuryRisk = Math.max(hazards.injuryRisk, WRACK_INJURY);
      hazards.tripInDark = true;
      effects.push({ label: 'wrack dam', pace: WRACK_FACTOR, speed: WRACK_FACTOR, note: 'very slow, risk of injury' });
    }
    if (dm.landslips.near(x, y).some((l) => inRing(l, x, y))) {
      hazards.injuryRisk = Math.max(hazards.injuryRisk, LANDSLIP_INJURY);
      hazards.tripInDark = true;
      effects.push({ label: 'landslip', pace: LANDSLIP_FACTOR, speed: LANDSLIP_FACTOR, note: 'very slow, risk of injury' });
    }
    if (dm.fallen.near(x, y).some((w) => w.tile === tile && inRing(w, x, y))) {
      effects.push({ label: 'fallen woodland', pace: FALLEN_WOOD_FACTOR, speed: FALLEN_WOOD_FACTOR });
    }
    if (dm.silt.near(x, y).some((s) => inRing(s, x, y))) {
      const soft = dm.soft.near(x, y).some((s) => inside(s, x, y));
      if (soft) hazards.trapRisk = Math.max(hazards.trapRisk, SOFT_PATCH_TRAP);
      effects.push({
        label: soft ? 'soft mud' : 'silt',
        pace: SILT_FACTOR,
        speed: SILT_FACTOR,
        effort: SILT_EFFORT,
        note: soft ? 'slow, may trap you' : 'slow and tiring',
      });
    }
    for (const b of dm.blocked.near(x, y)) {
      const e = BLOCK_EFFECT[b.cause];
      if (!e || !inside(b, x, y)) continue;
      if (e.injury) hazards.injuryRisk = Math.max(hazards.injuryRisk, e.injury);
      effects.push(e);
      break;
    }
    const day = Math.floor(gameDay);
    const hollows = dm.gas.get(Math.floor(y / dm.cellM) * 4096 + Math.floor(x / dm.cellM));
    if (hollows?.some((h) => day >= h.fromDay && day <= h.toDay)) {
      hazards.gas = true;
      blocker ??= { label: 'gas hollow', pace: 1, note: 'get out' };
    }
  }

  const depth = world.waterDepthAt?.(x, y, gameDay) ?? 0;
  if (depth > 0) hazards.waterDepth = depth;
  // Ranked above every slow blocker on the HUD; wading and swimming themselves are the next task's.
  if (depth > WADE_FROM_M) effects.push({ label: `water ${depth.toFixed(1)} m deep`, pace: 0.05, note: 'wade or swim' });

  let speedFactor = 1;
  let effortFactor = 1;
  let worst: Effect | undefined;
  for (const e of effects) {
    speedFactor *= e.speed ?? 1;
    effortFactor *= e.effort ?? 1;
    if (e.label && (!worst || e.pace < worst.pace || (e.note && !worst.note && e.pace === worst.pace))) worst = e;
  }
  const shown = blocker ?? worst;
  const explanation = !shown
    ? GROUND_LABEL[groundType]
    : `${shown.label}${shown.note ? ` - ${shown.note}` : shown.pace < 1 ? ` - ${paceWord(shown.pace)}` : ''}`;
  return { groundType, speedFactor, effortFactor, hazards, explanation };
}
