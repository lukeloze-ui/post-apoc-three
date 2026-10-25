import { describe, expect, it } from 'vitest';
import { decodeGround, type GroundFile } from '../world/ground';
import { tileId } from '../world/terrain';
import { SaveGame, type SaveStorage } from './save';
import {
  addToGround,
  applyDeltas,
  emptyGroundDeltas,
  forceDoor,
  parseGroundDeltas,
  registerGroundSection,
  takeFromGround,
} from './groundDeltas';

const T = tileId(2, 2);
const file: GroundFile = {
  v: 1,
  tile: T,
  kinds: ['tin_pile', 'house_spot', 'door'],
  o: [
    [0, 100, 100, 0, 5],
    [1, 200, 200, 0, 80],
    [2, 300, 300, 0, 9],
  ],
  loot: [{ obj: 1, building: 'b-1', items: [['tin_food', 4, 0], ['water', 2, 1]] }],
  doors: [{ obj: 2, building: 'b-1', locked: true }],
};

describe('ground deltas', () => {
  it('hides taken items, forces doors and shows added carcasses', () => {
    const base = decodeGround(file);
    const d = emptyGroundDeltas();
    takeFromGround(d, `${T}:0`);
    takeFromGround(d, `${T}:1`, { index: 0, qty: 3 });
    takeFromGround(d, `${T}:1`, { index: 1, qty: 2 });
    forceDoor(d, `${T}:2`);
    const carcass = addToGround(d, T, { kind: 'carcass', x: 2100, y: 2100, rot: 0, size: 1.2, extra: 1 });
    expect(carcass.key).toBe(`${T}:+0`);

    const eff = applyDeltas(base, d);
    expect(eff.objects.map((o) => o.key)).toEqual([`${T}:1`, `${T}:2`, `${T}:+0`]);
    expect(eff.objects.find((o) => o.kind === 'carcass')).toMatchObject({ x: 2100, y: 2100 });
    expect(eff.loot).toEqual([{ obj: `${T}:1`, building: 'b-1', items: [{ itemId: 'tin_food', qty: 1, buried: false }] }]);
    expect(eff.doors[0]!.locked).toBe(false);
    // The base tile is untouched, and another tile sees no carcass.
    expect(base.objects).toHaveLength(3);
    expect(base.doors[0]!.locked).toBe(true);
    expect(applyDeltas(decodeGround({ ...file, tile: tileId(0, 0) }), d).objects).toHaveLength(3);
  });

  it('saves only the deltas and loads them back', () => {
    const mem = new Map<string, string>();
    const storage: SaveStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
    const d = emptyGroundDeltas();
    takeFromGround(d, `${T}:1`, { index: 0, qty: 1 });
    addToGround(d, T, { kind: 'carcass', x: 1, y: 2, rot: 0, size: 1 });
    const a = new SaveGame({ storage });
    registerGroundSection(a, d);
    a.save();
    const back = emptyGroundDeltas();
    registerGroundSection(new SaveGame({ storage }), back);
    expect(back).toEqual(d);
    expect(parseGroundDeltas({ taken: { x: 'bad' }, forced: [1], added: { [T]: [{ kind: 'x' }] } })).toEqual(emptyGroundDeltas());
  });
});
