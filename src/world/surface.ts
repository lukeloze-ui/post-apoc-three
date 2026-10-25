// The ground surface: smooth interpolation of the 50 m height posts plus fixed small-scale roughness,
// then an optional list of height modifiers (craters later). The terrain mesh and walking both use it,
// so feet match the mesh. Local frame: x metres east, y metres north from the patch's SW corner.
import { LandCover, type Bounds, type Terrain } from './terrain';

/** Changes the ground height in a region, e.g. a crater. Applied in list order after roughness. */
export interface HeightModifier {
  /** Local-metre box outside which apply() leaves the height alone; lets callers skip it cheaply. */
  bounds?: Bounds;
  /** Returns the new height at (x, y) given the height so far. Must be a pure function of its inputs. */
  apply(x: number, y: number, h: number): number;
}

export interface Surface {
  terrain: Terrain;
  /** Roughness amplitude (metres) per landcover cell, same ordering as terrain.landcover. */
  roughAmp: Float32Array;
  modifiers: HeightModifier[];
}

/** Peak roughness (metres) by landcover code: rock and clitter rough, fields and streets smooth. */
export const ROUGHNESS_M: Readonly<Record<number, number>> = {
  [LandCover.MoorGrass]: 0.4,
  [LandCover.Heather]: 0.5,
  [LandCover.Bog]: 0.3,
  [LandCover.Rock]: 0.8,
  [LandCover.Field]: 0.2,
  [LandCover.Wood]: 0.45,
  [LandCover.BuiltUp]: 0.2,
  [LandCover.Water]: 0.2,
  [LandCover.Quarry]: 0.7,
};
export const MAX_ROUGHNESS_M = 0.8;

/** Roughness octaves: lattice spacing in metres and weight (weights sum to 1, so |roughness| <= amplitude). */
const OCT1_M = 8;
const OCT1_W = 0.65;
const OCT2_M = 2.5;
const OCT2_W = 0.35;
/** Fixed hash seeds: the same ground on every visit. Not an RNG. */
const SEED1 = 0x2c1b3c6d;
const SEED2 = 0x297a2d39;

export function createSurface(terrain: Terrain, modifiers: HeightModifier[] = []): Surface {
  const roughAmp = new Float32Array(terrain.landcover.length);
  for (let k = 0; k < roughAmp.length; k++) roughAmp[k] = ROUGHNESS_M[terrain.landcover[k] as number] ?? 0.4;
  return { terrain, roughAmp, modifiers };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// Scratch for the separable interpolation: 4 post indices and weights per axis.
const ix = new Int32Array(4);
const wx = new Float64Array(4);
const iy = new Int32Array(4);
const wy = new Float64Array(4);

/**
 * Catmull-Rom weights along one axis for fractional post coordinate f in [0, n-1]. Falls back to linear in the
 * first and last cell, where a neighbour post is missing. At a post the weights are (0,1,0,0) in both schemes,
 * so the fallback stays continuous.
 */
function axisWeights(f: number, n: number, idx: Int32Array, w: Float64Array): void {
  const i = Math.min(Math.floor(f), n - 2);
  const t = f - i;
  if (i >= 1 && i + 2 <= n - 1) {
    const t2 = t * t;
    const t3 = t2 * t;
    idx[0] = i - 1;
    idx[1] = i;
    idx[2] = i + 1;
    idx[3] = i + 2;
    w[0] = 0.5 * (-t + 2 * t2 - t3);
    w[1] = 0.5 * (2 - 5 * t2 + 3 * t3);
    w[2] = 0.5 * (t + 4 * t2 - 3 * t3);
    w[3] = 0.5 * (t3 - t2);
  } else {
    idx[0] = i;
    idx[1] = i;
    idx[2] = i + 1;
    idx[3] = i + 1;
    w[0] = 0;
    w[1] = 1 - t;
    w[2] = t;
    w[3] = 0;
  }
}

/** Smooth height (metres) of the posts at local (x, y): Catmull-Rom, bilinear in the edge cells. Clamped to the patch. */
export function baseHeight(t: Terrain, x: number, y: number): number {
  const { cellM, postsX, postsY } = t.meta;
  axisWeights(clamp(x / cellM, 0, postsX - 1), postsX, ix, wx);
  axisWeights(clamp(y / cellM, 0, postsY - 1), postsY, iy, wy);
  const h = t.heightsDm;
  let sum = 0;
  for (let b = 0; b < 4; b++) {
    const wb = wy[b] as number;
    if (wb === 0) continue;
    const row = (iy[b] as number) * postsX;
    let r = 0;
    for (let a = 0; a < 4; a++) r += (wx[a] as number) * (h[row + (ix[a] as number)] as number);
    sum += wb * r;
  }
  return sum / 10;
}

/** Integer lattice hash to [-1, 1]. */
function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}

/** Value noise in [-1, 1] on a unit lattice, quintic fade so slopes are continuous too. */
function valueNoise(x: number, y: number, seed: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const u = x - fx;
  const v = y - fy;
  const su = u * u * u * (u * (u * 6 - 15) + 10);
  const sv = v * v * v * (v * (v * 6 - 15) + 10);
  const i = fx | 0;
  const j = fy | 0;
  const a = hash2(i, j, seed);
  const b = hash2(i + 1, j, seed);
  const c = hash2(i, j + 1, seed);
  const d = hash2(i + 1, j + 1, seed);
  return a + (b - a) * su + (c - a + (a - b - c + d) * su) * sv;
}

/** Roughness amplitude at (x, y), bilinear between landcover cell centres so it blends across cell boundaries. */
export function roughnessAmplitude(s: Surface, x: number, y: number): number {
  const { cellM, postsX, postsY } = s.terrain.meta;
  const cx = postsX - 1;
  const cy = postsY - 1;
  const fx = clamp(x / cellM - 0.5, 0, cx - 1);
  const fy = clamp(y / cellM - 0.5, 0, cy - 1);
  const i = Math.min(Math.floor(fx), cx - 2);
  const j = Math.min(Math.floor(fy), cy - 2);
  const u = fx - i;
  const v = fy - j;
  const k = j * cx + i;
  const r = s.roughAmp;
  const a00 = r[k] as number;
  const a10 = r[k + 1] as number;
  const a01 = r[k + cx] as number;
  const a11 = r[k + cx + 1] as number;
  return (a00 * (1 - u) + a10 * u) * (1 - v) + (a01 * (1 - u) + a11 * u) * v;
}

/** Summed value noise rarely nears +-1; this smooth gain (f(1) = 1, monotonic) lets the bumps use the amplitude. */
const GAIN = 1.6;

/** Fixed small-scale roughness (metres) at (x, y): two octaves of hashed value noise, |value| <= amplitude. */
export function roughnessAt(s: Surface, x: number, y: number): number {
  const n =
    OCT1_W * valueNoise(x / OCT1_M, y / OCT1_M, SEED1) +
    OCT2_W * valueNoise(x / OCT2_M + 0.37, y / OCT2_M + 0.71, SEED2);
  return ((GAIN * n) / (1 + (GAIN - 1) * Math.abs(n))) * roughnessAmplitude(s, x, y);
}

function applyModifiers(s: Surface, x: number, y: number, h: number): number {
  for (const m of s.modifiers) {
    const b = m.bounds;
    if (b && (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1)) continue;
    h = m.apply(x, y, h);
  }
  return h;
}

/** Ground height (metres) at local (x, y): smooth posts, roughness, then modifiers. What feet stand on. */
export function surfaceHeight(s: Surface, x: number, y: number): number {
  return applyModifiers(s, x, y, baseHeight(s.terrain, x, y) + roughnessAt(s, x, y));
}

/** Ground height without the roughness, for distant meshes too coarse to show it. Modifiers still apply. */
export function smoothSurfaceHeight(s: Surface, x: number, y: number): number {
  return applyModifiers(s, x, y, baseHeight(s.terrain, x, y));
}
