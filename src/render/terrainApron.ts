import * as THREE from 'three';
import { smoothSurfaceHeight, type Surface } from '../world/surface';
import { heightTint, type TerrainColorFn } from './terrainColor';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).

/** Ring distances (metres) out from the patch edge. The last is well past the fog's far distance. */
const RINGS_M = [0, 50, 150, 400, 900, 1800, 3200, 5000, 8000, 12000, 16000];
/** Edge detail smooths out over this distance... */
const SMOOTH_M = 1500;
/** ...and the ground sinks towards (smoothed edge - APRON_DROP_M) over this one, never below APRON_FLOOR_M. */
const SINK_M = 7000;
const APRON_DROP_M = 120;
const APRON_FLOOR_M = 60;
/** Half-width (in edge samples) of the moving average along the edge. */
const SMOOTH_SAMPLES = 20;

const smoothstep = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/**
 * A low skirt of ground past the patch edge: it starts at the edge heights, smooths and sinks outward and runs
 * on into the fog, so the world edge isn't a cliff seen from the tors.
 */
export function buildTerrainApron(surface: Surface, colorFn: TerrainColorFn = heightTint): THREE.Mesh {
  const { sizeX: W, sizeY: H } = surface.terrain;
  const step = surface.terrain.meta.cellM;
  const px = Math.round(W / step);
  const py = Math.round(H / step);

  // Edge samples counter-clockwise from above, from the SW corner, with outward directions (diagonal at corners).
  const ex: number[] = [];
  const ey: number[] = [];
  const dx: number[] = [];
  const dy: number[] = [];
  const push = (x: number, y: number, ox: number, oy: number): void => {
    ex.push(x);
    ey.push(y);
    dx.push(ox);
    dy.push(oy);
  };
  for (let i = 0; i < px; i++) push(i * step, 0, i === 0 ? -1 : 0, -1);
  for (let j = 0; j < py; j++) push(W, j * step, 1, j === 0 ? -1 : 0);
  for (let i = px; i > 0; i--) push(i * step, H, i === px ? 1 : 0, 1);
  for (let j = py; j > 0; j--) push(0, j * step, -1, j === py ? 1 : 0);
  const m = ex.length;

  const edgeH = ex.map((x, k) => smoothSurfaceHeight(surface, x, ey[k] as number));
  const smoothH = edgeH.map((_, k) => {
    let s = 0;
    for (let o = -SMOOTH_SAMPLES; o <= SMOOTH_SAMPLES; o++) s += edgeH[(k + o + m) % m] as number;
    return s / (2 * SMOOTH_SAMPLES + 1);
  });

  const nr = RINGS_M.length;
  const pos = new Float32Array(nr * m * 3);
  const col = new Float32Array(nr * m * 3);
  const c = new THREE.Color();
  for (let r = 0; r < nr; r++) {
    const d = RINGS_M[r] as number;
    const a = smoothstep(d / SMOOTH_M);
    const b = smoothstep(d / SINK_M);
    for (let k = 0; k < m; k++) {
      const hs = smoothH[k] as number;
      const h1 = (edgeH[k] as number) * (1 - a) + hs * a;
      const h = h1 * (1 - b) + Math.max(APRON_FLOOR_M, hs - APRON_DROP_M) * b;
      const x = (ex[k] as number) + (dx[k] as number) * d;
      const y = (ey[k] as number) + (dy[k] as number) * d;
      const v = (r * m + k) * 3;
      pos[v] = x;
      pos[v + 1] = h;
      pos[v + 2] = -y;
      colorFn(x, y, h, c);
      col[v] = c.r;
      col[v + 1] = c.g;
      col[v + 2] = c.b;
    }
  }

  const idx = new Uint32Array((nr - 1) * m * 6);
  let w = 0;
  for (let r = 0; r < nr - 1; r++) {
    for (let k = 0; k < m; k++) {
      const a = r * m + k;
      const b = r * m + ((k + 1) % m);
      const c2 = a + m;
      const d2 = b + m;
      // Counter-clockwise seen from above (+y).
      idx[w++] = a;
      idx[w++] = c2;
      idx[w++] = b;
      idx[w++] = b;
      idx[w++] = c2;
      idx[w++] = d2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'terrain-apron';
  return mesh;
}
