// High-water mark per 1 km tile, and the band of every 50 m cell.
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyCells, hwForTile, type FloodMeta, type FloodTile, type Sinusoid } from '../../../src/world/flood';
import { TILES_PER_SIDE, parseTerrain, tileId, type TerrainMeta } from '../../../src/world/terrain';
import { mulberry32 } from '../rng';
import type { Step } from '../steps';

const SEED = 0xf100d001;
const dir = 'public/world/';

export const floodStep: Step = {
  name: 'flood',
  run() {
    const rng = mulberry32(SEED);
    // Three sinusoids, total amplitude 4 m, phases chosen once.
    const field: Sinusoid[] = [
      { amp: 2, kx: 1, ky: 0.5, phase: rng.float(0, 2 * Math.PI) },
      { amp: 1.2, kx: -0.6, ky: 1.4, phase: rng.float(0, 2 * Math.PI) },
      { amp: 0.8, kx: 2, ky: -1, phase: rng.float(0, 2 * Math.PI) },
    ];
    const tiles: FloodTile[] = [];
    const hw = new Float64Array(TILES_PER_SIDE * TILES_PER_SIDE);
    for (let j = 0; j < TILES_PER_SIDE; j++) {
      for (let i = 0; i < TILES_PER_SIDE; i++) {
        const v = Math.round(hwForTile(i, j, field) * 100) / 100;
        hw[j * TILES_PER_SIDE + i] = v;
        tiles.push({ id: tileId(i, j), i, j, hw: v });
      }
    }
    const meta: FloodMeta = {
      version: 1,
      method:
        'hw = 430 - 150 t, t = projection onto the High Willhays (258000,89200) to Priddy (352700,150900) line clamped to 0..1, ' +
        'at the tile centre, plus a +/-4 m field of three sinusoids. Cells are classified against hw bilinearly interpolated ' +
        'between tile centres: 0 above (h > hw), 1 strandline (hw-20 < h <= hw), 2 scour (h <= hw-20). 3 is reserved for trapped lakes.',
      tiles,
    };
    const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
    const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
    writeFileSync(dir + 'flood.json', JSON.stringify(meta, null, 2) + '\n');
    writeFileSync(dir + 'bands.bin', classifyCells(terrain, hw));
  },
};
