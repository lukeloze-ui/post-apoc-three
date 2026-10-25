import { describe, expect, it } from 'vitest';
import { addItem } from './pack';
import { defaultParty } from './load';
import { NORMAL_FOV_DEG, RAISE_SEC, SCOPED_PACE, Scope, sensitivityScale } from './scope';

describe('scope', () => {
  it('raises binoculars from the pack over a short time, to about 6 degrees', () => {
    const scope = new Scope(defaultParty().pack);
    scope.setBinoculars(true);
    scope.update(RAISE_SEC / 2);
    expect(scope.scoped).toBe(false);
    scope.update(RAISE_SEC);
    expect(scope.scoped).toBe(true);
    expect(scope.fov).toBe(6);
    expect(scope.pace).toBe(SCOPED_PACE);
    scope.setBinoculars(false);
    scope.update(RAISE_SEC);
    expect(scope.fov).toBe(NORMAL_FOV_DEG);
  });
  it('does nothing without binoculars, and the rifle needs a sight', () => {
    const party = defaultParty();
    party.pack.splice(0, party.pack.length);
    const scope = new Scope(party.pack);
    scope.setBinoculars(true);
    scope.toggleRifle();
    scope.update(1);
    expect(scope.scoped).toBe(false);
    addItem(party.pack, 'rifle_sa80a3', 1, 'parent');
    scope.update(1);
    expect(scope.scoped).toBe(true);
    expect(scope.fov).toBe(4);
  });
  it('scales sensitivity to the field of view', () => {
    expect(sensitivityScale(NORMAL_FOV_DEG)).toBeCloseTo(1, 8);
    expect(sensitivityScale(6)).toBeLessThan(0.1);
  });
});
