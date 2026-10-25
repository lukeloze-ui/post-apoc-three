// Damage rules (SX 02 "How the damage is laid out"): how likely a bridge is to have fallen and a road segment to be
// blocked. Build-time only: the districts step rolls these once with its own RNG and ships the result.
import type { BlockCause } from '../../../src/world/districts';
import { Band, type BandCode } from '../../../src/world/flood';
import type { Rng } from '../rng';

/** Bridge fall probability well above the mark, and the ceiling far below it. */
export const BRIDGE_FALL_MIN = 0.1;
export const BRIDGE_FALL_MAX = 0.95;
/** Logistic midpoint (metres below the mark) and scale: gives about 0.9 at 40 m below. */
const MID_M = 23;
const SCALE_M = 6;
/** Extra fall probability at the storm centre, thinning with distance. */
export const STORM_BUMP_MAX = 0.05;
const STORM_REACH_M = 4000;
const BRIDGE_FALL_CAP = 0.98;

/** A road this close to a wood (or inside one) counts as through it, metres. */
export const WOOD_NEAR_M = 20;

/** How a road segment sits against the woods: through one, beside one (within WOOD_NEAR_M), or in the open. */
export type WoodClass = 'in' | 'beside' | 'none';

/** Small extra fall chance on the storm's worst side: STORM_BUMP_MAX at the centre, fading over a few km. */
export function stormBump(distToCentreM: number): number {
  const r = distToCentreM / STORM_REACH_M;
  return STORM_BUMP_MAX * Math.exp(-r * r);
}

/** Probability that a bridge fell. depthBelowMark is hwAt - deckH (negative above the mark). */
export function bridgeFallProbability(depthBelowMark: number, bump = 0): number {
  const s = 1 / (1 + Math.exp(-(depthBelowMark - MID_M) / SCALE_M));
  return Math.min(BRIDGE_FALL_CAP, BRIDGE_FALL_MIN + (BRIDGE_FALL_MAX - BRIDGE_FALL_MIN) * s + bump);
}

/** One roll: true if the bridge fell. Always consumes one draw, so surviving bridges don't shift later rolls. */
export function bridgeFalls(rng: Rng, depthBelowMark: number, bump = 0): boolean {
  return rng.next() < bridgeFallProbability(depthBelowMark, bump);
}

/** Why a bridge stands or fell, for the reason field. */
export function bridgeReason(fell: boolean, depthBelowMark: number): string {
  return `${fell ? 'fell' : 'stood'}-${depthBelowMark > 0 ? 'below' : 'above'}-mark`;
}

/**
 * Probability that a road segment is blocked, and what blocks it. band is the deepest band along the segment.
 * Below the mark: 0.95 through or beside a wood, 0.5 in the open (0.65 on the strandline, where wrack piles up).
 * Above the mark: 0.35 through a wood, 0.03 on open ground. Ground under a trapped lake is always blocked.
 */
export function roadBlockRule(band: BandCode, wood: WoodClass): { p: number; cause: BlockCause } {
  if (band === Band.UnderWater) return { p: 1, cause: 'water' };
  if (band === Band.Above) {
    return wood === 'in' ? { p: 0.35, cause: 'fallenWood' } : { p: 0.03, cause: 'landslip' };
  }
  if (wood !== 'none') return { p: 0.95, cause: 'fallenWood' };
  return band === Band.Strandline ? { p: 0.65, cause: 'wrack' } : { p: 0.5, cause: 'silt' };
}

/** One roll for a road segment. Always consumes one draw. */
export function rollRoadBlock(rng: Rng, band: BandCode, wood: WoodClass): { blocked: boolean; cause: BlockCause | null } {
  const { p, cause } = roadBlockRule(band, wood);
  return rng.next() < p ? { blocked: true, cause } : { blocked: false, cause: null };
}
