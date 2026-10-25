// How each person is doing (SX 05): injuries, wetness and exposure. Pure state and step functions; no three, no DOM.
// Times are game seconds. hazards.ts decides when someone is hurt; this file says what that does to the party.
import type { Party } from './load';

export type InjuryPart = 'ankle' | 'knee';
/** 1 = a sprain or bruise, 2 = a bad strain, 3 = a tear or hairline fracture. */
export type InjurySeverity = 1 | 2 | 3;

export interface Injury {
  part: InjuryPart;
  severity: InjurySeverity;
  /** Game seconds the injury takes to heal in all, and what is still to go. */
  healSec: number;
  leftSec: number;
}

/** Pace multiplier for the injured walker by severity; the party moves at its slowest member. */
export const INJURY_PACE: Record<InjurySeverity, number> = { 1: 0.8, 2: 0.55, 3: 0.3 };
/** Hours to heal by severity, and a knee takes this much longer than an ankle. */
export const INJURY_HEAL_HOURS: Record<InjurySeverity, number> = { 1: 12, 2: 48, 3: 120 };
export const KNEE_HEAL_FACTOR = 1.5;
/** Healing runs this many times faster while the person rests (not walking). */
export const REST_HEAL_FACTOR = 2;
/** Fatigue multiplier on the injured walker's effort share: walking hurt is tiring. */
export const INJURY_EFFORT: Record<InjurySeverity, number> = { 1: 1.1, 2: 1.3, 3: 1.6 };

/** Wetness is 0 (dry) to 1 (soaked). Per game hour. */
export const WET_SHALLOW_PER_HOUR = 1.5;
export const WET_DEEP_PER_HOUR = 20;
export const DRY_PER_HOUR = 0.25;
export const DRY_PER_HOUR_SUN = 0.5;
/** Exposure is 0 (fine) to 1 (hypothermic). Wet and cold builds it, being dry and warm clears it. */
export const EXPOSURE_COLD_PER_HOUR = 0.25;
export const EXPOSURE_NIGHT_PER_HOUR = 0.1;
export const EXPOSURE_RECOVER_PER_HOUR = 0.2;
/** Wetness below this does not chill. */
export const CHILL_WETNESS = 0.3;
/** Exposure above this slows the walker, down to EXPOSURE_MIN_PACE at 1. */
export const EXPOSURE_SLOWS_ABOVE = 0.4;
export const EXPOSURE_MIN_PACE = 0.5;
/** Sun altitude, degrees, above which things dry faster; below DARK_SUN_DEG it is dark (also in hazards.ts). */
export const DRYING_SUN_DEG = 15;

export interface PersonCondition {
  injury?: Injury;
  wetness: number;
  exposure: number;
}

/** Per-person condition. A missing person is well. */
export type ConditionMap = Record<string, PersonCondition>;

export function newConditions(party: Party): ConditionMap {
  const m: ConditionMap = {};
  for (const p of party.people) m[p.id] = { wetness: 0, exposure: 0 };
  return m;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function of(map: ConditionMap, id: string): PersonCondition {
  return (map[id] ??= { wetness: 0, exposure: 0 });
}

export function healSecFor(part: InjuryPart, severity: InjurySeverity): number {
  return INJURY_HEAL_HOURS[severity] * 3600 * (part === 'knee' ? KNEE_HEAL_FACTOR : 1);
}

/** Hurt someone. An existing injury is only replaced by a worse one; an equal one is not restarted. */
export function injure(map: ConditionMap, id: string, part: InjuryPart, severity: InjurySeverity): Injury | undefined {
  const c = of(map, id);
  if (c.injury && c.injury.severity >= severity) return undefined;
  const healSec = healSecFor(part, severity);
  c.injury = { part, severity, healSec, leftSec: healSec };
  return c.injury;
}

/** The walker's own pace multiplier from injury and exposure, 1 when well. */
export function personPace(c: PersonCondition | undefined): number {
  if (!c) return 1;
  let pace = c.injury ? INJURY_PACE[c.injury.severity] : 1;
  if (c.exposure > EXPOSURE_SLOWS_ABOVE) {
    const t = (c.exposure - EXPOSURE_SLOWS_ABOVE) / (1 - EXPOSURE_SLOWS_ABOVE);
    pace *= 1 - (1 - EXPOSURE_MIN_PACE) * Math.min(1, t);
  }
  return pace;
}

/** The party moves at its slowest member's pace. Feeds walking.ts as part of extraFactor. */
export function partyConditionPace(map: ConditionMap, party: Party): number {
  let pace = 1;
  for (const p of party.people) pace = Math.min(pace, personPace(map[p.id]));
  return pace;
}

/** Extra fatigue (walking.ts extraEffort) from walking hurt: the worst injured member's multiplier. */
export function partyConditionEffort(map: ConditionMap, party: Party): number {
  let e = 1;
  for (const p of party.people) {
    const inj = map[p.id]?.injury;
    if (inj) e = Math.max(e, INJURY_EFFORT[inj.severity]);
  }
  return e;
}

export interface ConditionEnv {
  /** Metres of standing water the party is in; 0 when dry. */
  waterDepth: number;
  /** Degrees above the horizon (negative at night). */
  sunAltitude: number;
  /** True while the party is walking; false when resting or standing still. */
  walking: boolean;
}

/** Depth from which a person is wet through at the deep rate. */
export const DEEP_WATER_M = 0.5;

/** Advance injuries (they heal), wetness and exposure by dtSec. */
export function stepConditions(map: ConditionMap, party: Party, dtSec: number, env: ConditionEnv): void {
  const h = dtSec / 3600;
  for (const p of party.people) {
    const c = of(map, p.id);
    if (c.injury) {
      c.injury.leftSec -= dtSec * (env.walking ? 1 : REST_HEAL_FACTOR);
      if (c.injury.leftSec <= 0) c.injury = undefined;
    }
    if (env.waterDepth > 0) {
      c.wetness = clamp01(c.wetness + (env.waterDepth >= DEEP_WATER_M ? WET_DEEP_PER_HOUR : WET_SHALLOW_PER_HOUR) * h);
    } else {
      c.wetness = clamp01(c.wetness - (env.sunAltitude > DRYING_SUN_DEG ? DRY_PER_HOUR_SUN : DRY_PER_HOUR) * h);
    }
    const chilled = c.wetness > CHILL_WETNESS;
    if (chilled) {
      const night = env.sunAltitude < 0 ? EXPOSURE_NIGHT_PER_HOUR : 0;
      c.exposure = clamp01(c.exposure + (EXPOSURE_COLD_PER_HOUR * c.wetness + night) * h);
    } else {
      c.exposure = clamp01(c.exposure - EXPOSURE_RECOVER_PER_HOUR * h);
    }
  }
}

/** HUD text for one person's condition, or '' when well. */
export function conditionText(c: PersonCondition | undefined): string {
  if (!c) return '';
  const bits: string[] = [];
  if (c.injury) {
    const word = ['', 'sprained', 'badly strained', 'badly hurt'][c.injury.severity];
    const left = Math.ceil(c.injury.leftSec / 3600);
    bits.push(`${word} ${c.injury.part}, ${left >= 48 ? `${Math.round(left / 24)} d` : `${left} h`} to heal`);
  }
  if (c.exposure > EXPOSURE_SLOWS_ABOVE) bits.push('shivering');
  else if (c.wetness > CHILL_WETNESS) bits.push('wet');
  return bits.join(', ');
}
