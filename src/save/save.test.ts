import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameClock } from '../sim/time';
import type { Pack } from '../sim/pack';
import { Marks } from '../ui/paperMap/marks';
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_INTERVAL_MS,
  SAVE_KEY,
  SAVE_VERSION,
  SaveGame,
  migrateSave,
  registerCoreSections,
  type SaveFile,
  type SaveStorage,
} from './save';

function fakeStorage(): SaveStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  return {
    data,
    writes: 0,
    getItem: (k) => data.get(k) ?? null,
    setItem(k, v) {
      data.set(k, v);
      this.writes++;
    },
  };
}

function world(): { player: { x: number; y: number; yaw: number }; clock: GameClock; pack: Pack; marks: Marks } {
  return { player: { x: 100, y: 200, yaw: 45 }, clock: new GameClock(), pack: [], marks: new Marks() };
}

function wire(save: SaveGame, w: ReturnType<typeof world>): void {
  registerCoreSections(save, w);
  save.registerSection(
    'marks',
    () => w.marks.serialize(),
    (d) => w.marks.load(d),
  );
}

afterEach(() => vi.useRealTimers());

describe('save and load', () => {
  it('round-trips player, clock, pack and marks', () => {
    const storage = fakeStorage();
    const a = world();
    a.player.x = 1234.5;
    a.player.y = 6789;
    a.player.yaw = 271;
    a.clock.minutes = 3 * 1440 + 425;
    a.pack.push({ itemId: 'camping_kit', qty: 1, carrier: 'p1', sealed: true });
    a.marks.addNote(10, 20, 'ford');
    a.marks.addStroke([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
    const saveA = new SaveGame({ storage });
    wire(saveA, a);
    expect(saveA.save()).toBe(true);
    expect(JSON.parse(storage.data.get(SAVE_KEY) as string).version).toBe(SAVE_VERSION);

    const b = world();
    const saveB = new SaveGame({ storage });
    expect(saveB.hasSave).toBe(true);
    wire(saveB, b);
    expect(b.player).toEqual({ x: 1234.5, y: 6789, yaw: 271 });
    expect(b.clock.minutes).toBe(a.clock.minutes);
    expect(b.pack).toEqual(a.pack);
    expect(b.marks.all).toEqual(a.marks.all);
  });

  it('fresh skips loading', () => {
    const storage = fakeStorage();
    const a = world();
    a.player.x = 999;
    a.marks.addNote(1, 1, 'old');
    const saveA = new SaveGame({ storage });
    wire(saveA, a);
    saveA.save();

    const b = world();
    const saveB = new SaveGame({ storage, fresh: true });
    wire(saveB, b);
    expect(saveB.hasSave).toBe(false);
    expect(saveB.peek('player')).toBeUndefined();
    expect(b.player.x).toBe(100);
    expect(b.marks.all).toHaveLength(0);
  });

  it('lets the caller keep URL-set values over the save', () => {
    const storage = fakeStorage();
    const a = world();
    a.player.x = 999;
    a.clock.minutes = 5000;
    const saveA = new SaveGame({ storage });
    wire(saveA, a);
    saveA.save();
    const b = world();
    registerCoreSections(new SaveGame({ storage }), { ...b, overridden: { player: true } });
    expect(b.player.x).toBe(100);
    expect(b.clock.minutes).toBe(5000);
  });

  it('ignores unreadable, foreign and future saves', () => {
    for (const text of ['not json', '{"version":99,"sections":{}}', '{"sections":{}}', 'null']) {
      const storage = fakeStorage();
      storage.data.set(SAVE_KEY, text);
      expect(new SaveGame({ storage }).hasSave, text).toBe(false);
    }
  });

  it('drops pack entries that name no real item', () => {
    const storage = fakeStorage();
    storage.data.set(
      SAVE_KEY,
      JSON.stringify({ version: 1, savedAt: 0, sections: { pack: [{ itemId: 'nope', qty: 1, carrier: 'p1' }] } }),
    );
    const w = world();
    wire(new SaveGame({ storage }), w);
    expect(w.pack).toEqual([]);
  });
});

describe('migration', () => {
  it('runs each step from the saved version up', () => {
    const migrations = {
      1: (f: SaveFile): SaveFile => ({ ...f, version: 2, sections: { ...f.sections, a: 1 } }),
      2: (f: SaveFile): SaveFile => ({ ...f, version: 3, sections: { ...f.sections, b: (f.sections.a as number) + 1 } }),
    };
    const out = migrateSave({ version: 1, savedAt: 1, sections: {} }, migrations, 3);
    expect(out?.version).toBe(3);
    expect(out?.sections).toEqual({ a: 1, b: 2 });
  });

  it('rejects a save with no path to the current version', () => {
    expect(migrateSave({ version: 1, savedAt: 1, sections: {} }, {}, 2)).toBeUndefined();
  });
});

describe('autosave', () => {
  it('folds a burst of changes into one write, and saves every 30 s', () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    const w = world();
    const save = new SaveGame({ storage });
    wire(save, w);
    w.marks.subscribe(() => save.markDirty());
    w.marks.addNote(1, 1, 'a');
    w.marks.addNote(2, 2, 'b');
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(storage.writes).toBe(1);

    save.start();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2);
    expect(storage.writes).toBe(3);
    save.stop();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(storage.writes).toBe(3);
  });
});
