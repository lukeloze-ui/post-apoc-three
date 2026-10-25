// Naismith's rule for planning a leg on the map: 5 km an hour, plus 1 hour for every 600 m of climbing.
// Slowed by the party's pace (load bands, slowest member). Pure: heights come in as a function.
import { partyPace, type Party } from './load';

export const NAISMITH_KMH = 5;
export const NAISMITH_CLIMB_M_PER_HOUR = 600;
/** Spacing of height samples along a leg, metres. */
export const LEG_SAMPLE_M = 25;

export interface LegPoint {
  x: number;
  y: number;
}

export interface LegProfile {
  km: number;
  ascentM: number;
  descentM: number;
}

export type HeightFn = (x: number, y: number) => number;

/** Hours to walk km with ascentM of climbing at an unladen pace. Descent adds nothing. */
export function naismithHours(km: number, ascentM: number): number {
  return km / NAISMITH_KMH + Math.max(0, ascentM) / NAISMITH_CLIMB_M_PER_HOUR;
}

/** Length, total rises and total falls along the polyline, sampled every LEG_SAMPLE_M. */
export function legProfile(points: readonly LegPoint[], heightAt: HeightFn): LegProfile {
  let lengthM = 0;
  let ascentM = 0;
  let descentM = 0;
  let prev: number | undefined;
  const step = (h: number): void => {
    if (prev !== undefined) {
      if (h > prev) ascentM += h - prev;
      else descentM += prev - h;
    }
    prev = h;
  };
  for (let i = 0; i < points.length; i++) {
    const b = points[i]!;
    if (i === 0) {
      step(heightAt(b.x, b.y));
      continue;
    }
    const a = points[i - 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    lengthM += len;
    const n = Math.max(1, Math.ceil(len / LEG_SAMPLE_M));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      step(heightAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    }
  }
  return { km: lengthM / 1000, ascentM, descentM };
}

/** Planned hours for the leg: Naismith divided by the slowest member's pace factor. */
export function plannedLegHours(points: readonly LegPoint[], heightAt: HeightFn, party: Party): number {
  const p = legProfile(points, heightAt);
  return naismithHours(p.km, p.ascentM) / partyPace(party.pack, party.people);
}

/** "h:mm", rounded to the nearest minute. */
export function formatHours(hours: number): string {
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** e.g. "3.2 km, up 180 m, plan 0:58". */
export function legLabel(points: readonly LegPoint[], heightAt: HeightFn, party: Party): string {
  const p = legProfile(points, heightAt);
  const hours = naismithHours(p.km, p.ascentM) / partyPace(party.pack, party.people);
  return `${p.km.toFixed(1)} km, up ${Math.round(p.ascentM)} m, plan ${formatHours(hours)}`;
}
