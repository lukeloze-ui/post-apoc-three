// Things that hurt the walking party (SX 02 damage blocks, SX 05 load): trips in the dark, injuries on rough climbs and
// on wrack dams and landslips, soft patches that hold you, and gas in the valley hollows. Pure: no three, no DOM.
// These are gameplay events, not world data, so the rng is injected (tests pass a seeded one). Chances are per metre
// walked, so the size of a step does not change them. Times are game seconds, days are GameClock.gameDays.
import type { Hazards } from '../world/conditions';
import {
  injure,
  newConditions,
  stepConditions,
  type ConditionMap,
  type InjuryPart,
  type InjurySeverity,
} from './condition';
import { bandEffects, loadBand, loadShare, type Party } from './load';
import { carriedKg } from './pack';
import { GROUND_FACTOR, type GroundType, type StaminaMap } from './walking';

export interface HazardRng {
  next(): number;
}

/** Dark is the sun below this many degrees (civil twilight is over). */
export const DARK_SUN_DEG = -6;

/** Chance of a trip per metre walked on pocked ground, rubble, wrack or a landslip in the dark: about one per 250 m. */
export const TRIP_PER_M = 0.004;
export const TRIP_STAMINA = 0.04;
export const TRIP_LOST_SEC = 8;
/** Share of trips that also hurt an ankle (a minor sprain). */
export const TRIP_INJURY_CHANCE = 0.12;

/** Rough ground is anything slower than this ground factor; a climb is a grade at least this steep (SX 05). */
export const ROUGH_GROUND_FACTOR = 0.7;
export const ROUGH_CLIMB_GRADE = 0.1;
/** bandEffects.injuryRiskOnRoughClimb is per climb; a climb is this many metres of rough ground walked uphill. */
export const ROUGH_CLIMB_UNIT_M = 100;

/**
 * Wrack dams and landslips carry a risk of 0 to 1 (Hazards.injuryRisk). Per metre crossed the chance of hurting a
 * person is risk x this, so 10 m of wrack dam (0.5) is about 10% each. A heavier pack raises it by
 * 1 + LOAD_INJURY_GAIN x the band's rough-climb risk.
 */
export const INJURY_PER_M_PER_RISK = 0.02;
export const LOAD_INJURY_GAIN = 20;

/** Injury severity odds (cumulative): 60% sprain, 30% strain, 10% tear. Ankle 60%, knee 40%. */
export const SEVERITY_ODDS: readonly number[] = [0.6, 0.9];
export const ANKLE_SHARE = 0.6;

/** A soft patch holds you with chance trapRisk x this, once on entering it. Getting out takes a time and stamina. */
export const STUCK_SCALE = 0.7;
export const STUCK_MIN_SEC = 240;
export const STUCK_MAX_SEC = 600;
export const STUCK_STAMINA = 0.1;

/** Gas (SX 01): from Day 1 03:00 to the end of day 5; heavier than air, so it lies in valley hollows. */
export const GAS_START_DAYS = 1 + 3 / 24;
export const GAS_END_DAYS = 6;
/** Dose is 0 to 1 per person; 1 is collapse. A 75 kg adult collapses in about 8 minutes in the gas; lighter people sooner. */
export const GAS_DOSE_PER_MIN = 0.125;
export const GAS_REF_KG = 75;
export const GAS_CLEAR_PER_MIN = 0.1;
/** Dose where the first warning shows, where it is serious, and where the screen starts to fade. */
export const GAS_WARN_DOSE = 0.15;
export const GAS_SERIOUS_DOSE = 0.5;
export const GAS_FADE_FROM = 0.35;
/** Dead birds and silent insects are noticed within this many metres of an active hollow. */
export const GAS_CUE_REACH_M = 120;

export function gasActive(gameDays: number): boolean {
  return gameDays >= GAS_START_DAYS && gameDays < GAS_END_DAYS;
}

export type HazardEvent =
  | { kind: 'trip'; who: string; hurt: boolean }
  | { kind: 'injury'; who: string; part: InjuryPart; severity: InjurySeverity; cause: 'rough climb' | 'wrack or landslip' | 'fall' }
  | { kind: 'stuck'; sec: number }
  | { kind: 'gas'; level: 'warning' | 'serious' }
  | { kind: 'collapse'; who: string };

export interface HazardState {
  conditions: ConditionMap;
  /** Gas dose per person, 0 to 1. */
  gasDose: Record<string, number>;
  /** Someone has passed out in the gas; the party does not move on. */
  collapsed: boolean;
  /** Standing in a soft patch already (so it does not hold you again until you have left it). */
  inTrap: boolean;
  /** Highest gas level already announced, so each is reported once per exposure. */
  gasLevel: 0 | 1 | 2;
}

export function newHazardState(party: Party): HazardState {
  const gasDose: Record<string, number> = {};
  for (const p of party.people) gasDose[p.id] = 0;
  return { conditions: newConditions(party), gasDose, collapsed: false, inTrap: false, gasLevel: 0 };
}

/** What one step of walking (or standing) did. */
export interface HazardStep {
  /** The ground's hazards here (conditions.hazards). */
  hazards: Hazards;
  groundType: GroundType;
  /** Rise over run along the direction of motion. */
  grade: number;
  /** Metres actually covered this step; 0 when standing or resting. */
  movedM: number;
  dtSec: number;
  gameDays: number;
  /** Degrees; below DARK_SUN_DEG it is dark. */
  sunAltitude: number;
  /** Stamina per person; trips and getting unstuck take from it. */
  stamina: StaminaMap;
  /** False while the party rests. */
  walking: boolean;
}

export interface HazardResult {
  events: HazardEvent[];
  /** Extra game seconds lost (stumbles, getting out of mud); the caller advances the clock by it. */
  lostSec: number;
}

export const isDark = (sunAltitude: number): boolean => sunAltitude < DARK_SUN_DEG;

const hit = (rng: HazardRng, p: number): boolean => p > 0 && rng.next() < p;

function pick<T>(rng: HazardRng, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))] as T;
}

function rollInjury(rng: HazardRng): { part: InjuryPart; severity: InjurySeverity } {
  const s = rng.next();
  const severity: InjurySeverity = s < (SEVERITY_ODDS[0] as number) ? 1 : s < (SEVERITY_ODDS[1] as number) ? 2 : 3;
  return { part: rng.next() < ANKLE_SHARE ? 'ankle' : 'knee', severity };
}

function loadRisk(party: Party, id: string, bodyKg: number): number {
  return bandEffects(loadBand(loadShare(carriedKg(party.pack, id), bodyKg))).injuryRiskOnRoughClimb;
}

/** Roll this step's hazards and advance injuries, wetness, exposure and gas. */
export function stepHazards(state: HazardState, party: Party, s: HazardStep, rng: HazardRng): HazardResult {
  const events: HazardEvent[] = [];
  let lostSec = 0;
  const dark = isDark(s.sunAltitude);

  // Trips: rough ground you cannot see, in the dark.
  if (s.movedM > 0 && dark && s.hazards.tripInDark && hit(rng, TRIP_PER_M * s.movedM)) {
    const who = pick(rng, party.people).id;
    s.stamina[who] = Math.max(0, (s.stamina[who] ?? 1) - TRIP_STAMINA);
    lostSec += TRIP_LOST_SEC;
    const hurt = rng.next() < TRIP_INJURY_CHANCE;
    events.push({ kind: 'trip', who, hurt });
    if (hurt) {
      const part = rng.next() < ANKLE_SHARE ? 'ankle' : 'knee';
      if (injure(state.conditions, who, part, 1)) events.push({ kind: 'injury', who, part, severity: 1, cause: 'fall' });
    }
  }

  // Injuries on rough climbs (by load band) and on wrack dams and landslips (by their risk), per person.
  if (s.movedM > 0) {
    const roughClimb = GROUND_FACTOR[s.groundType] < ROUGH_GROUND_FACTOR && s.grade >= ROUGH_CLIMB_GRADE;
    for (const p of party.people) {
      const band = loadRisk(party, p.id, p.bodyKg);
      const climb = roughClimb ? (band * s.movedM) / ROUGH_CLIMB_UNIT_M : 0;
      const crossing = s.hazards.injuryRisk * INJURY_PER_M_PER_RISK * s.movedM * (1 + LOAD_INJURY_GAIN * band);
      if (!hit(rng, 1 - (1 - climb) * (1 - crossing))) continue;
      const { part, severity } = rollInjury(rng);
      if (injure(state.conditions, p.id, part, severity)) {
        events.push({ kind: 'injury', who: p.id, part, severity, cause: crossing > climb ? 'wrack or landslip' : 'rough climb' });
      }
    }
  }

  // Soft patches: one roll on stepping in.
  const trap = s.hazards.trapRisk > 0;
  if (trap && !state.inTrap && hit(rng, s.hazards.trapRisk * STUCK_SCALE)) {
    const sec = STUCK_MIN_SEC + rng.next() * (STUCK_MAX_SEC - STUCK_MIN_SEC);
    lostSec += sec;
    for (const p of party.people) s.stamina[p.id] = Math.max(0, (s.stamina[p.id] ?? 1) - STUCK_STAMINA);
    events.push({ kind: 'stuck', sec });
  }
  state.inTrap = trap;

  // Gas: the dose builds in a hollow and clears slowly outside it.
  const min = s.dtSec / 60;
  const inGas = s.hazards.gas && gasActive(s.gameDays);
  let worst = 0;
  for (const p of party.people) {
    const d = state.gasDose[p.id] ?? 0;
    const next = inGas
      ? Math.min(1, d + GAS_DOSE_PER_MIN * (GAS_REF_KG / p.bodyKg) * min)
      : Math.max(0, d - GAS_CLEAR_PER_MIN * min);
    state.gasDose[p.id] = next;
    worst = Math.max(worst, next);
    if (next >= 1 && !state.collapsed) {
      state.collapsed = true;
      events.push({ kind: 'collapse', who: p.id });
    }
  }
  if (worst >= GAS_SERIOUS_DOSE && state.gasLevel < 2) {
    state.gasLevel = 2;
    events.push({ kind: 'gas', level: 'serious' });
  } else if (worst >= GAS_WARN_DOSE && state.gasLevel < 1) {
    state.gasLevel = 1;
    events.push({ kind: 'gas', level: 'warning' });
  } else if (worst < GAS_WARN_DOSE) state.gasLevel = 0;

  stepConditions(state.conditions, party, s.dtSec + lostSec, {
    waterDepth: s.hazards.waterDepth,
    sunAltitude: s.sunAltitude,
    walking: s.walking,
  });
  return { events, lostSec };
}

/** The highest gas dose in the party, 0 to 1. */
export function worstGasDose(state: HazardState): number {
  let w = 0;
  for (const d of Object.values(state.gasDose)) w = Math.max(w, d);
  return w;
}

/** How far the screen has faded to black from gas, 0 (clear) to 1 (out). */
export function gasFade(state: HazardState): number {
  if (state.collapsed) return 1;
  const d = worstGasDose(state);
  return d <= GAS_FADE_FROM ? 0 : Math.min(1, (d - GAS_FADE_FROM) / (1 - GAS_FADE_FROM));
}

/** HUD lines for the hazards. nearGas: an active gas hollow within GAS_CUE_REACH_M (for the insect cue). */
export function hazardLines(state: HazardState, nearGas: boolean): string[] {
  const lines: string[] = [];
  const d = worstGasDose(state);
  if (state.collapsed) lines.push('You have collapsed in the gas.');
  else if (d >= GAS_SERIOUS_DOSE) lines.push('Your head swims and your legs go. GET OUT OF THE HOLLOW NOW.');
  else if (d >= GAS_WARN_DOSE) lines.push('Your head aches and the air tastes sour. Get out of the hollow.');
  else if (nearGas) lines.push('No insects buzzing.');
  return lines;
}
