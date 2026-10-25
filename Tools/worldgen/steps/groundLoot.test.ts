// Committed-data checks on ground loot and doors (spec SX 01 Days 2 to 4, SX 03 bands).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pt } from '../../../src/world/features';
import { Band, bandFor, hwAt } from '../../../src/world/flood';
import { parseGround, type GroundTile } from '../../../src/world/ground';
import { heightAt, TILES_PER_SIDE, tileId } from '../../../src/world/terrain';
import { loadGroundWorld } from './ground';

const world = loadGroundWorld();
const { terrain, flood, features } = world;
const tiles: GroundTile[] = [];
for (let j = 0; j < TILES_PER_SIDE; j++) {
  for (let i = 0; i < TILES_PER_SIDE; i++) {
    const id = tileId(i, j);
    tiles.push(parseGround(JSON.parse(readFileSync(`public/world/ground/${id}.json`, 'utf8')), id));
  }
}
const loot = tiles.flatMap((t) => t.loot);
const doors = tiles.flatMap((t) => t.doors);
const objectByKey = new Map(tiles.flatMap((t) => t.objects).map((o) => [o.key, o]));
const buildings = new Map(features.buildings.map((b) => [b.id, b]));

/** Vertex mean, leaving out the closing repeat. */
const centre = (ring: readonly Pt[]): Pt => {
  const m = ring.length - 1;
  return [ring.slice(0, m).reduce((a, p) => a + p[0], 0) / m, ring.slice(0, m).reduce((a, p) => a + p[1], 0) / m];
};
const bandOf = (id: string): number => {
  const [x, y] = centre(buildings.get(id)!.ring);
  return bandFor(heightAt(terrain, x, y), hwAt(flood.hw, x, y));
};
const itemsIn = (building: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of loot) if (l.building === building) for (const it of l.items) m.set(it.itemId, (m.get(it.itemId) ?? 0) + it.qty);
  return m;
};
const fixedIds = new Set(world.fixedLoot.map((f) => f.building));

describe('ground loot', () => {
  it('the camp armoury holds rifles, ammunition and magazines; the store holds the air rifle and pellets', () => {
    expect(world.fixedLoot.length).toBe(2);
    const armoury = itemsIn('w52037660');
    expect(armoury.get('rifle_l403a1')).toBeGreaterThanOrEqual(2);
    expect(armoury.get('round')).toBeGreaterThan(0);
    expect(armoury.get('magazine_30')).toBeGreaterThan(0);
    expect(armoury.has('air_rifle')).toBe(false);
    const store = itemsIn('w52037654');
    expect(store.get('air_rifle')).toBe(1);
    // Thousands of pellets, in tins of 500.
    expect((store.get('pellet_tin') ?? 0) * 500).toBeGreaterThanOrEqual(2000);
  });

  it('keeps guns and ammunition to the hand-fixed buildings', () => {
    const guns = ['rifle_l403a1', 'rifle_sa80a3', 'magazine_30', 'round', 'air_rifle', 'pellet_tin'];
    for (const l of loot) for (const it of l.items) if (guns.includes(it.itemId)) expect(fixedIds.has(l.building), `${it.itemId} in ${l.building}`).toBe(true);
  });

  it('has no loot in churches', () => {
    const churches = new Set(features.buildings.filter((b) => b.type === 'church').map((b) => b.id));
    expect(churches.size).toBeGreaterThan(0);
    for (const l of loot) expect(churches.has(l.building), l.building).toBe(false);
  });

  it('buries loot only in scour-zone buildings, and leaves standing buildings intact', () => {
    let buried = 0;
    let intact = 0;
    for (const l of loot) {
      for (const it of l.items) {
        if (it.buried) {
          buried++;
          expect(l.building, 'buried loot outside a building').not.toBe('');
          expect(bandOf(l.building), l.building).toBe(Band.Scour);
        } else if (l.building !== '' && !fixedIds.has(l.building)) {
          intact++;
          expect(bandOf(l.building), l.building).toBe(Band.Above);
        }
      }
    }
    expect(buried).toBeGreaterThan(100);
    expect(intact).toBeGreaterThan(0);
  });

  it('scatters sealed tins in the strandline wrack', () => {
    const inWrack = loot.filter((l) => l.building === '');
    expect(inWrack.length).toBeGreaterThan(50);
    for (const l of inWrack) {
      const o = objectByKey.get(l.obj)!;
      expect(o.kind).toBe('wrack');
      // The generator decides by the 10 m cell the pile is in.
      const cx = (Math.floor(o.x / 10) + 0.5) * 10;
      const cy = (Math.floor(o.y / 10) + 0.5) * 10;
      expect(bandFor(heightAt(terrain, cx, cy), hwAt(flood.hw, cx, cy))).toBe(Band.Strandline);
      for (const it of l.items) expect(it.itemId).toBe('tin_food');
    }
  });

  it('gives shops and pubs more tins than houses, on average', () => {
    const mean = (type: string): number => {
      const ids = features.buildings.filter((b) => b.type === type).map((b) => b.id);
      return ids.reduce((a, id) => a + (itemsIn(id).get('tin_food') ?? 0), 0) / ids.length;
    };
    expect(mean('shop')).toBeGreaterThan(2 * mean('house'));
    expect(mean('pub')).toBeGreaterThan(mean('house'));
  });

  it('puts doors only on standing buildings, on the wall', () => {
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) {
      const b = buildings.get(d.building)!;
      expect(b, d.building).toBeDefined();
      expect(bandOf(d.building), d.building).toBe(Band.Above);
      const o = objectByKey.get(d.obj)!;
      expect(o.kind).toBe('door');
      let near = Infinity;
      for (let k = 1; k < b.ring.length; k++) {
        const [ax, ay] = b.ring[k - 1] as Pt;
        const [bx, by] = b.ring[k] as Pt;
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((o.x - ax) * (bx - ax) + (o.y - ay) * (by - ay)) / L2));
        near = Math.min(near, Math.hypot(o.x - (ax + t * (bx - ax)), o.y - (ay + t * (by - ay))));
      }
      expect(near, d.building).toBeLessThan(0.2);
    }
  });
});
