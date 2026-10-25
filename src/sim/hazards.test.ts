import { describe, expect, it } from 'vitest';
import { conditionText, INJURY_PACE, injure, partyConditionPace, stepConditions } from './condition';
import {
  DARK_SUN_DEG,
  gasActive,
  gasFade,
  GAS_DOSE_PER_MIN,
  hazardLines,
  newHazardState,
  STUCK_MAX_SEC,
  STUCK_MIN_SEC,
  stepHazards,
  TRIP_PER_M,
  type HazardEvent,
  type HazardRng,
  type HazardState,
  type HazardStep,
} from './hazards';
import { defaultParty, loadBand, loadShare, type Party } from './load';
import { addItem, carriedKg } from './pack';
import { createPlayer, type WalkWorld } from './player';
import type { Hazards } from '../world/conditions';

/** mulberry32: a seeded rng for the tests (the game's is Math.random). */
function seeded(seed: number): HazardRng {
  let a = seed >>> 0;
  return {
    next: () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Plays back fixed numbers, then repeats the last. */
const fixed = (...v: number[]): HazardRng => {
  let k = 0;
  return { next: () => v[Math.min(k++, v.length - 1)]! };
};

const NONE: Hazards = { tripInDark: false, injuryRisk: 0, trapRisk: 0, gas: false, waterDepth: 0, impassable: false };
const DAY = 40;
const NIGHT = -20;

function step(party: Party, over: Partial<HazardStep> = {}, hazards: Partial<Hazards> = {}): HazardStep {
  const stamina: Record<string, number> = {};
  for (const p of party.people) stamina[p.id] = 1;
  return {
    hazards: { ...NONE, ...hazards },
    groundType: 'field',
    grade: 0,
    movedM: 1,
    dtSec: 1,
    gameDays: 2.5,
    sunAltitude: DAY,
    stamina,
    walking: true,
    ...over,
  };
}

interface Run {
  events: HazardEvent[];
  lostSec: number;
  state: HazardState;
}

/** Run n steps and collect the events. */
function run(n: number, party: Party, make: (k: number) => HazardStep, rng: HazardRng): Run {
  const state = newHazardState(party);
  const events: HazardEvent[] = [];
  let lostSec = 0;
  for (let k = 0; k < n; k++) {
    const r = stepHazards(state, party, make(k), rng);
    events.push(...r.events);
    lostSec += r.lostSec;
  }
  return { events, lostSec, state };
}

/** A party whose parent carries about 35 kg (band 4) and whose child is in band 1. */
function heavyParty(): Party {
  const party = defaultParty();
  addItem(party.pack, 'water', 25, 'parent');
  return party;
}

describe('trips', () => {
  const party = defaultParty();

  it('never happen in daylight, whatever the ground', () => {
    const { events } = run(20000, party, () => step(party, {}, { tripInDark: true }), seeded(1));
    expect(events.filter((e) => e.kind === 'trip')).toHaveLength(0);
  });

  it('use the dark threshold of -6 degrees of sun', () => {
    const at = (alt: number): number =>
      run(20000, party, () => step(party, { sunAltitude: alt }, { tripInDark: true }), seeded(2)).events.filter((e) => e.kind === 'trip').length;
    expect(DARK_SUN_DEG).toBe(-6);
    expect(at(-5)).toBe(0);
    expect(at(-7)).toBeGreaterThan(0);
  });

  it('happen at about the configured rate in the dark, and only on rough ground', () => {
    const metres = 20000;
    const trips = (rough: boolean): number =>
      run(metres, party, () => step(party, { sunAltitude: NIGHT }, { tripInDark: rough }), seeded(3)).events.filter((e) => e.kind === 'trip').length;
    const expected = TRIP_PER_M * metres;
    expect(trips(true)).toBeGreaterThan(expected * 0.7);
    expect(trips(true)).toBeLessThan(expected * 1.3);
    expect(trips(false)).toBe(0);
  });

  it('cost stamina and time, and sometimes hurt an ankle', () => {
    const { events, lostSec, state } = run(20000, party, () => step(party, { sunAltitude: NIGHT }, { tripInDark: true }), seeded(4));
    expect(lostSec).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'trip' && e.hurt)).toBe(true);
    expect(Object.values(state.conditions).some((c) => c.injury)).toBe(true);
  });
});

describe('injuries', () => {
  it('on rough climbs follow the load band: none in band 1, some in band 4', () => {
    const party = heavyParty();
    const [parent, child] = party.people;
    expect(loadBand(loadShare(carriedKg(party.pack, parent!.id), parent!.bodyKg))).toBe(4);
    expect(loadBand(loadShare(carriedKg(party.pack, child!.id), child!.bodyKg))).toBe(1);
    const climb = run(20000, party, () => step(party, { groundType: 'heather', grade: 0.2 }), seeded(5));
    const hurt = climb.events.filter((e) => e.kind === 'injury');
    expect(hurt.length).toBeGreaterThan(0);
    expect(hurt.every((e) => e.kind === 'injury' && e.who === 'parent' && e.cause === 'rough climb')).toBe(true);
  });

  it('do not happen on the flat, on smooth ground, or in a band 1 party', () => {
    const heavy = heavyParty();
    const flat = run(20000, heavy, () => step(heavy, { groundType: 'heather', grade: 0 }), seeded(6));
    const smooth = run(20000, heavy, () => step(heavy, { groundType: 'road', grade: 0.2 }), seeded(6));
    const light = defaultParty();
    const easy = run(20000, light, () => step(light, { groundType: 'heather', grade: 0.2 }), seeded(6));
    expect(flat.events).toHaveLength(0);
    expect(smooth.events).toHaveLength(0);
    expect(easy.events).toHaveLength(0);
  });

  it('are likely when crossing a wrack dam', () => {
    const party = defaultParty();
    let hurt = 0;
    const rng = seeded(7);
    for (let trial = 0; trial < 400; trial++) {
      const r = run(10, party, () => step(party, {}, { injuryRisk: 0.5 }), rng);
      if (r.events.some((e) => e.kind === 'injury' && e.cause === 'wrack or landslip')) hurt++;
    }
    // 10 m at risk 0.5 is about 10% each for two people, about 19% for the party.
    expect(hurt).toBeGreaterThan(400 * 0.1);
    expect(hurt).toBeLessThan(400 * 0.3);
  });

  it('give an ankle or knee with a severity, a heal time and a slower pace', () => {
    const party = defaultParty();
    const state = newHazardState(party);
    expect(partyConditionPace(state.conditions, party)).toBe(1);
    const inj = injure(state.conditions, 'child', 'knee', 2)!;
    expect(inj.part).toBe('knee');
    expect(inj.healSec).toBeGreaterThan(injure(newHazardState(party).conditions, 'child', 'ankle', 2)!.healSec);
    expect(partyConditionPace(state.conditions, party)).toBe(INJURY_PACE[2]);
    expect(conditionText(state.conditions.child)).toContain('knee');
    // A lesser injury does not replace a worse one.
    expect(injure(state.conditions, 'child', 'ankle', 1)).toBeUndefined();
    // It heals in the end.
    const env = { waterDepth: 0, sunAltitude: DAY, walking: true };
    stepConditions(state.conditions, party, inj.healSec - 10, env);
    expect(state.conditions.child!.injury).toBeDefined();
    stepConditions(state.conditions, party, 20, env);
    expect(state.conditions.child!.injury).toBeUndefined();
  });

  it('slow the party: the same walk takes longer with someone hurt', () => {
    const world: WalkWorld = { sizeX: 5000, sizeY: 5000, heightAt: () => 0, groundTypeAt: () => 'road' };
    const walk = (hurt: boolean): number => {
      const player = createPlayer(2500, 100, 0, world, defaultParty(), seeded(8));
      if (hurt) injure(player.hazards.conditions, 'child', 'ankle', 2);
      let sec = 0;
      while (player.y < 1100 && sec < 36000) sec += player.step(1, { forward: 1, right: 0 }, world);
      return sec;
    };
    expect(walk(true)).toBeGreaterThan(walk(false) * 1.5);
  });

  it('wetness builds in water and dries; wet and cold at night builds exposure', () => {
    const party = defaultParty();
    const state = newHazardState(party);
    const c = state.conditions.parent!;
    stepConditions(state.conditions, party, 600, { waterDepth: 1, sunAltitude: NIGHT, walking: true });
    expect(c.wetness).toBeGreaterThan(0.9);
    stepConditions(state.conditions, party, 7200, { waterDepth: 0, sunAltitude: NIGHT, walking: true });
    expect(c.exposure).toBeGreaterThan(0.2);
    expect(conditionText(c)).not.toBe('');
    stepConditions(state.conditions, party, 3600 * 30, { waterDepth: 0, sunAltitude: DAY, walking: true });
    expect(c.wetness).toBe(0);
    expect(c.exposure).toBe(0);
  });
});

describe('soft patches', () => {
  const party = defaultParty();

  it('hold you for a time and cost stamina, once per patch', () => {
    const state = newHazardState(party);
    const s = step(party, {}, { trapRisk: 0.6 });
    const first = stepHazards(state, party, s, fixed(0));
    expect(first.events.some((e) => e.kind === 'stuck')).toBe(true);
    expect(first.lostSec).toBeGreaterThanOrEqual(STUCK_MIN_SEC);
    expect(first.lostSec).toBeLessThanOrEqual(STUCK_MAX_SEC);
    expect(s.stamina.parent).toBeLessThan(1);
    // Still standing in the same patch: no second roll.
    expect(stepHazards(state, party, step(party, {}, { trapRisk: 0.6 }), fixed(0)).lostSec).toBe(0);
    // Out and back in: it can hold you again.
    stepHazards(state, party, step(party), fixed(0));
    expect(stepHazards(state, party, step(party, {}, { trapRisk: 0.6 }), fixed(0)).lostSec).toBeGreaterThan(0);
  });

  it('do not always hold you', () => {
    const r = stepHazards(newHazardState(party), party, step(party, {}, { trapRisk: 0.6 }), fixed(0.99));
    expect(r.lostSec).toBe(0);
  });

  it('cost the player game time', () => {
    const trap: Hazards = { ...NONE, trapRisk: 0.6 };
    const world: WalkWorld = {
      sizeX: 5000,
      sizeY: 5000,
      heightAt: () => 0,
      groundTypeAt: () => 'field',
      conditionsAt: (_x, y) => ({
        groundType: 'field',
        speedFactor: 1,
        effortFactor: 1,
        hazards: y > 200 ? trap : NONE,
        explanation: 'soft mud',
      }),
    };
    const player = createPlayer(2500, 150, 0, world, defaultParty(), fixed(0));
    let passed = 0;
    for (let k = 0; k < 20; k++) passed += player.step(5, { forward: 1, right: 0 }, world);
    expect(passed).toBeGreaterThanOrEqual(100 + STUCK_MIN_SEC);
    expect(player.takeEvents().some((e) => e.kind === 'stuck')).toBe(true);
  });
});

describe('gas', () => {
  const party = defaultParty();
  const inGas = (gameDays: number, min = 20): Run =>
    run(min * 60, party, () => step(party, { gameDays, movedM: 0, walking: false }, { gas: true }), seeded(9));

  it('only acts on days 1 to 5, from 03:00 on day 1', () => {
    expect(gasActive(0.9)).toBe(false);
    expect(gasActive(1 + 2 / 24)).toBe(false);
    expect(gasActive(1 + 3 / 24)).toBe(true);
    expect(gasActive(5.99)).toBe(true);
    expect(gasActive(6)).toBe(false);
    for (const day of [0.5, 1.1, 6, 8]) {
      const r = inGas(day);
      expect(r.state.collapsed).toBe(false);
      expect(r.state.gasDose.parent).toBe(0);
    }
    for (const day of [1.2, 3, 5.9]) expect(inGas(day).state.collapsed).toBe(true);
  });

  it('builds up through warnings to a collapse, lighter people first', () => {
    const state = newHazardState(party);
    const levels: string[] = [];
    let collapsedAt = -1;
    for (let sec = 0; sec < 1200; sec++) {
      const r = stepHazards(state, party, step(party, { gameDays: 2, movedM: 0, walking: false }, { gas: true }), seeded(1));
      for (const e of r.events) {
        if (e.kind === 'gas') levels.push(e.level);
        if (e.kind === 'collapse') {
          collapsedAt = sec;
          expect(e.who).toBe('child');
        }
      }
    }
    expect(levels).toEqual(['warning', 'serious']);
    // The 40 kg child takes 75/40 times the dose, so collapses after 1 / (0.125 * 1.875) = 4.3 minutes.
    expect(collapsedAt / 60).toBeCloseTo(1 / (GAS_DOSE_PER_MIN * (75 / 40)), 0);
  });

  it('warns and fades the screen, then clears when you get out', () => {
    const state = newHazardState(party);
    const gas = step(party, { gameDays: 2, movedM: 0, walking: false, dtSec: 10 }, { gas: true });
    expect(gasFade(state)).toBe(0);
    let faded = false;
    for (let k = 0; k < 40 && !state.collapsed; k++) {
      stepHazards(state, party, { ...gas }, seeded(1));
      if (gasFade(state) > 0.2) {
        faded = true;
        break;
      }
    }
    expect(faded).toBe(true);
    expect(hazardLines(state, true).join(' ')).toMatch(/hollow/i);
    for (let k = 0; k < 120; k++) stepHazards(state, party, { ...gas, hazards: NONE }, seeded(1));
    expect(gasFade(state)).toBe(0);
    expect(hazardLines(state, false)).toEqual([]);
    expect(hazardLines(state, true)).toEqual(['No insects buzzing.']);
  });

  it('is survivable to cross: a 50 m hollow cell at walking pace does not collapse anyone', () => {
    const r = run(40, party, () => step(party, { gameDays: 2, movedM: 1.4, dtSec: 1 }, { gas: true }), seeded(1));
    expect(r.state.collapsed).toBe(false);
  });

  it('stops the player walking once collapsed', () => {
    const gas: Hazards = { ...NONE, gas: true };
    const world: WalkWorld = {
      sizeX: 5000,
      sizeY: 5000,
      heightAt: () => 0,
      groundTypeAt: () => 'field',
      gameDays: () => 2,
      conditionsAt: () => ({ groundType: 'field', speedFactor: 1, effortFactor: 1, hazards: gas, explanation: 'gas hollow' }),
    };
    const player = createPlayer(2500, 100, 0, world, defaultParty(), seeded(10));
    for (let k = 0; k < 600; k++) player.step(1, { forward: 1, right: 0 }, world);
    expect(player.hazards.collapsed).toBe(true);
    const y = player.y;
    player.step(10, { forward: 1, right: 0 }, world);
    expect(player.y).toBe(y);
  });
});
