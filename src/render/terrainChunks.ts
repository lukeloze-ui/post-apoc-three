import * as THREE from 'three';
import { smoothSurfaceHeight, surfaceHeight, type Surface } from '../world/surface';
import type { Bounds } from '../world/terrain';
import { heightTint, type TerrainColorFn } from './terrainColor';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).

export const CHUNK_M = 500;

interface Lod {
  /** Grid segments per chunk side. */
  segs: number;
  /** Used while the chunk's nearest point is closer than this (metres). */
  maxDist: number;
  /** Sample the small-scale roughness; coarse levels can't show it and would only alias it. */
  rough: boolean;
  /** Skirt depth (metres), enough to hide the crack against a neighbour one level coarser. */
  skirt: number;
}

/** About 4 m, 8 m, 25 m and 50 m spacing. 25 m and 50 m land on the posts. */
const LODS: readonly Lod[] = [
  { segs: 128, maxDist: 300, rough: true, skirt: 3 },
  { segs: 64, maxDist: 800, rough: true, skirt: 6 },
  { segs: 20, maxDist: 2500, rough: false, skirt: 20 },
  { segs: 10, maxDist: Infinity, rough: false, skirt: 40 },
];
/** The first LODS entries (4 m and 8 m spacing) are fine enough to show small craters. */
const FINE_LEVELS = 2;
/** A chunk keeps its finer level until the player is this far past the threshold, so walking a boundary doesn't thrash. */
const HYSTERESIS_M = 60;
/** Re-evaluate levels after the player moves this far. */
const REEVAL_M = 20;
/** Default per-frame build budget (ms). At least one chunk is built per frame when any are due. */
const BUDGET_MS = 4;

interface Chunk {
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  /** Current LOD index, -1 before the first build. */
  level: number;
  /** Colours are stale (colour hook changed). */
  dirty: boolean;
  queued: boolean;
  mesh: THREE.Mesh;
}

export interface TerrainChunksOptions {
  colorFn?: TerrainColorFn;
  /**
   * The surface a chunk's mesh is built from, by its SW corner: lets tiles below district render level leave the
   * craters out of the mesh (walking still uses the carved surface). Default: the surface given to the constructor.
   */
  surfaceFor?: (x0: number, y0: number) => Surface;
  budgetMs?: number;
}

const tmpColor = new THREE.Color();

function chunkDist(c: Chunk, x: number, y: number): number {
  const dx = Math.max(c.x0 - x, 0, x - (c.x0 + CHUNK_M));
  const dy = Math.max(c.y0 - y, 0, y - (c.y0 + CHUNK_M));
  return Math.hypot(dx, dy);
}

function lodFor(dist: number, current: number): number {
  let want = LODS.findIndex((l) => dist < l.maxDist);
  if (current >= 0 && want > current && dist < (LODS[current] as Lod).maxDist + HYSTERESIS_M) want = current;
  return want;
}

/** One chunk at one level: a grid plus a skirt hanging from its perimeter. Positions are relative to (x0, 0, -y0). */
function buildChunkGeometry(
  surface: Surface,
  colorFn: TerrainColorFn,
  x0: number,
  y0: number,
  lod: Lod,
): THREE.BufferGeometry {
  const n = lod.segs;
  const d = CHUNK_M / n;
  const heightFn = lod.rough ? surfaceHeight : smoothSurfaceHeight;
  // Heights with a one-sample border, so normals come from central differences that match the neighbours'.
  const g = n + 3;
  const hs = new Float64Array(g * g);
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) hs[j * g + i] = heightFn(surface, x0 + (i - 1) * d, y0 + (j - 1) * d);
  }

  const side = n + 1;
  const nGrid = side * side;
  const nPerim = 4 * n;
  const nv = nGrid + nPerim;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * side + i;
      const c = (j + 1) * g + i + 1;
      const h = hs[c] as number;
      pos[k * 3] = i * d;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = -j * d;
      // Normal of (x, h, -north): (-dh/dx, 1, dh/dnorth).
      const hx = ((hs[c + 1] as number) - (hs[c - 1] as number)) / (2 * d);
      const hn = ((hs[c + g] as number) - (hs[c - g] as number)) / (2 * d);
      const inv = 1 / Math.hypot(hx, 1, hn);
      nor[k * 3] = -hx * inv;
      nor[k * 3 + 1] = inv;
      nor[k * 3 + 2] = hn * inv;
      colorFn(x0 + i * d, y0 + j * d, h, tmpColor);
      col[k * 3] = tmpColor.r;
      col[k * 3 + 1] = tmpColor.g;
      col[k * 3 + 2] = tmpColor.b;
    }
  }

  // Perimeter counter-clockwise from above: south edge eastward, east edge northward, north westward, west southward.
  const perim = new Uint32Array(nPerim);
  let p = 0;
  for (let i = 0; i < n; i++) perim[p++] = i;
  for (let j = 0; j < n; j++) perim[p++] = j * side + n;
  for (let i = n; i > 0; i--) perim[p++] = n * side + i;
  for (let j = n; j > 0; j--) perim[p++] = j * side;
  for (let q = 0; q < nPerim; q++) {
    const src = (perim[q] as number) * 3;
    const dst = (nGrid + q) * 3;
    pos[dst] = pos[src] as number;
    pos[dst + 1] = (pos[src + 1] as number) - lod.skirt;
    pos[dst + 2] = pos[src + 2] as number;
    for (let a = 0; a < 3; a++) {
      nor[dst + a] = nor[src + a] as number;
      col[dst + a] = col[src + a] as number;
    }
  }

  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(n * n * 6 + nPerim * 6);
  let w = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const e = c + 1;
      // Counter-clockwise seen from above (+y).
      idx[w++] = a;
      idx[w++] = b;
      idx[w++] = c;
      idx[w++] = b;
      idx[w++] = e;
      idx[w++] = c;
    }
  }
  // Skirt quads face outward.
  for (let q = 0; q < nPerim; q++) {
    const q1 = (q + 1) % nPerim;
    const a = perim[q] as number;
    const b = perim[q1] as number;
    const sa = nGrid + q;
    const sb = nGrid + q1;
    idx[w++] = a;
    idx[w++] = sa;
    idx[w++] = b;
    idx[w++] = b;
    idx[w++] = sa;
    idx[w++] = sb;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The patch as 500 m chunks with distance LOD rings. Chunks whose level changes are rebuilt nearest first in a
 * time-sliced queue; the old geometry stays on screen until its replacement is ready, then is disposed.
 */
export class TerrainChunks {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly chunks: Chunk[] = [];
  private queue: Chunk[] = [];
  private colorFn: TerrainColorFn;
  private readonly budgetMs: number;
  private readonly surfaceFor: (x0: number, y0: number) => Surface;
  private px = Number.NaN;
  private py = Number.NaN;
  private force = true;

  constructor(
    surface: Surface,
    opts: TerrainChunksOptions = {},
  ) {
    this.colorFn = opts.colorFn ?? heightTint;
    this.budgetMs = opts.budgetMs ?? BUDGET_MS;
    this.surfaceFor = opts.surfaceFor ?? (() => surface);
    this.group.name = 'terrain';
    const nx = Math.ceil(surface.terrain.sizeX / CHUNK_M);
    const ny = Math.ceil(surface.terrain.sizeY / CHUNK_M);
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        mesh.name = `terrain-${cx}-${cy}`;
        mesh.position.set(cx * CHUNK_M, 0, -cy * CHUNK_M);
        mesh.visible = false;
        this.group.add(mesh);
        this.chunks.push({ cx, cy, x0: cx * CHUNK_M, y0: cy * CHUNK_M, level: -1, dirty: true, queued: false, mesh });
      }
    }
  }

  /** Chunks waiting to be rebuilt. */
  get pending(): number {
    return this.queue.length;
  }

  /** Replace the per-vertex colour hook; every chunk is recoloured through the queue. */
  setColorFn(fn: TerrainColorFn): void {
    this.colorFn = fn;
    for (const c of this.chunks) c.dirty = true;
    this.force = true;
  }

  /**
   * The ground changed inside this local-metre box (small craters appeared or went): rebuild the chunks it touches
   * that are at a level fine enough to show it (spacing 8 m or less). Coarser chunks pick it up if they get finer.
   */
  invalidate(b: Bounds): void {
    for (const c of this.chunks) {
      if (c.level < 0 || c.level > FINE_LEVELS - 1) continue;
      if (b.x1 < c.x0 || b.x0 > c.x0 + CHUNK_M || b.y1 < c.y0 || b.y0 > c.y0 + CHUNK_M) continue;
      c.dirty = true;
      this.force = true;
    }
  }

  /** Build every chunk now for a player at local (x, y). For the first frame. */
  buildAll(x: number, y: number): void {
    this.update(x, y, Infinity);
  }

  /** Call each frame with the player's local position. */
  update(x: number, y: number, budgetMs = this.budgetMs): void {
    if (this.force || Math.hypot(x - this.px, y - this.py) > REEVAL_M) {
      this.force = false;
      this.px = x;
      this.py = y;
      for (const c of this.chunks) {
        if (!c.queued && (c.dirty || lodFor(chunkDist(c, x, y), c.level) !== c.level)) {
          c.queued = true;
          this.queue.push(c);
        }
      }
      this.queue.sort((a, b) => chunkDist(a, x, y) - chunkDist(b, x, y));
    }
    if (this.queue.length === 0) return;
    const t0 = performance.now();
    let done = 0;
    while (done < this.queue.length && (done === 0 || performance.now() - t0 < budgetMs)) {
      this.rebuild(this.queue[done] as Chunk);
      done++;
    }
    this.queue = this.queue.slice(done);
  }

  private rebuild(c: Chunk): void {
    c.queued = false;
    const level = lodFor(chunkDist(c, this.px, this.py), c.level);
    if (level === c.level && !c.dirty) return;
    const old = c.mesh.geometry;
    c.mesh.geometry = buildChunkGeometry(this.surfaceFor(c.x0, c.y0), this.colorFn, c.x0, c.y0, LODS[level] as Lod);
    c.mesh.visible = true;
    old.dispose();
    c.level = level;
    c.dirty = false;
  }

  dispose(): void {
    for (const c of this.chunks) c.mesh.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
    this.queue = [];
  }
}
