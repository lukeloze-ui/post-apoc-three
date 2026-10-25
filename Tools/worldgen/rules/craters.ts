// Strike rules (SX 02 "How the damage is laid out"): crater sizes on a steep curve, density thinning from the storm
// centre, valley-floor relief for gas and standing water, and line of sight to a tor. Build-time only.
import { heightAt, type Terrain } from '../../../src/world/terrain';
import type { Rng } from '../rng';

/**
 * Crater sizes follow N(>D) proportional to D^-1.91: for each 50 m crater about 10 of 15 m and about 100 of 5 m.
 * (50/15)^1.91 = 9.9, (50/5)^1.91 = 81 (the spec's round 100).
 */
export const CRATER_SLOPE = 1.91;
/** District data holds craters from here up to CRATER_MAX_D; smaller ones belong to ground detail, metres across. */
export const CRATER_MIN_D = 15;
export const CRATER_MAX_D = 50;

/**
 * Fraction of craters with diameter at least d, among those between dMin and dMax (1 at dMin, 0 at dMax).
 * Reusable for ground detail with a smaller dMin.
 */
export function craterCumulative(d: number, dMin = CRATER_MIN_D, dMax = CRATER_MAX_D): number {
  const a = dMin ** -CRATER_SLOPE;
  const b = dMax ** -CRATER_SLOPE;
  const x = Math.min(dMax, Math.max(dMin, d)) ** -CRATER_SLOPE;
  return (x - b) / (a - b);
}

/** One crater diameter in [dMin, dMax) metres, drawn from the truncated power law (inverse-CDF). Uses one draw. */
export function craterDiameter(rng: Rng, dMin = CRATER_MIN_D, dMax = CRATER_MAX_D): number {
  const a = dMin ** -CRATER_SLOPE;
  const b = dMax ** -CRATER_SLOPE;
  return (a - rng.next() * (a - b)) ** (-1 / CRATER_SLOPE);
}

/** Craters of CRATER_MIN_D and up per tile at the storm centre; thins with strikeDensity. */
export const PEAK_CRATERS_PER_TILE = 30;
/** Ground detail holds craters from here up to CRATER_MIN_D, metres across. */
export const GROUND_CRATER_MIN_D = 5;

/** Small ground craters (GROUND_CRATER_MIN_D up to CRATER_MIN_D) expected per district crater (CRATER_MIN_D up to CRATER_MAX_D). */
export function smallCratersPerDistrictCrater(): number {
  const large = craterCumulative(CRATER_MIN_D, GROUND_CRATER_MIN_D, CRATER_MAX_D);
  return (1 - large) / large;
}

/** Strike density at the storm centre relative to its far-field floor, and how far the worst of it reaches, metres. */
export const STRIKE_FLOOR = 0.05;
export const STRIKE_REACH_M = 3500;

/** Relative strike density, 1 at the storm centre falling to STRIKE_FLOOR far away. Craters and pocked ground share it. */
export function strikeDensity(distToCentreM: number): number {
  const r = distToCentreM / STRIKE_REACH_M;
  return STRIKE_FLOOR + (1 - STRIKE_FLOOR) * Math.exp(-r * r);
}

/** Poisson deviate (Knuth) for a small mean. */
export function poisson(rng: Rng, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > limit);
  return k - 1;
}

/** Height at (x, y) minus the mean height over the 500 m neighbourhood (8 samples at 250 m, 16 at 500 m). Negative on a valley floor. */
export function reliefAt(t: Terrain, x: number, y: number): number {
  let sum = 0;
  let n = 0;
  for (const [radius, count] of [[250, 8], [500, 16]] as const) {
    for (let k = 0; k < count; k++) {
      const a = (2 * Math.PI * k) / count;
      sum += heightAt(t, x + radius * Math.cos(a), y + radius * Math.sin(a));
      n++;
    }
  }
  return heightAt(t, x, y) - sum / n;
}

/** True if a point plumeM above (tx, ty) can be seen from eyeM above (fx, fy): no terrain above the sight line. */
export function canSee(t: Terrain, fx: number, fy: number, eyeM: number, tx: number, ty: number, plumeM: number): boolean {
  const h0 = heightAt(t, fx, fy) + eyeM;
  const h1 = heightAt(t, tx, ty) + plumeM;
  const L = Math.hypot(tx - fx, ty - fy);
  const steps = Math.max(1, Math.ceil(L / 25));
  for (let k = 1; k < steps; k++) {
    const f = k / steps;
    if (heightAt(t, fx + (tx - fx) * f, fy + (ty - fy) * f) > h0 + (h1 - h0) * f) return false;
  }
  return true;
}
