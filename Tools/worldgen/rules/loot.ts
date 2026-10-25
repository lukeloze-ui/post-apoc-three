// Loot tables (SX 01 Days 2 to 4, SX 03 bands): what a building holds by type, and how the bands change where it is.
// Above the mark loot sits intact in standing buildings; in the strandline it is scattered sealed tins in the wrack;
// in the scour zone it is buried in foundations and cellars. Build-time only.
import type { BuildingType } from '../../../src/world/features';
import type { GroundItemRow } from '../../../src/world/ground';
import type { Rng } from '../rng';

/** A scour-zone building's loot is less likely and smaller by this factor. */
export const SCOUR_LOOT_SCALE = 0.6;
/** Types that never hold loot. */
export const NO_LOOT_TYPES: ReadonlySet<string> = new Set(['church', 'other']);

const between = (rng: Rng, lo: number, hi: number, p = 1): number => (rng.next() < p ? rng.int(lo, hi) : 0);

/** Items a building of this type holds when intact. `scale` thins the chances and amounts (scour: SCOUR_LOOT_SCALE). */
export function rollBuildingLoot(rng: Rng, type: BuildingType | string, scale = 1): [string, number][] {
  const out: [string, number][] = [];
  const add = (id: string, qty: number): void => {
    if (qty > 0) out.push([id, qty]);
  };
  const q = (lo: number, hi: number, p = 1): number => {
    const n = between(rng, lo, hi, p * scale);
    return n > 0 ? Math.max(1, Math.round(n * scale)) : 0;
  };
  switch (type) {
    case 'house':
      add('tin_food', q(1, 6, 0.6));
      add('water', q(1, 3, 0.35));
      add('gas_canister', q(1, 2, 0.12));
      break;
    case 'farm':
      add('tin_food', q(2, 5, 0.7));
      add('spade', q(1, 1, 0.4));
      add('hatchet', q(1, 1, 0.3));
      add('crowbar', q(1, 1, 0.15));
      add('water', q(1, 4, 0.4));
      break;
    case 'shop':
      add('tin_food', q(8, 25, 0.9));
      add('water', q(2, 8, 0.7));
      add('gas_canister', q(1, 3, 0.3));
      break;
    case 'pub':
      add('tin_food', q(3, 8, 0.8));
      add('water', q(1, 4, 0.6));
      break;
    case 'school':
      add('tin_food', q(2, 6, 0.5));
      add('water', q(1, 3, 0.4));
      break;
    case 'industrial':
      add('spade', q(1, 1, 0.3));
      add('crowbar', q(1, 1, 0.3));
      add('hatchet', q(1, 1, 0.2));
      add('gas_canister', q(1, 2, 0.25));
      break;
    case 'military':
      add('camping_kit', q(1, 1, 0.3));
      add('tin_food', q(3, 10, 0.7));
      add('water', q(2, 6, 0.5));
      add('binoculars', q(1, 1, 0.12));
      add('dry_bag', q(1, 1, 0.2));
      add('spade', q(1, 1, 0.2));
      break;
    default:
      break;
  }
  return out;
}

/** Sealed tins scattered in a strandline wrack pile: most piles hold none, a few hold several. */
export function rollWrackLoot(rng: Rng, urban: number): GroundItemRow[] {
  if (rng.next() >= 0.15 + 0.4 * urban) return [];
  return [['tin_food', rng.int(2, 6), 0]];
}
