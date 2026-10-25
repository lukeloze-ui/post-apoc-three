import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATCH_M } from '../../src/world/geo';
import { clipLine, clipRing, simplifyLine, simplifyRing, stitchRings } from './import/osm';

interface Features {
  roads: { cls: string; name?: string; ref?: string; pts: [number, number][] }[];
  rivers: { name?: string }[];
  buildings: { type: string }[];
  pois: { kind: string }[];
  bridges: { major?: boolean }[];
}

const features = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'public', 'world', 'features.json'), 'utf8')) as Features;

/** Every [x, y] pair found anywhere in the tree, using the x/y fields and the pts/ring arrays. */
function coords(node: unknown, out: [number, number][] = []): [number, number][] {
  if (Array.isArray(node)) {
    if (node.length === 2 && typeof node[0] === 'number' && typeof node[1] === 'number') out.push([node[0], node[1]]);
    else for (const n of node) coords(n, out);
  } else if (typeof node === 'object' && node !== null) {
    const o = node as Record<string, unknown>;
    if (typeof o.x === 'number' && typeof o.y === 'number') out.push([o.x, o.y]);
    for (const [k, v] of Object.entries(o)) if (k === 'pts' || k === 'ring' || typeof v === 'object') coords(v, out);
  }
  return out;
}

describe('features.json', () => {
  it('contains the A30, the West Okement and the first POI', () => {
    expect(features.roads.some((r) => r.cls === 'A' && (r.ref === 'A30' || r.name === 'A30'))).toBe(true);
    expect(features.rivers.some((r) => r.name?.includes('West Okement'))).toBe(true);
    expect(features.pois[0]?.kind).toBe('target-railway');
  });

  it('has military buildings and several building types', () => {
    const types = new Set(features.buildings.map((b) => b.type));
    expect(types.has('military')).toBe(true);
    expect(types.size).toBeGreaterThanOrEqual(4);
  });

  it('keeps every coordinate inside the patch', () => {
    const all = coords(features);
    expect(all.length).toBeGreaterThan(1000);
    for (const [x, y] of all) {
      expect(x >= 0 && x <= PATCH_M && y >= 0 && y <= PATCH_M).toBe(true);
    }
  });

  it('stays under 1.5 MB', () => {
    expect(readFileSync(join(import.meta.dirname, '..', '..', 'public', 'world', 'features.json')).length).toBeLessThan(1_500_000);
  });
});

describe('osm geometry helpers', () => {
  it('Douglas-Peucker drops points within tolerance and keeps corners', () => {
    expect(simplifyLine([[0, 0], [5, 1], [10, 0], [10, 10]], 2)).toEqual([[0, 0], [10, 0], [10, 10]]);
    const ring = simplifyRing([[0, 0], [5, 0.5], [10, 0], [10, 10], [0, 10], [0, 0]], 2);
    expect(ring?.length).toBe(5);
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1]);
  });

  it('clips lines and rings to the patch', () => {
    expect(clipLine([[-100, 50], [100, 50]])).toEqual([[[0, 50], [100, 50]]]);
    expect(clipLine([[-5, -5], [-1, -1]])).toEqual([]);
    const ring = clipRing([[-10, -10], [20, -10], [20, 20], [-10, 20], [-10, -10]]);
    expect(ring && Math.min(...ring.map((p) => p[0]))).toBe(0);
  });

  it('stitches fragments into a closed ring', () => {
    const rings = stitchRings([[[0, 0], [10, 0], [10, 10]], [[0, 0], [0, 10], [10, 10]]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.length).toBe(5);
  });
});
