/** Item catalog. Weights from spec SX 05. */

export interface ItemDef {
  id: string;
  name: string;
  /** Mass of one unit in kg. */
  kg: number;
  /** True when several units share one pack entry. */
  stackable: boolean;
  notes: string;
}

const defs: ItemDef[] = [
  { id: 'camping_kit', name: 'Camping kit', kg: 5.5, stackable: false, notes: 'Bivvy, quilt, mat, pack, stove share, knife, first aid, merino spare. One each.' },
  { id: 'rifle_l403a1', name: 'L403A1 rifle', kg: 3.8, stackable: false, notes: 'AR-15 pattern service rifle.' },
  { id: 'rifle_sa80a3', name: 'SA80 A3 rifle', kg: 4.9, stackable: false, notes: 'Service rifle, heavier with sight.' },
  { id: 'magazine_30', name: 'Loaded 30-round magazine', kg: 0.5, stackable: true, notes: 'Each shot is about 12 g.' },
  { id: 'round', name: 'Rifle round', kg: 0.012, stackable: true, notes: 'Loose round.' },
  { id: 'air_rifle', name: '.22 air rifle', kg: 3, stackable: false, notes: 'Quiet; ammunition is never the limit.' },
  { id: 'pellet_tin', name: 'Tin of 500 pellets', kg: 0.3, stackable: true, notes: 'A full tin lasts most of a game.' },
  { id: 'tin_food', name: 'Tin of food', kg: 0.4, stackable: true, notes: '300 to 450 kcal; mostly water.' },
  { id: 'dried_meat', name: 'Smoked or dried meat', kg: 1, stackable: true, notes: 'Quantity is in kg. About three times the calories of fresh meat per kilo.' },
  { id: 'water', name: 'Water', kg: 1, stackable: true, notes: 'Quantity is in litres, 1 kg each.' },
  { id: 'gas_canister', name: 'Gas canister', kg: 0.4, stackable: true, notes: '230 g canister. Boils about 20 litres. Cannot be refilled.' },
  { id: 'spade', name: 'Spade', kg: 1.4, stackable: false, notes: 'Digs out buried loot. No spec weight; assumed.' },
  { id: 'hatchet', name: 'Hatchet', kg: 0.8, stackable: false, notes: 'Chops wood and forces doors. No spec weight; assumed.' },
  { id: 'crowbar', name: 'Crowbar', kg: 1.6, stackable: false, notes: 'Forces doors and shifts debris. No spec weight; assumed.' },
  { id: 'binoculars', name: 'Binoculars', kg: 0.6, stackable: false, notes: 'Needed for the scope.' },
  { id: 'dry_bag', name: 'Dry bag', kg: 0.1, stackable: false, notes: 'Marks contents as sealed, for swimming.' },
];

export const ITEMS: Readonly<Record<string, ItemDef>> = Object.fromEntries(defs.map((d) => [d.id, d]));

export function getItem(id: string): ItemDef {
  const d = ITEMS[id];
  if (!d) throw new Error(`unknown item: ${id}`);
  return d;
}
