import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Districts } from '../../../src/world/districts';
import { applyOverrides, readOverrides, type Override } from './overrides';

const committed = (): Districts => JSON.parse(readFileSync('public/world/districts.json', 'utf8')) as Districts;

describe('overrides', () => {
  it('every committed override has a reason and is reflected in districts.json', () => {
    const overrides = readOverrides();
    const d = committed();
    for (const o of overrides) {
      expect(o.reason.trim().length, o.id).toBeGreaterThan(0);
      if (o.kind === 'roadSegment' && o.set) {
        const s = d.roadSegments.find((r) => r.id === o.id);
        expect(s, o.id).toMatchObject(o.set);
      }
      if (o.kind === 'crater' && o.add) {
        expect(d.tiles.some((t) => t.craters.some((c) => c.id === o.id)), o.id).toBe(true);
      }
    }
  });

  it('applies set, add and remove, and rejects bad entries', () => {
    const d = committed();
    const seg = d.roadSegments.find((s) => s.blocked) as Districts['roadSegments'][number];
    const bridge = d.bridges.find((b) => !b.standing) as Districts['bridges'][number];
    const zone = d.tiles.flatMap((t) => t.strikeZones)[0];
    const ops: Override[] = [
      { kind: 'roadSegment', id: seg.id, set: { blocked: false }, reason: 'test' },
      { kind: 'bridge', id: bridge.id, set: { standing: true }, reason: 'test' },
      { kind: 'fire', id: 'fi-test', add: { x: 10, y: 10, r: 5, fromDay: 1, toDay: 2 }, reason: 'test' },
    ];
    if (zone) ops.push({ kind: 'strikeZone', id: zone.id, remove: true, reason: 'test' });
    applyOverrides(d, ops);
    expect(seg).toMatchObject({ blocked: false, cause: null });
    expect(bridge).toMatchObject({ standing: true, reason: 'override' });
    expect(d.tiles[0]?.fires.some((f) => f.id === 'fi-test')).toBe(true);
    if (zone) expect(d.tiles.flatMap((t) => t.strikeZones).some((z) => z.id === zone.id)).toBe(false);

    expect(() => applyOverrides(d, [{ kind: 'roadSegment', id: seg.id, set: { blocked: true }, reason: ' ' }])).toThrow(/reason/);
    expect(() => applyOverrides(d, [{ kind: 'roadSegment', id: 'nope', set: {}, reason: 'x' }])).toThrow(/no such/);
    expect(() => applyOverrides(d, [{ kind: 'fire', id: 'fi-test', add: { x: 1, y: 1 }, reason: 'x' }])).toThrow(/already/);
  });
});
