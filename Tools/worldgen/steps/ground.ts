// Ground detail: one file per 1 km tile in public/world/ground/<tileId>.json (see src/world/ground.ts).
// For now every tile is written valid and empty; later steps fill the object lists. Checks the byte budget.
import { mkdirSync, writeFileSync } from 'node:fs';
import { emptyGroundFile, serialiseGround, validateGround, type GroundFile } from '../../../src/world/ground';
import { TILES_PER_SIDE, tileId } from '../../../src/world/terrain';
import type { Step } from '../steps';

const dir = 'public/world/ground/';
/** Warn when one tile's file is larger than this, bytes. */
export const TILE_WARN_BYTES = 120 * 1024;
/** Fail when all tile files together are larger than this, bytes. */
export const TOTAL_MAX_BYTES = 4 * 1024 * 1024;

/** The tile files to write, before serialising. Empty for now. */
export function buildGroundFiles(): GroundFile[] {
  const out: GroundFile[] = [];
  for (let j = 0; j < TILES_PER_SIDE; j++) for (let i = 0; i < TILES_PER_SIDE; i++) out.push(emptyGroundFile(tileId(i, j)));
  return out;
}

/** Budget problems for serialised files: warnings above TILE_WARN_BYTES each, an error above TOTAL_MAX_BYTES in all. */
export function checkGroundBudget(sizes: ReadonlyMap<string, number>): { warnings: string[]; error?: string } {
  const warnings: string[] = [];
  let total = 0;
  for (const [tile, bytes] of sizes) {
    total += bytes;
    if (bytes > TILE_WARN_BYTES) warnings.push(`${tile}: ${(bytes / 1024).toFixed(1)} KB (budget ${TILE_WARN_BYTES / 1024} KB)`);
  }
  const error = total > TOTAL_MAX_BYTES ? `total ${(total / 1048576).toFixed(2)} MB over ${TOTAL_MAX_BYTES / 1048576} MB` : undefined;
  return error ? { warnings, error } : { warnings };
}

export const groundStep: Step = {
  name: 'ground',
  run() {
    const files = buildGroundFiles();
    const text = new Map<string, string>();
    const sizes = new Map<string, number>();
    for (const f of files) {
      const errs = validateGround(f, f.tile);
      if (errs.length > 0) throw new Error(`ground ${f.tile}: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
      const s = serialiseGround(f);
      text.set(f.tile, s);
      sizes.set(f.tile, Buffer.byteLength(s));
    }
    const budget = checkGroundBudget(sizes);
    for (const w of budget.warnings) console.warn(`[worldgen] ground: ${w}`);
    if (budget.error) throw new Error(`ground: ${budget.error}`);
    mkdirSync(dir, { recursive: true });
    for (const [tile, s] of text) writeFileSync(`${dir}${tile}.json`, s);
    const total = [...sizes.values()].reduce((a, b) => a + b, 0);
    const objects = files.reduce((a, f) => a + f.o.length, 0);
    console.log(`[worldgen] ground: ${files.length} tiles, ${objects} objects, ${(total / 1024).toFixed(1)} KB`);
  },
};
