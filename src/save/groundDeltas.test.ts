import { describe, expect, it } from 'vitest';
import { decodeGround, type GroundFile } from '../world/ground';
import { TILE_M, tileId } from '../world/terrain';
import { BARE_HANDS_FACTOR, FORCE_MIN, findTarget, perform, promptText } from '../sim/groundInteract';
import { defaultParty, loadShare, type Party } from '../sim/load';
import { addItem, carriedKg } from '../sim/pack';
import { newWalkState } from '../sim/walking';
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
  kinds: ['tin_pile', 'spot', 'door'],
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

describe('searching, digging and forcing', () => {
  const mem = new Map<string, string>();
  const storage: SaveStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  const O = 2 * TILE_M;
  const kgOf = (party: Party, id: string): number => carriedKg(party.pack, id);

  it('takes items into the lighter carrier and keeps them gone after reloading the tile and the save', () => {
    const party = defaultParty();
    const walk = newWalkState(party);
    const d = emptyGroundDeltas();
    const tile = decodeGround(file);
    // The door is at (30, 30) m and the house (20, 20) m wide 8 m. Locked, the house cannot be searched.
    expect(findTarget([tile], d, party, O + 20, O + 25, 180)).toBeUndefined();
    expect(findTarget([tile], d, party, O + 30, O + 40, 0)).toBeUndefined();
    expect(findTarget([tile], d, party, O + 30, O + 40, 180)).toBeUndefined();

    const door = findTarget([tile], d, party, O + 30, O + 28, 0)!;
    expect(door).toMatchObject({ kind: 'force', minutes: FORCE_MIN * BARE_HANDS_FACTOR });
    expect(promptText(door)).toContain('door');
    const staminaBefore = walk.stamina.parent!;
    expect(perform(door, d, party, walk).minutes).toBe(door.minutes);
    expect(walk.stamina.parent!).toBeLessThan(staminaBefore);
    expect(d.forced).toEqual([`${T}:2`]);

    const lighter = loadShare(kgOf(party, 'parent'), 75) < loadShare(kgOf(party, 'child'), 40) ? 'parent' : 'child';
    const house = findTarget([tile], d, party, O + 20, O + 26, 180)!;
    expect(house).toMatchObject({ kind: 'search', minutes: 10 });
    const tinsBefore = party.pack.filter((e) => e.itemId === 'tin_food').reduce((n, e) => n + e.qty, 0);
    const got = perform(house, d, party, walk);
    expect(got.found.reduce((n, f) => n + f.qty, 0)).toBe(4);
    expect(got.found[0]!.carrier).toBe(lighter);
    expect(party.pack.filter((e) => e.itemId === 'tin_food').reduce((n, e) => n + e.qty, 0)).toBe(tinsBefore + 4);

    // Only the buried water is left, and it needs a spade.
    const buried = findTarget([tile], d, party, O + 20, O + 26, 180)!;
    expect(buried).toMatchObject({ kind: 'dig', minutes: 30, blocked: 'needs a spade' });
    expect(perform(buried, d, party, walk).minutes).toBe(0);
    addItem(party.pack, 'spade', 1, 'parent');
    const dug = findTarget([tile], d, party, O + 20, O + 26, 180)!;
    expect(dug.blocked).toBeUndefined();
    expect(perform(dug, d, party, walk).found).toEqual([{ itemId: 'water', qty: 2, carrier: expect.any(String) }]);
    expect(findTarget([tile], d, party, O + 20, O + 26, 180)).toBeUndefined();

    // Save, then load into fresh deltas and a freshly decoded tile: the loot is still gone and the door still forced.
    const a = new SaveGame({ storage });
    registerGroundSection(a, d);
    a.save();
    const back = emptyGroundDeltas();
    registerGroundSection(new SaveGame({ storage }), back);
    const reloaded = decodeGround(file);
    expect(findTarget([reloaded], back, party, O + 20, O + 26, 180)).toBeUndefined();
    const eff = applyDeltas(reloaded, back);
    expect(eff.loot).toEqual([]);
    expect(eff.doors[0]!.locked).toBe(false);
  });

  it('only counts what is within 3 m of the edge and in front', () => {
    const party = defaultParty();
    const tile = decodeGround(file);
    const d = emptyGroundDeltas();
    forceDoor(d, `${T}:2`);
    expect(findTarget([tile], d, party, O + 20, O + 26, 180)).toBeDefined();
    expect(findTarget([tile], d, party, O + 20, O + 26, 0)).toBeUndefined();
    expect(findTarget([tile], d, party, O + 20, O + 30, 180)).toBeUndefined();
  });
});
