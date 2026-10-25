import { TILES_PER_SIDE, tileId, tileOf } from '../world/terrain';

/**
 * How much of a 1 km tile's damage the renderer shows. 'plain': the pre-disaster look. 'district': the district
 * damage (craters, scorched ground, fallen bridges, blocked roads, fire smoke). 'ground': district plus ground detail.
 * Strike-zone smoke is seen from far off whatever the level, and walking always uses the carved surface.
 */
export type TileRenderLevel = 'plain' | 'district' | 'ground';

const groundLoaded = new Set<string>();

/** Tell the renderer which tiles have their ground detail loaded; they render at 'ground' level, the rest at 'district'. */
export function setGroundLoaded(ids: Iterable<string>): void {
  groundLoaded.clear();
  for (const id of ids) groundLoaded.add(id);
}

/** Render level of a tile by its id (tileId): 'ground' while its ground detail is loaded, else 'district'. */
export function tileRenderLevel(id: string): TileRenderLevel {
  return groundLoaded.has(id) ? 'ground' : 'district';
}

const TILE_IDS: string[] = [];
for (let j = 0; j < TILES_PER_SIDE; j++) for (let i = 0; i < TILES_PER_SIDE; i++) TILE_IDS.push(tileId(i, j));

/** Render level of the tile holding local (x, y), clamped to the patch. */
export function renderLevelAt(x: number, y: number): TileRenderLevel {
  const { i, j } = tileOf(x, y);
  return tileRenderLevel(TILE_IDS[j * TILES_PER_SIDE + i] as string);
}

/** True when the level shows district damage. */
export function showsDamage(level: TileRenderLevel): boolean {
  return level !== 'plain';
}
