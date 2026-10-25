// The real walkable world: the render surface, roads over landcover, lake water, and the damage blockers.
import { surfaceHeight, type Surface } from '../world/surface';
import { LandCover, landcoverAt } from '../world/terrain';
import { lakeAt, lakeLevelAt, type Lakes } from '../world/lakes';
import { roadAt, type RoadIndex } from '../world/roadIndex';
import type { RoadClass } from '../world/features';
import { conditionsAt, type ConditionsWorld, type DamageIndex, type DebrisIndex } from '../world/conditions';
import type { WalkWorld } from './player';
import type { GroundType } from './walking';

const ROAD_GROUND: Record<RoadClass, GroundType> = { A: 'road', B: 'road', minor: 'road', track: 'track', path: 'path' };

/** Landcover to ground. Built-up land is flood debris now; quarries are rubble; open water is waded as bog. */
const LAND_GROUND: Record<number, GroundType> = {
  [LandCover.MoorGrass]: 'moor_grass',
  [LandCover.Heather]: 'heather',
  [LandCover.Bog]: 'bog',
  [LandCover.Rock]: 'rock',
  [LandCover.Field]: 'field',
  [LandCover.Wood]: 'wood',
  [LandCover.BuiltUp]: 'debris',
  [LandCover.Water]: 'bog',
  [LandCover.Quarry]: 'rubble',
};

export interface WalkWorldSources {
  surface: Surface;
  roads: RoadIndex;
  lakes: Lakes;
  /** Current game day, days since d0-00:00 (GameClock.gameDays). */
  gameDays(): number;
  /** District damage (buildDamageIndex) and the loaded ground debris (createDebrisIndex); either may be left out. */
  damage?: DamageIndex;
  debris?: DebrisIndex;
}

export function createWalkWorld({ surface, roads, lakes, gameDays, damage, debris }: WalkWorldSources): WalkWorld {
  const { terrain } = surface;
  const cond: ConditionsWorld = {
    groundTypeAt(x, y) {
      const road = roadAt(roads, x, y);
      return road ? ROAD_GROUND[road] : (LAND_GROUND[landcoverAt(terrain, x, y)] ?? 'moor_grass');
    },
    waterDepthAt(x, y, day) {
      const lake = lakeAt(lakes, x, y);
      return lake ? lakeLevelAt(lake, day) - surfaceHeight(surface, x, y) : 0;
    },
    damage,
    debris,
  };
  return {
    sizeX: terrain.sizeX,
    sizeY: terrain.sizeY,
    heightAt: (x, y) => surfaceHeight(surface, x, y),
    groundTypeAt: cond.groundTypeAt,
    waterDepthAt: (x, y) => cond.waterDepthAt!(x, y, gameDays()),
    conditionsAt: (x, y) => conditionsAt(x, y, gameDays(), cond),
  };
}
