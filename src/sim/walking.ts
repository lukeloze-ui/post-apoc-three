import { HOP_REST_MIN, personEffects, type Party } from './load';

export type GroundType =
  | 'road'
  | 'track'
  | 'path'
  | 'moor_grass'
  | 'field'
  | 'heather'
  | 'bog'
  | 'rock'
  | 'wood'
  | 'debris'
  | 'rubble';

/** Speed on flat road for a rested, unloaded walker (Naismith), km/h. */
export const BASE_SPEED_KMH = 5;

/** Multiplier on speed by ground type. */
export const GROUND_FACTOR: Record<GroundType, number> = {
  road: 1,
  track: 0.95,
  path: 0.95,
  moor_grass: 0.8,
  field: 0.85,
  heather: 0.6,
  bog: 0.45,
  rock: 0.5,
  wood: 0.6,
  debris: 0.4,
  rubble: 0.3,
};

/** Tobler: v = 6 exp(-3.5 |g + 0.05|); the best speed is on a 5% downhill. */
export const TOBLER_SLOPE_OFFSET = 0.05;
export const TOBLER_SLOPE_K = 3.5;
/** Extra penalty on top of Tobler for steep descent: starts here (grade, negative is downhill). */
export const STEEP_DESCENT_GRADE = -0.2;
export const STEEP_DESCENT_PENALTY = 2;
export const STEEP_DESCENT_MIN_FACTOR = 0.5;

/** Stamina is 0..1. At or above STAMINA_FULL_PACE_ABOVE pace is unaffected; at or below STAMINA_LOW it is x STAMINA_LOW_PACE. */
export const STAMINA_FULL_PACE_ABOVE = 0.5;
export const STAMINA_LOW = 0.2;
export const STAMINA_LOW_PACE = 0.7;

/** Stamina lost per hour of walking at effort 1 and fatigueRate 1. */
export const DRAIN_PER_HOUR = 0.35;
/** Stamina regained per hour of rest. */
export const RECOVER_PER_HOUR = 0.4;
/** Effort multiplier: climbing adds this per unit of grade (0.15 grade = +90%). */
export const CLIMB_EFFORT = 6;
/** Effort multiplier: rough ground adds this share of (1 / groundFactor - 1). */
export const ROUGH_EFFORT = 0.5;
/** Effort at zero speed; effort rises linearly to 1 at BASE_SPEED_KMH. */
export const MIN_EFFORT = 0.6;

/** Everyone stops now and then (navigating, drinking, looking around), even with no forced hops. */
export const BREAK_EVERY_MIN = 45;
export const BREAK_MIN = 15;
/** The length of a simulated day on the move, rests included. */
export const DAY_HOURS = 8;
/** Simulation step, seconds. */
export const STEP_SEC = 30;

/** Per-person stamina, 0..1. Missing people count as fully rested. */
export type StaminaMap = Record<string, number>;

export interface WalkState {
  stamina: StaminaMap;
  /** Seconds walked since the last rest. */
  walkedSec: number;
  /** Seconds of rest still to take; above 0 means the party is stopped. */
  restLeftSec: number;
}

export function newWalkState(party: Party): WalkState {
  const stamina: StaminaMap = {};
  for (const p of party.people) stamina[p.id] = 1;
  return { stamina, walkedSec: 0, restLeftSec: 0 };
}

/** Tobler-style speed multiplier for a grade (rise over run), 1 on the flat. */
export function slopeFactor(grade: number): number {
  const k = TOBLER_SLOPE_K;
  let f = Math.exp(-k * (Math.abs(grade + TOBLER_SLOPE_OFFSET) - TOBLER_SLOPE_OFFSET));
  if (grade < STEEP_DESCENT_GRADE) {
    f *= Math.max(STEEP_DESCENT_MIN_FACTOR, 1 - (STEEP_DESCENT_GRADE - grade) * STEEP_DESCENT_PENALTY);
  }
  return f;
}

export function staminaFactor(stamina: number): number {
  if (stamina >= STAMINA_FULL_PACE_ABOVE) return 1;
  if (stamina <= STAMINA_LOW) return STAMINA_LOW_PACE;
  const t = (stamina - STAMINA_LOW) / (STAMINA_FULL_PACE_ABOVE - STAMINA_LOW);
  return STAMINA_LOW_PACE + (1 - STAMINA_LOW_PACE) * t;
}

/** Pace multiplier while actually walking: band 4 folds its rests into paceFactor, so undo that here. */
function walkingPace(paceFactor: number, restEveryMin: number): number {
  return restEveryMin > 0 ? (paceFactor * (restEveryMin + HOP_REST_MIN)) / restEveryMin : paceFactor;
}

/** Metres per second for the party over this ground. It moves at its slowest member's speed. */
export function speedMs(
  groundType: GroundType,
  grade: number,
  party: Party,
  extraFactor = 1,
  stamina: StaminaMap = {},
): number {
  let pace = 1;
  for (const p of party.people) {
    const fx = personEffects(party.pack, p);
    pace = Math.min(pace, walkingPace(fx.paceFactor, fx.restEveryMin) * staminaFactor(stamina[p.id] ?? 1));
  }
  const kmh = BASE_SPEED_KMH * GROUND_FACTOR[groundType] * slopeFactor(grade) * pace * extraFactor;
  return kmh / 3.6;
}

/** Effort (about 0.6 to 1+) of moving at ms on this ground and grade. extraEffort is the damage-blocker hook. */
export function effort(groundType: GroundType, grade: number, ms: number, extraEffort = 1): number {
  const speedShare = Math.min(1.5, (ms * 3.6) / BASE_SPEED_KMH);
  const base = MIN_EFFORT + (1 - MIN_EFFORT) * speedShare;
  const climb = 1 + CLIMB_EFFORT * Math.max(0, grade);
  const rough = 1 + ROUGH_EFFORT * (1 / GROUND_FACTOR[groundType] - 1);
  return base * climb * rough * extraEffort;
}

/** The shortest forced-walk interval and its rest length for this party, in seconds. */
function restPattern(party: Party): { everySec: number; restSec: number } {
  let everyMin = BREAK_EVERY_MIN;
  let restMin = BREAK_MIN;
  for (const p of party.people) {
    const fx = personEffects(party.pack, p);
    if (fx.restEveryMin > 0 && fx.restEveryMin < everyMin) {
      everyMin = fx.restEveryMin;
      restMin = HOP_REST_MIN;
    }
  }
  return { everySec: everyMin * 60, restSec: restMin * 60 };
}

/**
 * Advance the walk by up to dtSec. Returns metres covered. Stamina drains
 * while walking and recovers while resting. extraFactor scales speed and
 * extraEffort scales fatigue, for damage blockers.
 */
export function stepWalk(
  state: WalkState,
  party: Party,
  groundType: GroundType,
  grade: number,
  dtSec: number,
  extraFactor = 1,
  extraEffort = 1,
): number {
  const { everySec, restSec } = restPattern(party);
  const hours = dtSec / 3600;
  if (state.restLeftSec > 0) {
    state.restLeftSec = Math.max(0, state.restLeftSec - dtSec);
    for (const p of party.people) {
      state.stamina[p.id] = Math.min(1, (state.stamina[p.id] ?? 1) + RECOVER_PER_HOUR * hours);
    }
    return 0;
  }
  const ms = speedMs(groundType, grade, party, extraFactor, state.stamina);
  const e = effort(groundType, grade, ms, extraEffort);
  for (const p of party.people) {
    const fx = personEffects(party.pack, p);
    const s = state.stamina[p.id] ?? 1;
    state.stamina[p.id] = Math.max(0, s - DRAIN_PER_HOUR * fx.fatigueRate * e * hours);
  }
  state.walkedSec += dtSec;
  if (state.walkedSec >= everySec) {
    state.walkedSec = 0;
    state.restLeftSec = restSec;
  }
  return ms * dtSec;
}

export interface ProfileSegment {
  ground: GroundType;
  /** Rise over run; negative is downhill. */
  grade: number;
  lengthM: number;
}

/** Walk the profile, repeated, for DAY_HOURS on the move with rests. Returns km covered. */
export function simulateDay(profile: ProfileSegment[], party: Party): number {
  const state = newWalkState(party);
  let totalM = 0;
  let seg = 0;
  let segLeftM = profile[0]!.lengthM;
  for (let t = 0; t < DAY_HOURS * 3600; t += STEP_SEC) {
    const s = profile[seg]!;
    const m = stepWalk(state, party, s.ground, s.grade, STEP_SEC);
    totalM += m;
    segLeftM -= m;
    while (segLeftM <= 0) {
      seg = (seg + 1) % profile.length;
      segLeftM += profile[seg]!.lengthM;
    }
  }
  return totalM / 1000;
}
