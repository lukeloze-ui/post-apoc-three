import { describe, expect, it } from 'vitest';
import { legProfile, naismithHours, plannedLegHours } from './naismith';
import type { Party } from './load';
import { addItem } from './pack';

const flat = (): number => 100;
const party = (): Party => ({ people: [{ id: 'a', name: 'A', bodyKg: 75 }], pack: [] });

describe('naismith', () => {
  it('5 km flat is one hour', () => expect(naismithHours(5, 0)).toBeCloseTo(1));
  it('10 km with 600 m climbing is three hours', () => expect(naismithHours(10, 600)).toBeCloseTo(3));
  it('descent adds nothing', () => {
    const p = legProfile([{ x: 0, y: 0 }, { x: 1000, y: 0 }], (x) => 200 - x * 0.1);
    expect(p.ascentM).toBe(0);
    expect(p.descentM).toBeCloseTo(100);
    expect(naismithHours(p.km, p.ascentM)).toBeCloseTo(0.2);
  });
  it('profile of a synthetic ramp', () => {
    const p = legProfile([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }], (x, y) => x * 0.1 + y * 0);
    expect(p.km).toBeCloseTo(1);
    expect(p.ascentM).toBeCloseTo(60);
  });
  it('plans a flat 5 km leg at 1:00 for an unladen party', () => {
    expect(plannedLegHours([{ x: 0, y: 0 }, { x: 5000, y: 0 }], flat, party())).toBeCloseTo(1);
  });
  it('the 30-40% band divides by 0.65', () => {
    const pt = party();
    // 75 kg body: 27 kg is 36%.
    addItem(pt.pack, 'camping_kit', 1, 'a');
    addItem(pt.pack, 'water', 21, 'a');
    const h = plannedLegHours([{ x: 0, y: 0 }, { x: 5000, y: 0 }], flat, pt);
    expect(h).toBeCloseTo(1 / 0.65);
  });
});
