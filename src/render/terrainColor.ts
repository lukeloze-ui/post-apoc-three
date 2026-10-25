import * as THREE from 'three';
import { STRANDLINE_M, hwAt, type Flood } from '../world/flood';
import {
  BEDROCK,
  CRATER_EARTH,
  CRATER_SPOIL,
  GLASSY,
  GLASSY_SHEEN,
  LANDSLIP_RAW,
  LANDSLIP_SCAR,
  LANDCOVER_COLORS,
  LANDCOVER_DEFAULT,
  SCORCH,
  SCORCH_ASH,
  SCOUR_DARK,
  SCOUR_MUD,
  SILT_FLAT,
  SILT_SHEEN,
  SOFT_PATCH,
  STRAND_DEBRIS,
  STRAND_MUD,
  STRAND_SILT,
  WRACK,
} from '../world/palette';
import { ringContains, type Landslip, type SiltFlat, type StrikeZone } from '../world/districts';
import { spotGrid, type RoundSpot } from '../world/surface';
import { heightAt, type Terrain } from '../world/terrain';
import { renderLevelAt, showsDamage } from './tileReveal';

/**
 * Per-vertex colour hook for the terrain chunks and apron: writes the colour for local (x, y) at height h into out.
 * x, y may lie outside the patch (the apron). Band colouring replaces the default.
 */
export type TerrainColorFn = (x: number, y: number, h: number, out: THREE.Color) => void;

/** Height stops (metres) and colours for the stand-in tint: valley green, moor brown, tor grey. */
const STOPS: ReadonlyArray<readonly [number, number]> = [
  [100, 0x4a6a35],
  [250, 0x5f7a40],
  [380, 0x7a7a4c],
  [500, 0x80714f],
  [620, 0x8d8a82],
];

const stopColors = STOPS.map(([, hex]) => new THREE.Color(hex));

/** Simple height tint, the default colour hook. */
export const heightTint: TerrainColorFn = (_x, _y, h, out) => {
  const first = STOPS[0] as readonly [number, number];
  if (h <= first[0]) {
    out.copy(stopColors[0] as THREE.Color);
    return;
  }
  for (let k = 1; k < STOPS.length; k++) {
    const [h1] = STOPS[k] as readonly [number, number];
    if (h <= h1) {
      const [h0] = STOPS[k - 1] as readonly [number, number];
      out.copy(stopColors[k - 1] as THREE.Color).lerp(stopColors[k] as THREE.Color, (h - h0) / (h1 - h0));
      return;
    }
  }
  out.copy(stopColors[STOPS.length - 1] as THREE.Color);
};

// ---- Band colouring ----

/** The wrack line runs from this far below the mark... */
const WRACK_LOW_M = -2;
/** ...to this far above it. */
const WRACK_HIGH_M = 0.5;
/** Noise jitter (metres) on the height used to pick a band, so the edges aren't contour lines. */
const EDGE_JITTER_M = 0.8;
/** Strandline fades into scour over this height range around its floor (metres). */
const SCOUR_BLEND_M = 3;
/** Slope (rise over run) where bedrock starts to show through scour, and where it is all bedrock. */
const ROCK_SLOPE_LO = 0.3;
const ROCK_SLOPE_HI = 0.7;
/** Fixed hash seeds for the colour noise. Not an RNG. */
const SEED_EDGE = 0x1b873593;
const SEED_WRACK = 0x7feb352d;
const SEED_MOTTLE = 0x4f6cdd1d;
const SEED_TONE = 0x68e31da4;

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) on a lattice of the given spacing (metres). */
function valueNoise(x: number, y: number, spacing: number, seed: number): number {
  const fx = x / spacing;
  const fy = y / spacing;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let u = fx - ix;
  let v = fy - iy;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth01 = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

const col = (hex: number): THREE.Color => new THREE.Color(hex);

/**
 * Colours ground by its own height against the interpolated mark (not the 50 m band raster), so the strandline
 * edge is as sharp as the mesh: landcover above, mottled mud and a dark wrack line in the strandline, stripped
 * mud-grey with bedrock on steep slopes in the scour zone.
 */
export function createBandColorFn(terrain: Terrain, flood: Flood): TerrainColorFn {
  const { cellM, postsX, postsY } = terrain.meta;
  const nx = postsX - 1;
  const ny = postsY - 1;
  const lcColors = new Map<number, THREE.Color>();
  const lcColor = (code: number): THREE.Color => {
    let c = lcColors.get(code);
    if (!c) {
      c = col(LANDCOVER_COLORS[code] ?? LANDCOVER_DEFAULT);
      lcColors.set(code, c);
    }
    return c;
  };
  const mud = col(STRAND_MUD);
  const silt = col(STRAND_SILT);
  const debris = col(STRAND_DEBRIS);
  const wrack = col(WRACK);
  const scourMud = col(SCOUR_MUD);
  const scourDark = col(SCOUR_DARK);
  const rock = col(BEDROCK);
  const above = new THREE.Color();
  const strand = new THREE.Color();
  const scour = new THREE.Color();

  /** Landcover colour, bilinear between the four nearest cell centres so 50 m cells don't show as squares. */
  const landcoverColor = (x: number, y: number, out: THREE.Color): void => {
    const fx = Math.min(nx - 1, Math.max(0, x / cellM - 0.5));
    const fy = Math.min(ny - 1, Math.max(0, y / cellM - 0.5));
    const i = Math.min(Math.floor(fx), nx - 2);
    const j = Math.min(Math.floor(fy), ny - 2);
    const u = fx - i;
    const v = fy - j;
    const lc = terrain.landcover;
    const k = j * nx + i;
    const c00 = lcColor(lc[k] as number);
    const c10 = lcColor(lc[k + 1] as number);
    const c01 = lcColor(lc[k + nx] as number);
    const c11 = lcColor(lc[k + nx + 1] as number);
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;
    out.setRGB(
      c00.r * w00 + c10.r * w10 + c01.r * w01 + c11.r * w11,
      c00.g * w00 + c10.g * w10 + c01.g * w01 + c11.g * w11,
      c00.b * w00 + c10.b * w10 + c01.b * w01 + c11.b * w11,
    );
  };

  return (x, y, h, out) => {
    const hw = hwAt(flood.hw, x, y);
    const e = h - hw + (valueNoise(x, y, 6, SEED_EDGE) - 0.5) * 2 * EDGE_JITTER_M;
    const tone = 0.9 + 0.2 * valueNoise(x, y, 11, SEED_TONE);

    if (e > WRACK_HIGH_M) {
      landcoverColor(x, y, above);
      out.copy(above).multiplyScalar(tone);
      return;
    }

    // Strandline mottle: wet mud, pale silt and debris patches at two scales.
    const m1 = valueNoise(x, y, 4, SEED_MOTTLE);
    const m2 = valueNoise(x, y, 17, SEED_MOTTLE ^ 0x5bd1e995);
    strand.copy(mud).lerp(silt, smooth01((m2 - 0.35) / 0.4)).lerp(debris, smooth01((m1 - 0.55) / 0.25));
    strand.multiplyScalar(tone);

    if (e >= WRACK_LOW_M) {
      // The wrack line: dark, broken into clumps and gaps.
      const w = valueNoise(x, y, 3, SEED_WRACK) * 0.7 + valueNoise(x, y, 9, SEED_WRACK ^ 0x9e3779b9) * 0.3;
      out.copy(strand).lerp(wrack, smooth01((w - 0.3) / 0.2) * 0.9);
      return;
    }

    const toScour = smooth01((-STRANDLINE_M + SCOUR_BLEND_M - e) / (2 * SCOUR_BLEND_M));
    if (toScour <= 0) {
      out.copy(strand);
      return;
    }

    // Scour: stripped mud-grey, bedrock where the slope is steep.
    const gx = (heightAt(terrain, x + 25, y) - heightAt(terrain, x - 25, y)) / 50;
    const gy = (heightAt(terrain, x, y + 25) - heightAt(terrain, x, y - 25)) / 50;
    const slope = Math.hypot(gx, gy) + (m1 - 0.5) * 0.15;
    scour
      .copy(scourMud)
      .lerp(scourDark, smooth01((m2 - 0.4) / 0.4) * 0.7)
      .lerp(rock, smooth01((slope - ROCK_SLOPE_LO) / (ROCK_SLOPE_HI - ROCK_SLOPE_LO)))
      .multiplyScalar(tone);
    out.copy(strand).lerp(scour, toScour);
  };
}

// ---- District damage colouring ----

/** Strike-zone edges are broken up by noise this many radii either side of the radius. */
const STRIKE_EDGE = 0.18;
/** Spoil colour reaches this many radii out from a crater's centre. */
const SPOIL_REACH = 1.7;
const SEED_STRIKE = 0x2545f491;
const SEED_SILT = 0x3c6ef372;

/**
 * Wraps a colour hook with the district damage of tiles at district render level or above: raw earth in crater
 * bowls and spoil on their rims, burnt black ground with ash (burning strike zones) or dark glassy rock (glassy).
 */
export function createDamageColorFn(
  base: TerrainColorFn,
  craters: readonly RoundSpot[],
  strikeZones: readonly StrikeZone[],
  landslips: readonly Landslip[] = [],
  siltFlats: readonly SiltFlat[] = [],
): TerrainColorFn {
  const grid = spotGrid(craters, SPOIL_REACH);
  const slipGrid = spotGrid(landslips, 1);
  const siltGrid = spotGrid(siltFlats, 1);
  const softGrid = spotGrid(
    siltFlats.flatMap((f) => f.softPatches),
    1.3,
  );
  const scar = col(LANDSLIP_SCAR);
  const raw = col(LANDSLIP_RAW);
  const siltCol = col(SILT_FLAT);
  const siltSheen = col(SILT_SHEEN);
  const soft = col(SOFT_PATCH);
  const earth = col(CRATER_EARTH);
  const spoil = col(CRATER_SPOIL);
  const scorch = col(SCORCH);
  const ash = col(SCORCH_ASH);
  const glassy = col(GLASSY);
  const sheen = col(GLASSY_SHEEN);
  const tmp = new THREE.Color();
  return (x, y, h, out) => {
    base(x, y, h, out);
    if (!showsDamage(renderLevelAt(x, y))) return;
    for (const c of grid.near(x, y)) {
      const u = Math.hypot(x - c.x, y - c.y) / c.r;
      if (u >= SPOIL_REACH) continue;
      const m = valueNoise(x, y, 2.5, SEED_MOTTLE);
      if (u < 1) out.lerp(tmp.copy(earth).lerp(spoil, smooth01((u - 0.6) / 0.4) * 0.6), 0.85 - 0.25 * m);
      else out.lerp(spoil, (1 - smooth01((u - 1) / (SPOIL_REACH - 1))) * (0.75 - 0.3 * m));
    }
    for (const f of siltGrid.near(x, y)) {
      if (Math.hypot(x - f.x, y - f.y) > f.r || !ringContains(f.ring, x, y)) continue;
      // Smooth wet grey-brown, with broad pale streaks of sheen.
      const m = valueNoise(x, y, 40, SEED_SILT);
      tmp.copy(siltCol).lerp(siltSheen, smooth01((m - 0.5) / 0.3) * 0.55);
      out.lerp(tmp, 0.88);
    }
    for (const p of softGrid.near(x, y)) {
      const u = Math.hypot(x - p.x, y - p.y) / p.r + (valueNoise(x, y, 5, SEED_SILT ^ 0x1b873593) - 0.5) * 0.4;
      if (u < 1.2) out.lerp(soft, 0.9 * (1 - smooth01((u - 0.7) / 0.5)));
    }
    for (const l of slipGrid.near(x, y)) {
      if (Math.hypot(x - l.x, y - l.y) > l.r || !ringContains(l.ring, x, y)) continue;
      // Raw brown earth, streaked darker where the ground is freshly torn.
      const m = valueNoise(x, y, 6, SEED_SILT ^ 0x7feb352d);
      tmp.copy(scar).lerp(raw, smooth01((m - 0.4) / 0.35));
      out.lerp(tmp, 0.92);
    }
    for (const z of strikeZones) {
      const dx = x - z.x;
      const dy = y - z.y;
      const R = z.r * (1 + STRIKE_EDGE);
      if (dx * dx + dy * dy >= R * R) continue;
      const n = valueNoise(x, y, 14, SEED_STRIKE);
      const u = Math.hypot(dx, dy) / z.r + (n - 0.5) * 2 * STRIKE_EDGE;
      const k = 1 - smooth01((u - 0.85) / 0.15);
      if (k <= 0) continue;
      const m = valueNoise(x, y, 3, SEED_STRIKE ^ 0x68e31da4);
      if (z.kind === 'burning') tmp.copy(scorch).lerp(ash, smooth01((m - 0.45) / 0.35) * 0.8);
      else tmp.copy(glassy).lerp(sheen, smooth01((m - 0.6) / 0.15) * 0.7);
      out.lerp(tmp, k);
    }
  };
}
