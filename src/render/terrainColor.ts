import * as THREE from 'three';

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
