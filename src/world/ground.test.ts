import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkGroundBudget, TILE_WARN_BYTES, TOTAL_MAX_BYTES } from '../../Tools/worldgen/steps/ground';
import { decodeGround, encodeGround, GroundCache, validateGround, type GroundFile } from './ground';
import { TILES_PER_SIDE, TILE_M, tileId } from './terrain';

const sample: GroundFile = {
  v: 1,
  tile: tileId(3, 4),
  kinds: ['rubble', 'house_spot', 'door'],
  o: [
    [0, 0, 0, 0, 25],
    [1, 5123, 9999, 200, 80, 3],
    [2, 10000, 4500, 64, 9],
  ],
  loot: [{ obj: 1, building: 'b-1', items: [['tin_food', 4, 0], ['water', 2, 1]] }],
  doors: [{ obj: 2, building: 'b-1', locked: true }],
};

describe('ground files', () => {
  it('round trips encode(decode(file))', () => {
    expect(validateGround(sample)).toEqual([]);
    const t = decodeGround(sample);
    const o1 = t.objects[1]!;
    expect(o1).toMatchObject({ key: `${sample.tile}:1`, kind: 'house_spot', size: 8, extra: 3 });
    expect(o1.x).toBeCloseTo(3 * TILE_M + 512.3, 6);
    expect(o1.y).toBeCloseTo(4 * TILE_M + 999.9, 6);
    expect(t.loot[0]!.items[1]).toEqual({ itemId: 'water', qty: 2, buried: true });
    expect(encodeGround(t)).toEqual(sample);
    expect(encodeGround(decodeGround(encodeGround(t)))).toEqual(sample);
  });

  it('rejects bad files', () => {
    expect(validateGround({ ...sample, tile: 'SX0000' })).not.toEqual([]);
    expect(validateGround({ ...sample, o: [[5, 0, 0, 0, 1]] })).not.toEqual([]);
    expect(validateGround({ ...sample, loot: [{ obj: 1, building: '', items: [['no_such', 1, 0]] }] })).not.toEqual([]);
    expect(validateGround(sample, tileId(0, 0))).not.toEqual([]);
  });

  it('every committed tile file validates, one per tile', () => {
    const names = readdirSync('public/world/ground').filter((n) => n.endsWith('.json'));
    const want = new Set<string>();
    for (let j = 0; j < TILES_PER_SIDE; j++) for (let i = 0; i < TILES_PER_SIDE; i++) want.add(`${tileId(i, j)}.json`);
    expect(new Set(names)).toEqual(want);
    let total = 0;
    for (const n of names) {
      const text = readFileSync(`public/world/ground/${n}`, 'utf8');
      total += Buffer.byteLength(text);
      expect(validateGround(JSON.parse(text), n.replace('.json', '')), n).toEqual([]);
    }
    expect(total).toBeLessThanOrEqual(TOTAL_MAX_BYTES);
  });

  it('budget check warns per tile and fails on the total', () => {
    expect(checkGroundBudget(new Map([['a', 10]]))).toEqual({ warnings: [] });
    expect(checkGroundBudget(new Map([['a', TILE_WARN_BYTES + 1]])).warnings).toHaveLength(1);
    const big = new Map<string, number>();
    for (let k = 0; k < 40; k++) big.set(`t${k}`, 110 * 1024);
    expect(checkGroundBudget(big).error).toBeDefined();
  });

  it('cache fetches once and evicts the least recently used tile past capacity', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const tile = url.split('/').pop()!.replace('.json', '');
      return { ok: true, status: 200, json: async () => ({ v: 1, tile, kinds: [], o: [], loot: [], doors: [] }) };
    }) as unknown as typeof fetch;
    const cache = new GroundCache('/g/', fake, 2);
    const a = tileId(0, 0);
    const b = tileId(1, 0);
    const c = tileId(2, 0);
    expect((await cache.get(a)).tile).toBe(a);
    await cache.get(a);
    await cache.get(b);
    await cache.get(a);
    await cache.get(c);
    expect(cache.keys()).toEqual([a, c]);
    expect(calls).toEqual([`/g/${a}.json`, `/g/${b}.json`, `/g/${c}.json`]);
  });
});
