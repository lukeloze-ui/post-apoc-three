import { describe, expect, it } from 'vitest';
import { LegTracker, type TrackedLeg } from './legTracker';
import { WalkLog } from './walkLog';

const leg: TrackedLeg = { id: 1, pts: [{ x: 0, y: 0 }, { x: 3000, y: 0 }] };

/** Walks the given points at 1.25 m/s (so 10 m = 8 s), logging a sample every 10 m. Returns the minutes at the end. */
function walk(log: WalkLog, pts: Array<[number, number]>, startMin: number): number {
  let min = startMin;
  let [x, y] = pts[0]!;
  log.record(min, x, y);
  for (const [tx, ty] of pts.slice(1)) {
    const len = Math.hypot(tx - x, ty - y);
    const n = Math.ceil(len / 10);
    for (let i = 1; i <= n; i++) {
      min += len / n / 1.25 / 60;
      log.record(min, x + ((tx - x) * i) / n, y + ((ty - y) * i) / n);
    }
    [x, y] = [tx, ty];
  }
  return min;
}

describe('legTracker', () => {
  it('a straight walk completes with its real time', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    const end = walk(log, [[0, 0], [3000, 0]], 600);
    const done = t.update(log.entries, [leg]);
    expect(done).toHaveLength(1);
    // Timed from leaving the start zone to reaching the end zone: about 100 m short each way.
    expect(t.realMinutes(1)).toBeGreaterThan(30);
    expect(t.realMinutes(1)).toBeLessThan(end - 600);
    expect(t.history).toHaveLength(1);
  });

  it('a detour within the corridor completes with the longer time', () => {
    const direct = new WalkLog();
    const t1 = new LegTracker();
    walk(direct, [[0, 0], [3000, 0]], 0);
    t1.update(direct.entries, [leg]);

    const detour = new WalkLog();
    const t2 = new LegTracker();
    walk(detour, [[0, 0], [1000, 0], [1500, 250], [2000, 0], [3000, 0]], 0);
    t2.update(detour.entries, [leg]);

    expect(t2.realMinutes(1)).toBeDefined();
    expect(t2.realMinutes(1)!).toBeGreaterThan(t1.realMinutes(1)!);
  });

  it('leaving the corridor cancels the attempt', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    walk(log, [[0, 0], [1000, 0], [1000, 1500], [3000, 1500], [3000, 0]], 0);
    expect(t.update(log.entries, [leg])).toHaveLength(0);
    expect(t.realMinutes(1)).toBeUndefined();
    expect(t.isActive(1)).toBe(false);
  });

  it('too many samples outside the corridor fail the share test at the end', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    // Stays under the abandon distance but spends most of the walk 400 m off the line.
    walk(log, [[0, 0], [200, 400], [2800, 400], [3000, 0]], 0);
    expect(t.update(log.entries, [leg])).toHaveLength(0);
    expect(t.realMinutes(1)).toBeUndefined();
  });

  it('walking end to start does not count', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    walk(log, [[3000, 0], [0, 0]], 0);
    expect(t.update(log.entries, [leg])).toHaveLength(0);
    expect(t.realMinutes(1)).toBeUndefined();
  });

  it('a fresh completion replaces the shown time and history keeps the old one', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    let min = walk(log, [[0, 0], [3000, 0]], 0);
    t.update(log.entries, [leg]);
    const first = t.realMinutes(1)!;
    min = walk(log, [[3000, 0], [0, 0]], min + 1);
    walk(log, [[0, 0], [1500, 0], [1500, 200], [3000, 0]], min + 1);
    t.update(log.entries, [leg]);
    expect(t.realMinutes(1)!).toBeGreaterThan(first);
    expect(t.history.map((c) => c.realMinutes)).toEqual([first, t.realMinutes(1)]);
  });

  it('turning back to the start restarts the attempt', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    const min = walk(log, [[0, 0], [800, 0], [0, 0]], 0);
    walk(log, [[0, 0], [3000, 0]], min + 60);
    t.update(log.entries, [leg]);
    // Timed from the second departure, not the first.
    expect(t.realMinutes(1)!).toBeLessThan(3000 / 1.25 / 60);
  });

  it('feeds incrementally and survives a save round trip', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    walk(log, [[0, 0], [1500, 0]], 0);
    t.update(log.entries, [leg]);
    expect(t.isActive(1)).toBe(true);
    const copy = new LegTracker();
    copy.load(JSON.parse(JSON.stringify(t.serialize())));
    expect(copy.isActive(1)).toBe(true);
    // The walk log is not saved, so a loaded tracker is fed a fresh log.
    const fresh = new WalkLog();
    walk(fresh, [[1500, 0], [3000, 0]], 100);
    expect(copy.update(fresh.entries, [leg])).toHaveLength(1);
    expect(copy.realMinutes(1)).toBeGreaterThan(0);
  });

  it('drops attempts for legs that no longer exist and ignores junk on load', () => {
    const log = new WalkLog();
    const t = new LegTracker();
    walk(log, [[0, 0], [1500, 0]], 0);
    t.update(log.entries, [leg]);
    t.update(log.entries, []);
    expect(t.isActive(1)).toBe(false);
    t.load({ last: [{ legId: 'x' }, null], history: 5, attempts: [{}] });
    expect(t.history).toHaveLength(0);
  });
});
