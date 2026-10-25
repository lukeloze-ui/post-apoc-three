import { describe, expect, it } from 'vitest';
import { ITEMS } from './items';
import { addItem, carriedKg, type Pack } from './pack';
import { bandEffects, defaultParty, loadBand, loadShare, partyPace } from './load';

describe('catalog weights', () => {
  it('matches the spec', () => {
    const kg = (id: string) => ITEMS[id].kg;
    expect(kg('camping_kit')).toBe(5.5);
    expect(kg('rifle_l403a1')).toBe(3.8);
    expect(kg('rifle_sa80a3')).toBe(4.9);
    expect(kg('magazine_30')).toBe(0.5);
    expect(kg('round')).toBe(0.012);
    expect(kg('air_rifle')).toBe(3);
    expect(kg('pellet_tin')).toBe(0.3);
    expect(kg('tin_food')).toBe(0.4);
    expect(kg('water')).toBe(1);
    expect(kg('gas_canister')).toBe(0.4);
    expect(kg('binoculars')).toBe(0.6);
    expect(kg('dry_bag')).toBe(0.1);
  });
});

describe('load bands', () => {
  it('child at 8 kg is normal, 8.1 kg is band 2', () => {
    expect(loadBand(loadShare(8, 40))).toBe(1);
    expect(loadBand(loadShare(8.1, 40))).toBe(2);
  });
  it('boundaries', () => {
    expect(loadBand(0.2)).toBe(1);
    expect(loadBand(0.3)).toBe(2);
    expect(loadBand(0.301)).toBe(3);
    expect(loadBand(0.4)).toBe(3);
    expect(loadBand(0.401)).toBe(4);
  });
  it('effects', () => {
    expect(bandEffects(1).paceFactor).toBe(1);
    expect(bandEffects(2).paceFactor).toBe(0.85);
    expect(bandEffects(3).paceFactor).toBe(0.65);
    expect(bandEffects(4).paceFactor).toBeCloseTo(0.35, 2);
    expect(bandEffects(4).restEveryMin).toBeGreaterThan(0);
  });
});

describe('pack and party', () => {
  it('sums per carrier', () => {
    const pack: Pack = [];
    addItem(pack, 'tin_food', 2, 'a');
    addItem(pack, 'tin_food', 3, 'a');
    addItem(pack, 'tin_food', 1, 'b');
    expect(pack).toHaveLength(2);
    expect(carriedKg(pack, 'a')).toBeCloseTo(2, 9);
  });
  it('default party starts in the normal band', () => {
    const { people, pack } = defaultParty();
    expect(partyPace(pack, people)).toBe(1);
  });
  it('party pace is the slower member', () => {
    const { people, pack } = defaultParty();
    addItem(pack, 'air_rifle', 1, 'child');
    expect(partyPace(pack, people)).toBe(0.85);
    addItem(pack, 'water', 3, 'child');
    expect(partyPace(pack, people)).toBe(0.65);
  });
});
