import { addItem, carriedKg, type Pack } from './pack';

export type LoadBand = 1 | 2 | 3 | 4;

export interface Person {
  id: string;
  name: string;
  bodyKg: number;
}

export interface BandEffects {
  /** Effective speed multiplier, rests included. */
  paceFactor: number;
  /** Fatigue accumulation multiplier. */
  fatigueRate: number;
  /** Chance of ankle/knee injury per climb of rough ground. */
  injuryRiskOnRoughClimb: number;
  /** Minutes of walking between rests; 0 means no forced rests. */
  restEveryMin: number;
}

/** Walk/rest cycle for band 4: walk 20 min at 0.65, rest 17 min: 0.65*20/37 ~ 0.35. */
export const HOP_WALK_MIN = 20;
export const HOP_REST_MIN = 17;
export const HOP_WALK_PACE = 0.65;

export function loadShare(carriedKg: number, bodyKg: number): number {
  return carriedKg / bodyKg;
}

export function loadBand(share: number): LoadBand {
  // Small epsilon so 8 kg / 40 kg stays in band 1 despite float error.
  const e = 1e-9;
  if (share <= 0.2 + e) return 1;
  if (share <= 0.3 + e) return 2;
  if (share <= 0.4 + e) return 3;
  return 4;
}

export function bandEffects(band: LoadBand): BandEffects {
  switch (band) {
    case 1:
      return { paceFactor: 1, fatigueRate: 1, injuryRiskOnRoughClimb: 0, restEveryMin: 0 };
    case 2:
      return { paceFactor: 0.85, fatigueRate: 1.5, injuryRiskOnRoughClimb: 0.002, restEveryMin: 0 };
    case 3:
      return { paceFactor: 0.65, fatigueRate: 2, injuryRiskOnRoughClimb: 0.01, restEveryMin: 0 };
    case 4:
      return {
        paceFactor: (HOP_WALK_PACE * HOP_WALK_MIN) / (HOP_WALK_MIN + HOP_REST_MIN),
        fatigueRate: 3,
        injuryRiskOnRoughClimb: 0.03,
        restEveryMin: HOP_WALK_MIN,
      };
  }
}

export function personEffects(pack: Pack, p: Person): BandEffects {
  return bandEffects(loadBand(loadShare(carriedKg(pack, p.id), p.bodyKg)));
}

/** The party moves at the slowest member's pace. */
export function partyPace(pack: Pack, people: Person[]): number {
  let pace = 1;
  for (const p of people) pace = Math.min(pace, personEffects(pack, p).paceFactor);
  return pace;
}

export interface Party {
  people: Person[];
  pack: Pack;
}

export function defaultParty(): Party {
  const people: Person[] = [
    { id: 'parent', name: 'Parent', bodyKg: 75 },
    { id: 'child', name: 'Child', bodyKg: 40 },
  ];
  const pack: Pack = [];
  for (const p of people) {
    addItem(pack, 'camping_kit', 1, p.id);
    addItem(pack, 'water', 2, p.id);
  }
  // Child stays under 8 kg (20%): kit 5.5 + water 2 = 7.5 kg, plus 0.4 for one tin = 7.9 kg.
  addItem(pack, 'tin_food', 1, 'child');
  addItem(pack, 'tin_food', 3, 'parent');
  addItem(pack, 'gas_canister', 1, 'parent');
  addItem(pack, 'binoculars', 1, 'parent');
  return { people, pack };
}
