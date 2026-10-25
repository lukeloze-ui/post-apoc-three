import { describe, expect, it } from 'vitest';
import { HINT_WALK_RADIUS_M, Hints, type Hint } from './hints';
import { tileId } from '../world/terrain';

const bridge: Hint = { id: 'br-1', x: 1500, y: 1500 };
const features = new Map<string, Hint[]>([[tileId(1, 1), [bridge, { id: 'sz-1', x: 1900, y: 1900 }]]]);

describe('hints', () => {
  it('records nothing while off, on shown tiles or walking', () => {
    const h = new Hints(features);
    h.tilesShown([tileId(1, 1)]);
    h.walk(1500, 1500);
    expect(h.all).toEqual([]);
    expect(h.serialize().hints).toEqual([]);
  });
  it('hints a shown tile once per feature id', () => {
    const h = new Hints(features);
    h.enabled = true;
    h.tilesShown([tileId(1, 1)]);
    h.tilesShown([tileId(1, 1)]);
    h.walk(1500, 1500);
    expect(h.all.map((x) => x.id).sort()).toEqual(['br-1', 'sz-1']);
  });
  it('hints a feature only when walking within the radius', () => {
    const h = new Hints(features);
    h.enabled = true;
    h.walk(1500 + HINT_WALK_RADIUS_M + 5, 1500);
    expect(h.all).toEqual([]);
    h.walk(1500 + HINT_WALK_RADIUS_M - 5, 1500);
    expect(h.all.map((x) => x.id)).toEqual(['br-1']);
  });
  it('does not add earlier sightings when switched on, and round-trips', () => {
    const h = new Hints(features);
    h.tilesShown([tileId(1, 1)]);
    h.enabled = true;
    expect(h.all).toEqual([]);
    h.walk(1500, 1500);
    const g = new Hints(features);
    g.load(h.serialize());
    expect(g.all).toEqual([bridge]);
  });
});
