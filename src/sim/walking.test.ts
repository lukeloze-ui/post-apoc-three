import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { START, YES_TOR, heightAt, parseTerrain, type TerrainMeta } from '../world/terrain';
import { addItem } from './pack';
import { defaultParty, loadBand, loadShare, personEffects, type Party } from './load';
import {
  BASE_SPEED_KMH,
  newWalkState,
  simulateDay,
  slopeFactor,
  speedMs,
  staminaFactor,
  stepWalk,
  type ProfileSegment,
} from './walking';

const gentle = (ground: ProfileSegment['ground']): ProfileSegment[] => [
  { ground, grade: 0.03, lengthM: 300 },
  { ground, grade: -0.03, lengthM: 300 },
  { ground, grade: 0, lengthM: 400 },
];

/** Default party with extra water on the parent so they land in the given load band. */
function loadedParty(parentKg: number): Party {
  const party = defaultParty();
  addItem(party.pack, 'water', parentKg, 'parent');
  return party;
}

describe('speedMs', () => {
  it('is 5 km/h on flat road for the default party', () => {
    expect(speedMs('road', 0, defaultParty()) * 3.6).toBeCloseTo(BASE_SPEED_KMH, 5);
  });
  it('scales by ground type and the extra factor', () => {
    const p = defaultParty();
    expect(speedMs('debris', 0, p)).toBeCloseTo(speedMs('road', 0, p) * 0.4, 8);
    expect(speedMs('road', 0, p, 0.5)).toBeCloseTo(speedMs('road', 0, p) * 0.5, 8);
  });
  it('is slower climbing 15% than on the flat, and slower on steep descent than gentle descent', () => {
    const p = defaultParty();
    expect(speedMs('path', 0.15, p)).toBeLessThan(speedMs('path', 0, p) * 0.7);
    expect(speedMs('path', -0.35, p)).toBeLessThan(speedMs('path', -0.05, p) * 0.6);
  });
  it('slopeFactor is 1 on the flat', () => {
    expect(slopeFactor(0)).toBeCloseTo(1, 8);
  });
});

describe('stamina', () => {
  it('drains while walking, recovers while resting, and slows pace when low', () => {
    const party = defaultParty();
    const state = newWalkState(party);
    for (let i = 0; i < 60; i++) stepWalk(state, party, 'road', 0.1, 30);
    expect(state.stamina.parent!).toBeLessThan(1);
    const low = state.stamina.parent!;
    state.restLeftSec = 600;
    stepWalk(state, party, 'road', 0, 300);
    expect(state.stamina.parent!).toBeGreaterThan(low);
    expect(staminaFactor(0.1)).toBe(0.7);
    expect(staminaFactor(1)).toBe(1);
    expect(speedMs('road', 0, party, 1, { parent: 0.1, child: 0.1 })).toBeCloseTo(speedMs('road', 0, party) * 0.7, 8);
  });
  it('drains faster under a heavier load', () => {
    const light = defaultParty();
    const heavy = loadedParty(8);
    const a = newWalkState(light);
    const b = newWalkState(heavy);
    stepWalk(a, light, 'road', 0, 600);
    stepWalk(b, heavy, 'road', 0, 600);
    expect(b.stamina.parent!).toBeLessThan(a.stamina.parent!);
  });
});

describe('climbing to look', () => {
  it('walking from the start to the Yes Tor summit on a path costs at least 20 game minutes and real stamina', () => {
    const dir = 'public/world/';
    const meta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
    const terrain = parseTerrain(meta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
    const party = defaultParty();
    const state = newWalkState(party);
    const total = Math.hypot(YES_TOR.x - START.x, YES_TOR.y - START.y);
    const ux = (YES_TOR.x - START.x) / total;
    const uy = (YES_TOR.y - START.y) / total;
    expect(heightAt(terrain, YES_TOR.x, YES_TOR.y) - heightAt(terrain, START.x, START.y)).toBeGreaterThan(100);
    let along = 0;
    let sec = 0;
    const dt = 5;
    while (along < total && sec < 6 * 3600) {
      const h = (d: number): number => heightAt(terrain, START.x + ux * d, START.y + uy * d);
      const grade = (h(along + 3) - h(Math.max(0, along - 3))) / 6;
      along += stepWalk(state, party, 'path', grade, dt);
      sec += dt;
    }
    expect(along).toBeGreaterThanOrEqual(total);
    expect(sec / 60).toBeGreaterThanOrEqual(20);
    expect(1 - state.stamina.parent!).toBeGreaterThan(0.05);
  });
});

describe('simulateDay', () => {
  it('covers 15-25 km on paths at normal load', () => {
    const km = simulateDay(gentle('path'), defaultParty());
    expect(km).toBeGreaterThanOrEqual(15);
    expect(km).toBeLessThanOrEqual(25);
  });
  it('covers 5-10 km through debris', () => {
    const km = simulateDay(gentle('debris'), defaultParty());
    expect(km).toBeGreaterThanOrEqual(5);
    expect(km).toBeLessThanOrEqual(10);
  });
  it('a 30-40% load is about 35% slower', () => {
    const base = defaultParty();
    // Parent 75 kg: 9.7 kg + 18 kg = 27.7 kg (37%).
    const heavy = loadedParty(18);
    const p = heavy.people[0]!;
    expect(loadBand(loadShare(27.7, p.bodyKg))).toBe(3);
    expect(personEffects(heavy.pack, p).paceFactor).toBe(0.65);
    // The child is still band 1, so the party is paced by the parent.
    const ratio = speedMs('path', 0, heavy) / speedMs('path', 0, base);
    expect(ratio).toBeCloseTo(0.65, 2);
    const dayRatio = simulateDay(gentle('path'), heavy) / simulateDay(gentle('path'), base);
    expect(dayRatio).toBeLessThan(0.75);
    expect(dayRatio).toBeGreaterThan(0.45);
  });
  it('the over-40% band gives short hops with rests', () => {
    const party = loadedParty(25);
    const fx = personEffects(party.pack, party.people[0]!);
    expect(fx.restEveryMin).toBe(20);
    const state = newWalkState(party);
    let walkedSteps = 0;
    let rested = false;
    for (let i = 0; i < 120; i++) {
      const m = stepWalk(state, party, 'path', 0, 30);
      if (m > 0) walkedSteps++;
      else rested = true;
    }
    expect(rested).toBe(true);
    // 20 min on, 17 min off: well under the 60 min walked in 120 half-minute steps.
    expect(walkedSteps).toBeLessThan(110);
    expect(simulateDay(gentle('path'), party)).toBeLessThan(simulateDay(gentle('path'), defaultParty()) * 0.5);
  });
  it('moves at the child pace when the child is slower', () => {
    const party = defaultParty();
    addItem(party.pack, 'water', 4, 'child');
    const child = party.people[1]!;
    expect(personEffects(party.pack, child).paceFactor).toBeLessThan(1);
    expect(personEffects(party.pack, party.people[0]!).paceFactor).toBe(1);
    expect(speedMs('path', 0, party)).toBeCloseTo(
      speedMs('path', 0, { people: [child], pack: party.pack }),
      8,
    );
    expect(speedMs('path', 0, party)).toBeLessThan(speedMs('path', 0, defaultParty()));
  });
});
