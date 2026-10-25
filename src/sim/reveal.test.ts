import { describe, expect, it } from 'vitest';
import { DWELL_S, Reveal, inScopeCone, type RevealWorld, type ScopeView } from './reveal';
import { tileId } from '../world/terrain';

/** Flat ground at 100 m with a 400 m ridge running north-south between x = 2500 and 2600. */
const world: RevealWorld = { heightAt: (x) => (x >= 2500 && x <= 2600 ? 400 : 100), weather: 'clear', smoke: [] };
const eye = { x: 500, y: 5500, z: 101.7 };
const view = (yawDeg: number): ScopeView => ({ eye, yawDeg, pitchDeg: 0, vFovDeg: 6, aspect: 16 / 9 });
const front = tileId(2, 5);
const behind = tileId(4, 5);

const hold = (r: Reveal, v: ScopeView | null, seconds: number, onDetail?: (id: string) => void): void => {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) r.update(0.05, v, world, onDetail);
};

describe('reveal', () => {
  it('reveals a tile in view and in sight after the dwell, not before', () => {
    const r = new Reveal();
    hold(r, view(90), DWELL_S - 0.2);
    expect(r.isShown(front)).toBe(false);
    hold(r, view(90), 0.3);
    expect(r.isShown(front)).toBe(true);
    expect(r.revealed.has(tileId(1, 5))).toBe(true);
  });
  it('never reveals a tile behind the ridge', () => {
    const r = new Reveal();
    hold(r, view(90), 3);
    expect(r.isShown(behind)).toBe(false);
  });
  it('needs the scope up and the tile in the cone; lowering it resets the dwell', () => {
    const r = new Reveal();
    hold(r, view(270), 3);
    expect(r.isShown(front)).toBe(false);
    hold(r, view(90), 0.5);
    hold(r, null, 0.1);
    hold(r, view(90), 0.5);
    expect(r.isShown(front)).toBe(false);
    expect(inScopeCone(view(90), 2, 5, world.heightAt)).toBe(true);
    expect(inScopeCone(view(0), 2, 5, world.heightAt)).toBe(false);
    expect(inScopeCone({ ...view(90), pitchDeg: 40 }, 2, 5, world.heightAt)).toBe(false);
  });
  it('asks for ground detail only within about 2 km', () => {
    const r = new Reveal();
    const asked = new Set<string>();
    hold(r, view(90), 1, (id) => asked.add(id));
    expect(asked.has(front)).toBe(true);
    expect([...asked].every((id) => id === tileId(0, 5) || id === tileId(1, 5) || id === front)).toBe(true);
  });
  it('shows tiles within about 1 km of where the player has been', () => {
    const r = new Reveal();
    const got = r.visit(500, 5500);
    expect(got).toContain(tileId(0, 5));
    expect(got).toContain(tileId(1, 6));
    expect(got).not.toContain(tileId(2, 5));
    expect(r.visit(500, 5500)).toEqual([]);
  });
  it('round-trips through the save and tells listeners', () => {
    const r = new Reveal();
    r.visit(500, 5500);
    hold(r, view(90), 1);
    const again = new Reveal();
    const heard: string[] = [];
    again.subscribe((ids) => heard.push(...ids));
    again.load(JSON.parse(JSON.stringify(r.serialize())));
    expect(again.serialize()).toEqual(r.serialize());
    expect(heard).toContain(front);
    again.load({ revealed: ['nope', 3], visited: 'x' });
    expect(again.serialize()).toEqual(r.serialize());
  });
});
