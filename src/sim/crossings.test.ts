import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  assess,
  crossingLines,
  NEED_RAFT,
  resolve,
  waistDepth,
  wadeLimit,
  waterState,
  type CrossingKind,
  type CrossingOption,
  type CrossingRng,
  type CrossingSite,
} from './crossings';
import { defaultParty, type Party } from './load';
import { addItem } from './pack';

/** Plays back fixed numbers, then repeats the last. */
const rng = (...v: number[]): CrossingRng => {
  let k = 0;
  return { next: () => v[Math.min(k++, v.length - 1)]! };
};

const river = (shallow = false): CrossingSite => ({ water: 'river', widthM: 20, shallow, detourM: 800 });
const stream: CrossingSite = { water: 'stream', widthM: 4 };
const pond = (depthM: number): CrossingSite => ({ water: 'standing', widthM: 30, depthM });

const get = (opts: CrossingOption[], k: CrossingKind): CrossingOption => opts.find((o) => o.kind === k)!;
const usable = (opts: CrossingOption[]): CrossingKind[] => opts.filter((o) => o.available).map((o) => o.kind);

describe('wade limits', () => {
  it("the child's limit is lower, and the party takes the lower", () => {
    const party = defaultParty();
    const [parent, child] = party.people;
    expect(waistDepth(child!)).toBeLessThan(waistDepth(parent!));
    expect(wadeLimit(party)).toBe(waistDepth(child!));
    // 0.85 m is waist deep on the parent, chest deep on the child.
    expect(usable(assess(pond(0.85), party, 8))).not.toContain('wade');
    const alone: Party = { people: [parent!], pack: [] };
    expect(usable(assess(pond(0.85), alone, 8))).toContain('wade');
  });

  it('shallow standing water is a ford, deep standing water has to be swum and a raft is not built', () => {
    const party = defaultParty();
    expect(usable(assess(pond(0.4), party, 3))).toEqual(['ford']);
    const deep = assess(pond(2), party, 3);
    expect(usable(deep)).toEqual(['swim']);
    expect(get(deep, 'raft').label).toBe(NEED_RAFT);
    expect(get(deep, 'raft').available).toBe(false);
  });
});

describe('rivers and streams by day', () => {
  it('a river on day 3 is swim-only, even at a shallow point', () => {
    const party = defaultParty();
    expect(usable(assess(river(), party, 3))).toEqual(['swim', 'detour']);
    expect(usable(assess(river(true), party, 3))).toEqual(['swim', 'detour']);
  });

  it('a river on day 8 is fordable at a shallow point but not in the channel', () => {
    const party = defaultParty();
    expect(usable(assess(river(true), party, 8))).toEqual(['ford', 'detour']);
    expect(usable(assess(river(false), party, 8))).toEqual(['swim', 'detour']);
    expect(waterState(river(), 8).depthM).toBeLessThan(waterState(river(), 3).depthM);
  });

  it('a stream is always fordable', () => {
    const party = defaultParty();
    for (let day = 0; day <= 20; day++) expect(get(assess(stream, party, day), 'ford').available).toBe(true);
  });

  it('there is no detour when none is known', () => {
    const o = get(assess({ water: 'river', widthM: 20 }, defaultParty(), 3), 'detour');
    expect(o.available).toBe(false);
  });

  it('swimming is slower than fording and costs more effort and risk', () => {
    const party = defaultParty();
    const swim = get(assess(river(), party, 3), 'swim');
    const ford = get(assess(stream, party, 3), 'ford');
    expect(swim.effort).toBeGreaterThan(ford.effort);
    expect(swim.risk).toBeGreaterThan(ford.risk);
    expect(swim.timeSec / 20).toBeGreaterThan(ford.timeSec / 4);
    expect(crossingLines(assess(river(), party, 3)).length).toBe(5);
  });
});

describe('resolve', () => {
  function packed(): Party {
    const party = defaultParty();
    addItem(party.pack, 'rifle_l403a1', 1, 'parent');
    addItem(party.pack, 'camping_kit', 1, 'parent', true);
    return party;
  }
  const names = (l: { itemId: string }[]): string[] => l.map((i) => i.itemId);

  it('swimming soaks only unsealed items: tins survive, the quilt is ruined, the rifle needs drying', () => {
    const party = packed();
    const out = resolve(get(assess(river(), party, 3), 'swim'), party, rng(0.99));
    expect(out.result).toBe('crossed');
    expect(names(out.lost)).toEqual([]);
    expect(names(out.ruined)).toEqual(['camping_kit', 'camping_kit']); // the two unsealed kits; the sealed one is spared
    expect(out.ruined.every((i) => i.carrier !== 'parent' || i.itemId === 'camping_kit')).toBe(true);
    expect(names(out.soaked)).toContain('rifle_l403a1');
    expect(names(out.soaked)).not.toContain('tin_food');
    expect(names(out.ruined)).not.toContain('tin_food');
  });

  it('a sealed pack is untouched by a swim', () => {
    const party = defaultParty();
    for (const e of party.pack) e.sealed = true;
    const out = resolve(get(assess(river(), party, 3), 'swim'), party, rng(0.99));
    expect([...out.lost, ...out.ruined, ...out.soaked]).toEqual([]);
  });

  it('being swept away loses unsealed items, takes longer, and applyOutcome removes them', () => {
    const party = packed();
    const swim = get(assess(river(), party, 3), 'swim');
    // First number fails the risk roll (swept); the rest are below the loss chance, so every unsealed entry goes.
    const out = resolve(swim, party, rng(0, 0));
    expect(out.result).toBe('swept');
    expect(out.timeSec).toBeGreaterThan(swim.timeSec);
    const before = party.pack.length;
    applyOutcome(party.pack, out);
    expect(party.pack.length).toBe(before - out.lost.length - out.ruined.length);
    expect(party.pack.filter((e) => !e.sealed)).toEqual([]);
    expect(party.pack.some((e) => e.sealed && e.itemId === 'camping_kit')).toBe(true);
  });

  it('a ford wets nothing; a wade soaks unsealed gear and may slip', () => {
    const party = packed();
    const ford = resolve(get(assess(stream, party, 8), 'ford'), party, rng(0.99));
    expect([...ford.lost, ...ford.ruined, ...ford.soaked]).toEqual([]);
    const wade = get(assess(pond(0.6), party, 8), 'wade');
    expect(wade.available).toBe(true);
    const slipped = resolve(wade, party, rng(0));
    expect(slipped.result).toBe('slipped');
    expect(slipped.timeSec).toBeGreaterThan(wade.timeSec);
    expect(names(slipped.soaked)).toContain('rifle_l403a1');
  });

  it('an unavailable option does nothing', () => {
    const party = defaultParty();
    const raft = resolve(get(assess(pond(2), party, 3), 'raft'), party, rng(0));
    expect(raft.result).toBe('blocked');
    expect(raft.timeSec).toBe(0);
  });

  it('the detour just takes time', () => {
    const party = defaultParty();
    const out = resolve(get(assess(river(), party, 3), 'detour'), party, rng(0.5));
    expect(out.result).toBe('crossed');
    expect(out.timeSec).toBeGreaterThan(600);
  });
});
