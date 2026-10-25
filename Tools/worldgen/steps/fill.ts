// Fills the hollows of the height grid and records the trapped lakes.
// lakeid.bin: one Uint16 (little-endian) per height POST (postsX * postsY, row 0 = south), 0 = no lake.
import { readFileSync, writeFileSync } from 'node:fs';
import { labelLakes, priorityFlood } from '../../../src/world/fill';
import { hwAt, parseFlood, type FloodMeta } from '../../../src/world/flood';
import type { LakesMeta } from '../../../src/world/lakes';
import { LandCover, parseTerrain, type TerrainMeta } from '../../../src/world/terrain';
import type { Step } from '../steps';

const dir = 'public/world/';

/** A hollow whose posts sit mostly on Water landcover is Meldon Reservoir or another real water body: fresh. */
const WATER_SHARE = 0.5;

export const fillStep: Step = {
  name: 'fill',
  run() {
    const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
    const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
    const fmeta = JSON.parse(readFileSync(dir + 'flood.json', 'utf8')) as FloodMeta;
    const flood = parseFlood(fmeta, readFileSync(dir + 'bands.bin'), terrain).hw;
    const { postsX: w, postsY: h, cellM } = tmeta;
    const heights = Float64Array.from(terrain.heightsDm, (dm) => dm / 10);
    const filled = priorityFlood(heights, w, h);
    const { lakes, ids } = labelLakes(heights, filled, w, h, {
      cellM,
      markAt: (x, y) => hwAt(flood, x, y),
      isFresh: (_lake, posts) => {
        // A post is the corner of up to four cells; use the cell north-east of it (clamped).
        let water = 0;
        for (const k of posts) {
          const px = Math.min(w - 2, k % w);
          const py = Math.min(h - 2, Math.floor(k / w));
          if (terrain.landcover[py * (w - 1) + px] === LandCover.Water) water++;
        }
        return water / posts.length >= WATER_SHARE;
      },
    });
    const round = (v: number): number => Math.round(v * 100) / 100;
    const meta: LakesMeta = {
      version: 1,
      method:
        'Priority-flood (Barnes, Lehman and Mulla 2014) over the 50 m height posts, 8-connected, the patch edge as outlet. ' +
        'A lake is a group of 8-connected posts sharing one filled level with depth > 0.5 m. Salt if its spill level is at or ' +
        'below the high-water mark (flood.json, interpolated) at its centroid; otherwise fresh. Hollows mostly on Water landcover ' +
        '(Meldon Reservoir) are forced fresh. lakeid.bin: Uint16 LE per height post, 0 = none, else lake id (1-based).',
      cellM,
      postsX: w,
      postsY: h,
      lakes: lakes.map((l) => ({
        id: l.id,
        spill: round(l.spill),
        area: l.area,
        volume: Math.round(l.volume),
        maxDepth: round(l.maxDepth),
        floor: round(l.floor),
        x: Math.round(l.x),
        y: Math.round(l.y),
        salt: l.salt,
      })),
    };
    writeFileSync(dir + 'lakes.json', JSON.stringify(meta, null, 2) + '\n');
    const idBytes = Buffer.alloc(ids.length * 2);
    ids.forEach((id, k) => idBytes.writeUInt16LE(id, k * 2));
    writeFileSync(dir + 'lakeid.bin', idBytes);
    const salt = lakes.filter((l) => l.salt).length;
    console.log(`[worldgen] fill: ${lakes.length} lakes (${salt} salt, ${lakes.length - salt} fresh)`);
  },
};
