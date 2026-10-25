import { describe, expect, it } from 'vitest';
import {
  buildDamageIndex,
  conditionsAt,
  createDebrisIndex,
  FALLEN_WOOD_FACTOR,
  GLASSY_FACTOR,
  SILT_EFFORT,
  type ConditionsWorld,
} from './conditions';
import type { DistrictTile, Districts } from './districts';
import type { Pt } from './features';
import { createPlayer, type WalkWorld } from '../sim/player';
import { TILES_PER_SIDE, TILE_M, tileId } from './terrain';
import type { GroundType } from '../sim/walking';

const square = (x0: number, y0: number, s: number): Pt[] => [
  [x0, y0],
  [x0 + s, y0],
  [x0 + s, y0 + s],
  [x0, y0 + s],
  [x0, y0],
];

function tiles(): DistrictTile[] {
  const out: DistrictTile[] = [];
  for (let j = 0; j < TILES_PER_SIDE; j++) {
    for (let i = 0; i < TILES_PER_SIDE; i++) {
      out.push({
        id: tileId(i, j),
        i,
        j,
        hw: 300,
        craters: [],
        strikeZones: [],
        fires: [],
        gasHollows: [],
        animals: {},
        pocked: 0,
        wrackDams: [],
        landslips: [],
        siltFlats: [],
        fallenWood: [],
      });
    }
  }
  return out;
}

/**
 * A small fake world in tile (0, 0) and its neighbours: tile (1, 0) fully pocked; a fallen wood at 100..300; a silt
 * flat at 500..700 with a soft patch at its middle; a burning and a glassy strike zone in tile (0, 1); a gas hollow
 * filling the 50 m cell at (850, 850) on days 1 to 5.
 */
function fakeWorld(ground: GroundType = 'field'): ConditionsWorld {
  const ts = tiles();
  const t00 = ts[0]!;
  ts[1]!.pocked = 1;
  t00.fallenWood = [{ id: 'fw-1', woodId: 'w-1', cause: 'mark', share: 1 }];
  t00.siltFlats = [{ id: 'si-1', x: 600, y: 600, r: 142, ring: square(500, 500, 200), softPatches: [{ id: 'sp-1', x: 600, y: 600, r: 10 }] }];
  t00.gasHollows = [{ id: 'gh-1', x: 875, y: 875, r: 36, fromDay: 1, toDay: 5, cells: [[17, 17]] }];
  ts[TILES_PER_SIDE]!.strikeZones = [
    { id: 'sz-0', x: 300, y: TILE_M + 300, r: 100, kind: 'burning' },
    { id: 'sz-1', x: 700, y: TILE_M + 700, r: 100, kind: 'glassy' },
  ];
  const d: Districts = {
    version: 1,
    method: 'test',
    storm: { worstSide: 'west', centre: { e: 0, n: 0, x: 0, y: 0 }, why: 'test' },
    survivors: [],
    bridges: [],
    roadSegments: [],
    tiles: ts,
  };
  return {
    groundTypeAt: () => ground,
    damage: buildDamageIndex(d, [{ id: 'w-1', ring: square(100, 100, 200) }]),
  };
}

describe('conditionsAt', () => {
  const world = fakeWorld();

  it('is plain ground with no damage', () => {
    const c = conditionsAt(900, 100, 0, world);
    expect(c.speedFactor).toBe(1);
    expect(c.effortFactor).toBe(1);
    expect(c.hazards.impassable).toBe(false);
    expect(c.explanation).toBe('field');
  });

  it('slows pocked ground to x0.9 and trips in the dark', () => {
    const c = conditionsAt(TILE_M + 500, 500, 0, world);
    expect(c.speedFactor).toBeCloseTo(0.9, 9);
    expect(c.hazards.tripInDark).toBe(true);
    expect(c.explanation).toBe('pocked ground - a little slow');
  });

  it('slows fallen woodland to x0.2', () => {
    const c = conditionsAt(200, 200, 0, world);
    expect(c.speedFactor).toBeCloseTo(FALLEN_WOOD_FACTOR, 9);
    expect(FALLEN_WOOD_FACTOR).toBe(0.2);
    expect(c.explanation).toBe('fallen woodland - very slow');
  });

  it('makes silt slow and tiring, with a trap risk on soft patches', () => {
    const silt = conditionsAt(520, 520, 0, world);
    expect(silt.speedFactor).toBeCloseTo(0.5, 9);
    expect(silt.effortFactor).toBeCloseTo(SILT_EFFORT, 9);
    expect(silt.effortFactor).toBeGreaterThan(1);
    expect(silt.hazards.trapRisk).toBe(0);
    const soft = conditionsAt(600, 600, 0, world);
    expect(soft.hazards.trapRisk).toBeGreaterThan(0);
  });

  it('refuses burning strike ground and slows glassy ground', () => {
    const burning = conditionsAt(300, TILE_M + 300, 0, world);
    expect(burning.hazards.impassable).toBe(true);
    expect(burning.explanation).toBe('burning ground - impassable');
    const glassy = conditionsAt(700, TILE_M + 700, 0, world);
    expect(glassy.hazards.impassable).toBe(false);
    expect(glassy.speedFactor).toBeCloseTo(GLASSY_FACTOR, 9);
  });

  it('has gas only on days 1 to 5', () => {
    const gas = (day: number): boolean => conditionsAt(860, 860, day, world).hazards.gas;
    expect(gas(0.5)).toBe(false);
    expect(gas(1)).toBe(true);
    expect(gas(3.2)).toBe(true);
    expect(gas(5.9)).toBe(true);
    expect(gas(6)).toBe(false);
    expect(conditionsAt(860, 860, 3, world).explanation).toBe('gas hollow - get out');
  });

  it('turns ground to rubble near loaded rubble objects', () => {
    const debris = createDebrisIndex();
    debris.setTile('t', [{ key: 't:0', kind: 'rubble', x: 950, y: 950, rot: 0, size: 4 }]);
    const w: ConditionsWorld = { ...world, debris };
    expect(conditionsAt(953, 950, 0, w).groundType).toBe('rubble');
    expect(conditionsAt(960, 950, 0, w).groundType).toBe('field');
    debris.removeTile('t');
    expect(conditionsAt(953, 950, 0, w).groundType).toBe('field');
  });

  it('feeds the player: slower through fallen woodland, stopped at burning ground', () => {
    const cw = fakeWorld();
    const walk = (day: number): WalkWorld => ({
      sizeX: 10000,
      sizeY: 10000,
      heightAt: () => 0,
      groundTypeAt: cw.groundTypeAt,
      conditionsAt: (x, y) => conditionsAt(x, y, day, cw),
    });
    const w = walk(0);
    const open = createPlayer(900, 100, 0, w);
    const fallen = createPlayer(200, 200, 0, w);
    expect(fallen.paceMs).toBeCloseTo(open.paceMs * FALLEN_WOOD_FACTOR, 9);
    expect(fallen.conditions?.explanation).toBe('fallen woodland - very slow');
    // Walk east towards the burning zone (edge at x = 200) and stop short of it.
    const p = createPlayer(150, TILE_M + 300, 90, w);
    for (let k = 0; k < 600; k++) p.step(1, { forward: 1, right: 0 }, w);
    expect(p.x).toBeLessThan(200);
    expect(p.x).toBeGreaterThan(195);
  });
});
