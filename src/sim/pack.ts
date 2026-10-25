import { getItem } from './items';

export interface PackEntry {
  itemId: string;
  qty: number;
  /** Id of the person carrying it. */
  carrier: string;
  /** Kept in a dry bag: safe when swimming. */
  sealed: boolean;
}

export type Pack = PackEntry[];

export function entryKg(e: PackEntry): number {
  return getItem(e.itemId).kg * e.qty;
}

/** Total kg carried by one person. */
export function carriedKg(pack: Pack, carrier: string): number {
  let kg = 0;
  for (const e of pack) if (e.carrier === carrier) kg += entryKg(e);
  return kg;
}

/** Adds to an existing matching entry for stackable items, else appends. */
export function addItem(pack: Pack, itemId: string, qty: number, carrier: string, sealed = false): void {
  if (getItem(itemId).stackable) {
    const hit = pack.find((e) => e.itemId === itemId && e.carrier === carrier && e.sealed === sealed);
    if (hit) {
      hit.qty += qty;
      return;
    }
  }
  pack.push({ itemId, qty, carrier, sealed });
}
