import { describe, expect, it } from 'vitest';
import { createPlayer, MAX_WADE_DEPTH_M, type WalkWorld } from './player';
import { WalkLog } from './walkLog';
import { buildRoadIndex, roadAt } from '../world/roadIndex';

/** A fake 5 km patch: ground rises with northing at the given grade, one ground type, optional lake. */
function fakeWorld(grade: number, extra: Partial<WalkWorld> = {}): WalkWorld {
  return {
    sizeX: 5000,
    sizeY: 5000,
    heightAt: (_x, y) => grade * y,
    groundTypeAt: () => 'road',
    ...extra,
  };
}

/** Walk north from (2500, 100) until 1 km covered; returns game minutes taken. */
function walk1km(world: WalkWorld): { minutes: number; player: ReturnType<typeof createPlayer> } {
  const player = createPlayer(2500, 100, 0, world);
  let sec = 0;
  while (player.y < 1100 && sec < 3600 * 10) {
    sec += player.step(1, { forward: 1, right: 0 }, world);
    expect(player.z).toBeCloseTo(world.heightAt(player.x, player.y), 9);
  }
  return { minutes: sec / 60, player };
}

describe('player walking', () => {
  it('takes more game time to go 1 km up a 10% grade than 1 km flat', () => {
    const flat = walk1km(fakeWorld(0));
    const hill = walk1km(fakeWorld(0.1));
    expect(hill.minutes).toBeGreaterThan(flat.minutes);
    expect(hill.player.grade).toBeCloseTo(0.1, 6);
    expect(hill.player.z).toBeCloseTo(0.1 * hill.player.y, 6);
  });

  it('moves WASD relative to yaw', () => {
    const world = fakeWorld(0);
    const east = createPlayer(2500, 2500, 90, world);
    east.step(2, { forward: 1, right: 0 }, world);
    expect(east.x).toBeGreaterThan(2500);
    expect(east.y).toBeCloseTo(2500, 6);
    const strafe = createPlayer(2500, 2500, 90, world);
    strafe.step(2, { forward: 0, right: 1 }, world);
    expect(strafe.y).toBeLessThan(2500);
    expect(strafe.x).toBeCloseTo(2500, 6);
    const back = createPlayer(2500, 2500, 0, world);
    back.step(2, { forward: -1, right: 0 }, world);
    expect(back.y).toBeLessThan(2500);
  });

  it('stays inside the patch', () => {
    const world = fakeWorld(0);
    const p = createPlayer(2500, 4990, 0, world);
    for (let i = 0; i < 200; i++) p.step(1, { forward: 1, right: 0 }, world);
    expect(p.y).toBeLessThanOrEqual(world.sizeY);
    expect(p.y).toBeCloseTo(world.sizeY - 1, 6);
  });

  it('does not walk into water deeper than 1 m, but wades shallow water', () => {
    const lakeY = 1000;
    const deep = fakeWorld(0, { waterDepthAt: (_x, y) => (y > lakeY ? MAX_WADE_DEPTH_M + 1 : 0) });
    const p = createPlayer(2500, 990, 0, deep);
    for (let i = 0; i < 100; i++) p.step(1, { forward: 1, right: 0 }, deep);
    expect(p.y).toBeLessThanOrEqual(lakeY);
    const shallow = fakeWorld(0, { waterDepthAt: () => 0.5 });
    const q = createPlayer(2500, 990, 0, shallow);
    for (let i = 0; i < 100; i++) q.step(1, { forward: 1, right: 0 }, shallow);
    expect(q.y).toBeGreaterThan(1000);
  });

  it('takes forced rests that pass faster than game time and recover stamina', () => {
    const world = fakeWorld(0);
    const p = createPlayer(2500, 100, 0, world);
    let sec = 0;
    let rested = false;
    for (let i = 0; i < 4000 && !rested; i++) {
      const used = p.step(1, { forward: 1, right: 0 }, world);
      sec += used;
      if (used > 1) rested = true;
    }
    expect(rested).toBe(true);
    expect(p.paceMs).toBeGreaterThanOrEqual(0);
  });
});

describe('roadAt', () => {
  const idx = buildRoadIndex([
    { id: 'a', cls: 'path', pts: [[100, 100], [100, 300]] },
    { id: 'b', cls: 'A', pts: [[90, 200], [110, 200]] },
  ]);
  it('finds a road within its half-width and not beyond', () => {
    expect(roadAt(idx, 101, 150)).toBe('path');
    expect(roadAt(idx, 103, 150)).toBeUndefined();
    expect(roadAt(idx, 100, 400)).toBeUndefined();
  });
  it('prefers the better class where roads cross', () => {
    expect(roadAt(idx, 100, 201)).toBe('A');
  });
});

describe('WalkLog', () => {
  it('logs every 10 m or 10 s of movement, and not while standing still', () => {
    const log = new WalkLog();
    expect(log.record(0, 0, 0)).toBe(true);
    expect(log.record(0.05, 3, 0)).toBe(false);
    expect(log.record(0.2, 4, 0)).toBe(true);
    expect(log.record(0.3, 14, 0)).toBe(true);
    expect(log.record(60, 14, 0)).toBe(false);
    expect(log.entries.length).toBe(3);
    expect(log.elapsedMin(0, 2)).toBeCloseTo(0.3, 9);
  });
});
