import * as THREE from 'three';
import type { BridgeFeature, Features, Pt, RoadClass, WaterFeature } from '../world/features';
import { STRANDLINE_M, hwAt, type Flood } from '../world/flood';
import {
  BRIDGE_STONE,
  RAIL_BALLAST,
  RAIL_CENTRE,
  ROAD_COLORS,
  STRAND_MUD,
  WATER_FRESH,
  WATER_STREAM,
} from '../world/palette';
import type { Districts } from '../world/districts';
import { surfaceHeight, type Surface } from '../world/surface';
import { CHUNK_M } from './terrainChunks';
import { renderLevelAt, showsDamage } from './tileReveal';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).

/** Ribbons are subdivided to at most this far apart (metres). */
const STEP_M = 5;
/** Height of every draped ribbon above the ground (metres); higher classes add a little more so junctions don't fight. */
const DRAPE_M = 0.15;
const CLASS_LIFT_M: Readonly<Record<RoadClass, number>> = { path: 0, track: 0.02, minor: 0.04, B: 0.06, A: 0.08 };
const RAIL_LIFT_M = 0.04;
/** Road widths (metres) by class, and the railway's ballast width. */
const ROAD_WIDTH_M: Readonly<Record<RoadClass, number>> = { A: 9, B: 7, minor: 5, track: 3, path: 1.5 };
const RAIL_WIDTH_M = 4;
const RAIL_CENTRE_HALF_M = 0.8;
const STREAM_WIDTH_M = 2;
/** Rivers are 8 to 12 m wide, fixed per river by a hash of its id. */
const RIVER_MIN_M = 8;
const RIVER_VARY_M = 4;
/** Paths and streams are not drawn from chunks farther than this (metres). */
export const DETAIL_RANGE_M = 1500;

/**
 * The log depth buffer overrides polygonOffset, so draped lines also rise in the vertex shader by this much per
 * metre of view distance (capped), which covers the gap between the ribbon samples and the coarser terrain mesh.
 */
const LIFT_PER_M = 0.0008;
const LIFT_MAX_M = 2.5;

/** Water in a river sits at the lowest ground across its width, never more than this above it (metres). */
const RIVER_FLOAT_M = 0.4;
const RIVER_SMOOTH_PTS = 2;

// Bridge shape (metres).
const BRIDGE_STEP_M = 2.5;
const DECK_DEPTH_M = 0.9;
const KERB_M = 0.4;
const PARAPET_THICK_M = 0.35;
const PARAPET_ROAD_M = 0.9;
const PARAPET_RAIL_M = 0.5;
/** Up to this long a bridge is an arch over the gap; longer ones stand on piers. */
const ARCH_MAX_LEN_M = 30;
const ARCH_OPENING = 0.7;
const ARCH_MIN_RISE_M = 1;
const PIER_SPAN_M = 18;
const PIER_ALONG_M = 1.4;
/** Half the gap a fallen unrecorded crossing leaves in its road or railway, by what it crossed (metres). */
const GAP_HALF_M = { river: 7, stream: 2.5, none: 5 } as const;

/** District damage the linework shows in tiles at district render level or above. */
export interface LineworkDamage {
  districts: Districts;
  /** The surface without the craters, for draping in tiles below district level. */
  plainSurface: Surface;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth01 = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** Which mesh of a chunk a feature goes into. Detail layers hide beyond DETAIL_RANGE_M. */
export type LineworkLayer = 'solid' | 'detail' | 'water' | 'streams';

/** Where a feature's triangles live: an index range in one chunk mesh. A feature crossing chunks has several. */
export interface FeatureRange {
  layer: LineworkLayer;
  cx: number;
  cy: number;
  indexStart: number;
  indexCount: number;
}

interface V {
  x: number;
  y: number;
  z: number;
  c: THREE.Color;
}

/** Growing vertex and index lists for one chunk mesh. */
class MeshData {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly lift: number[] = [];
  readonly idx: number[] = [];

  vert(x: number, y: number, z: number, c: THREE.Color, lift: number): number {
    const k = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.lift.push(lift);
    return k;
  }

  /** A quad from four corners in order around it, wound so its front faces toward (hx, hy, hz). */
  face(a: V, b: V, c: V, d: V, hx: number, hy: number, hz: number): void {
    const ux = c.x - a.x;
    const uy = c.y - a.y;
    const uz = c.z - a.z;
    const vx = d.x - b.x;
    const vy = d.y - b.y;
    const vz = d.z - b.z;
    const dot = (uy * vz - uz * vy) * hx + (uz * vx - ux * vz) * hy + (ux * vy - uy * vx) * hz;
    const q = dot >= 0 ? [a, b, c, d] : [a, d, c, b];
    const i0 = this.vert((q[0] as V).x, (q[0] as V).y, (q[0] as V).z, (q[0] as V).c, 0);
    const i1 = this.vert((q[1] as V).x, (q[1] as V).y, (q[1] as V).z, (q[1] as V).c, 0);
    const i2 = this.vert((q[2] as V).x, (q[2] as V).y, (q[2] as V).z, (q[2] as V).c, 0);
    const i3 = this.vert((q[3] as V).x, (q[3] as V).y, (q[3] as V).z, (q[3] as V).c, 0);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }
}

interface ChunkData {
  cx: number;
  cy: number;
  layers: Partial<Record<LineworkLayer, MeshData>>;
}

/** Points along a polyline, no two farther apart than step; the original vertices are kept. */
function resample(pts: readonly Pt[], step: number): [number, number][] {
  const first = pts[0] as Pt;
  const out: [number, number][] = [[first[0], first[1]]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1] as [number, number];
    const b = pts[i] as Pt;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.01) continue;
    const n = Math.ceil(len / step);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Unit direction at each point (average of the two adjoining segments) and the miter scale for offsets. */
function frames(p: readonly [number, number][]): { dx: Float64Array; dy: Float64Array; miter: Float64Array } {
  const n = p.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const miter = new Float64Array(n).fill(1);
  const seg = (i: number): [number, number] => {
    const a = p[i] as [number, number];
    const b = p[i + 1] as [number, number];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? seg(i - 1) : null;
    const next = i < n - 1 ? seg(i) : null;
    const px = prev ? prev[0] : (next as [number, number])[0];
    const py = prev ? prev[1] : (next as [number, number])[1];
    const nx = next ? next[0] : px;
    const ny = next ? next[1] : py;
    const sx = px + nx;
    const sy = py + ny;
    const l = Math.hypot(sx, sy);
    if (l < 1e-6) {
      dx[i] = px;
      dy[i] = py;
    } else {
      dx[i] = sx / l;
      dy[i] = sy / l;
      miter[i] = 1 / Math.max(0.6, (dx[i] as number) * px + (dy[i] as number) * py);
    }
  }
  return { dx, dy, miter };
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Heights vertically perturbed by the camera distance: see LIFT_PER_M. */
function addDistanceLift(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float lift;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed.y += lift * min(distance(cameraPosition, transformed) * ${LIFT_PER_M}, ${LIFT_MAX_M.toFixed(1)});`,
      );
  };
}

function offsetMaterial<T extends THREE.Material>(mat: T): T {
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  addDistanceLift(mat);
  return mat;
}

/**
 * Roads, railways, rivers, water polygons and bridges as pre-disaster ground-level shapes, merged into one mesh
 * per 500 m chunk and layer. Every feature's triangles are an index range (see ranges), so later damage can find
 * and rewrite one bridge or road. Paths and streams are their own layer and hide beyond DETAIL_RANGE_M.
 */
export class Linework {
  readonly group = new THREE.Group();
  private readonly solidMat = offsetMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
  private readonly riverMat = offsetMaterial(
    new THREE.MeshPhongMaterial({ color: WATER_FRESH, specular: 0x7a8a90, shininess: 90 }),
  );
  private readonly streamMat = offsetMaterial(
    new THREE.MeshPhongMaterial({ color: WATER_STREAM, specular: 0x6a7a80, shininess: 70 }),
  );
  private readonly chunks = new Map<string, ChunkData>();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly byId = new Map<string, FeatureRange[]>();
  private readonly detail: { mesh: THREE.Mesh; cx: number; cy: number }[] = [];
  private readonly nx: number;
  private readonly ny: number;
  private readonly mud = new THREE.Color(STRAND_MUD);
  private readonly stone = new THREE.Color(BRIDGE_STONE);
  private readonly tmp = new THREE.Color();
  /** Gaps cut by fallen unrecorded crossings, by road or rail id. */
  private readonly gaps = new Map<string, { x: number; y: number; half: number }[]>();

  constructor(
    private readonly surface: Surface,
    features: Features,
    private readonly flood: Flood,
    private readonly damage?: LineworkDamage,
  ) {
    this.group.name = 'linework';
    const t = surface.terrain;
    this.nx = Math.ceil(t.sizeX / CHUNK_M);
    this.ny = Math.ceil(t.sizeY / CHUNK_M);

    // Fallen bridges: a recorded bridge loses its whole deck span (its rubble is DistrictDamage's); an unrecorded
    // crossing leaves a gap in the road or railway that crosses.
    const fallen = new Set<string>();
    const kinds = new Map(features.rivers.map((r) => [r.id, r.kind]));
    for (const b of damage?.districts.bridges ?? []) {
      if (b.standing || !showsDamage(renderLevelAt(b.x, b.y))) continue;
      if (b.source === 'osm') fallen.add(b.id);
      else {
        const half = GAP_HALF_M[b.crosses === null ? 'none' : (kinds.get(b.crosses) ?? 'none')];
        let list = this.gaps.get(b.refId);
        if (!list) this.gaps.set(b.refId, (list = []));
        list.push({ x: b.x, y: b.y, half });
      }
    }

    const bridgeIds = new Set(features.bridges.map((b) => b.refId));
    for (const r of features.roads) if (!bridgeIds.has(r.id)) this.addRoad(r.id, r.cls, r.pts);
    for (const r of features.rail) if (!bridgeIds.has(r.id)) this.addRail(r.id, r.pts);
    for (const r of features.rivers) this.addRiver(r.id, r.kind, r.pts);
    for (const w of features.water) this.addWater(w);

    const roads = new Map(features.roads.map((r) => [r.id, r]));
    const rail = new Map(features.rail.map((r) => [r.id, r]));
    for (const b of features.bridges) {
      const road = b.on === 'road' ? roads.get(b.refId) : undefined;
      const carrier = b.on === 'road' ? road : rail.get(b.refId);
      if (carrier && !fallen.has(b.id)) this.addBridge(b, carrier.pts, road?.cls ?? null);
    }
    this.finish();
  }

  /** Index ranges holding a road, rail, river, water or bridge feature (by its features.json id). Empty if none. */
  ranges(id: string): readonly FeatureRange[] {
    return this.byId.get(id) ?? [];
  }

  /** The chunk mesh that a range indexes into. */
  meshFor(r: FeatureRange): THREE.Mesh | undefined {
    return this.meshes.get(`${r.layer}-${r.cx}-${r.cy}`);
  }

  /** Call each frame with the player's local position: hides paths and streams in distant chunks. */
  update(x: number, y: number): void {
    for (const d of this.detail) {
      const x0 = d.cx * CHUNK_M;
      const y0 = d.cy * CHUNK_M;
      const dist = Math.hypot(Math.max(x0 - x, 0, x - (x0 + CHUNK_M)), Math.max(y0 - y, 0, y - (y0 + CHUNK_M)));
      d.mesh.visible = dist <= DETAIL_RANGE_M;
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.geometry.dispose();
    this.solidMat.dispose();
    this.riverMat.dispose();
    this.streamMat.dispose();
    this.group.removeFromParent();
  }

  // ---- bookkeeping ----

  private chunkAt(x: number, y: number): ChunkData {
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor(x / CHUNK_M)));
    const cy = Math.min(this.ny - 1, Math.max(0, Math.floor(y / CHUNK_M)));
    const key = `${cx}-${cy}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { cx, cy, layers: {} };
      this.chunks.set(key, c);
    }
    return c;
  }

  private dataFor(c: ChunkData, layer: LineworkLayer): MeshData {
    return (c.layers[layer] ??= new MeshData());
  }

  private record(id: string, layer: LineworkLayer, c: ChunkData, indexStart: number, indexCount: number): void {
    if (indexCount === 0) return;
    let list = this.byId.get(id);
    if (!list) {
      list = [];
      this.byId.set(id, list);
    }
    list.push({ layer, cx: c.cx, cy: c.cy, indexStart, indexCount });
  }

  /** Mixes a surface colour toward mud by how far below the high-water mark (h) the spot is. */
  private muddy(base: THREE.Color, x: number, y: number, h: number, out: THREE.Color): THREE.Color {
    const e = h - hwAt(this.flood.hw, x, y);
    const k = 0.5 * smooth01((0.5 - e) / 2.5) + 0.2 * smooth01((-e - (STRANDLINE_M - 3)) / 6);
    return out.copy(base).lerp(this.mud, k);
  }

  /** Ground height to drape on: the carved surface where the tile shows damage, the plain one where it doesn't. */
  private ground(x: number, y: number): number {
    const plain = this.damage && !showsDamage(renderLevelAt(x, y));
    return surfaceHeight(plain ? this.damage!.plainSurface : this.surface, x, y);
  }

  /** The resampled line split into the runs left between fallen-crossing gaps (all of it when there are none). */
  private cutGaps(id: string, p: [number, number][]): [number, number][][] {
    const gaps = this.gaps.get(id);
    if (!gaps) return [p];
    const runs: [number, number][][] = [];
    let run: [number, number][] = [];
    for (const q of p) {
      if (gaps.some((g) => Math.hypot(q[0] - g.x, q[1] - g.y) < g.half)) {
        if (run.length >= 2) runs.push(run);
        run = [];
      } else run.push(q);
    }
    if (run.length >= 2) runs.push(run);
    return runs;
  }

  // ---- draped ribbons ----

  /**
   * Cross-section vertices for every point: offsets run right to left of travel. `vertex` returns the height and
   * writes the colour. Packed x, y (local), h, r, g, b.
   */
  private rows(
    p: readonly [number, number][],
    offsets: readonly number[],
    vertex: (x: number, y: number, i: number, k: number, c: THREE.Color) => number,
  ): Float32Array {
    const { dx, dy, miter } = frames(p);
    const K = offsets.length;
    const data = new Float32Array(p.length * K * 6);
    const c = new THREE.Color();
    for (let i = 0; i < p.length; i++) {
      const pt = p[i] as [number, number];
      // Left normal of the direction of travel.
      const lx = -(dy[i] as number) * (miter[i] as number);
      const ly = (dx[i] as number) * (miter[i] as number);
      for (let k = 0; k < K; k++) {
        const o = offsets[k] as number;
        const x = pt[0] + lx * o;
        const y = pt[1] + ly * o;
        const h = vertex(x, y, i, k, c);
        const w = (i * K + k) * 6;
        data[w] = x;
        data[w + 1] = y;
        data[w + 2] = h;
        data[w + 3] = c.r;
        data[w + 4] = c.g;
        data[w + 5] = c.b;
      }
    }
    return data;
  }

  /** Emits rows as ribbons, one piece per run of segments in the same chunk, and records the index ranges. */
  private emitRibbon(
    id: string,
    layer: LineworkLayer,
    p: readonly [number, number][],
    data: Float32Array,
    K: number,
    lift: number,
  ): void {
    let i0 = 0;
    while (i0 < p.length - 1) {
      const a = p[i0] as [number, number];
      const b = p[i0 + 1] as [number, number];
      const chunk = this.chunkAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      let i1 = i0 + 1;
      while (i1 < p.length - 1) {
        const c = p[i1] as [number, number];
        const d = p[i1 + 1] as [number, number];
        if (this.chunkAt((c[0] + d[0]) / 2, (c[1] + d[1]) / 2) !== chunk) break;
        i1++;
      }
      const md = this.dataFor(chunk, layer);
      const start = md.idx.length;
      const base = md.pos.length / 3;
      const c = new THREE.Color();
      for (let i = i0; i <= i1; i++) {
        for (let k = 0; k < K; k++) {
          const w = (i * K + k) * 6;
          c.setRGB(data[w + 3] as number, data[w + 4] as number, data[w + 5] as number);
          md.vert(data[w] as number, data[w + 2] as number, -(data[w + 1] as number), c, lift);
        }
      }
      // Right to left across and forward along: (right, right ahead, left) is counter-clockwise from above.
      for (let i = 0; i < i1 - i0; i++) {
        for (let k = 0; k < K - 1; k++) {
          const ar = base + i * K + k;
          const al = ar + 1;
          const br = ar + K;
          const bl = br + 1;
          md.idx.push(ar, br, al, br, bl, al);
        }
      }
      this.record(id, layer, chunk, start, md.idx.length - start);
      i0 = i1;
    }
  }

  private addRoad(id: string, cls: RoadClass, pts: readonly Pt[]): void {
    if (pts.length < 2) return;
    for (const p of this.cutGaps(id, resample(pts, STEP_M))) this.addRoadRun(id, cls, p);
  }

  private addRoadRun(id: string, cls: RoadClass, p: [number, number][]): void {
    const w = ROAD_WIDTH_M[cls];
    const offsets = cls === 'path' ? [-w / 2, w / 2] : [-w / 2, 0, w / 2];
    const base = new THREE.Color(ROAD_COLORS[cls]);
    const lift = DRAPE_M + CLASS_LIFT_M[cls];
    const data = this.rows(p, offsets, (x, y, _i, _k, c) => {
      const h = this.ground(x, y) + lift;
      this.muddy(base, x, y, h, c);
      return h;
    });
    this.emitRibbon(id, cls === 'path' ? 'detail' : 'solid', p, data, offsets.length, 1);
  }

  private addRail(id: string, pts: readonly Pt[]): void {
    if (pts.length < 2) return;
    for (const p of this.cutGaps(id, resample(pts, STEP_M))) this.addRailRun(id, p);
  }

  private addRailRun(id: string, p: [number, number][]): void {
    const half = RAIL_WIDTH_M / 2;
    const offsets = [-half, -RAIL_CENTRE_HALF_M, RAIL_CENTRE_HALF_M, half];
    const ballast = new THREE.Color(RAIL_BALLAST);
    const centre = new THREE.Color(RAIL_CENTRE);
    const lift = DRAPE_M + RAIL_LIFT_M;
    const data = this.rows(p, offsets, (x, y, _i, k, c) => {
      const h = this.ground(x, y) + lift;
      this.muddy(k === 0 || k === 3 ? ballast : centre, x, y, h, c);
      return h;
    });
    this.emitRibbon(id, 'solid', p, data, offsets.length, 1);
  }

  /**
   * The water surface is flat across the river: the lowest ground across its width, smoothed along it, so the
   * banks rise out of the water where the valley has a floor and a thin film lies on the ground where it doesn't.
   */
  private addRiver(id: string, kind: 'river' | 'stream', pts: readonly Pt[]): void {
    if (pts.length < 2) return;
    const p = resample(pts, STEP_M);
    const width = kind === 'river' ? RIVER_MIN_M + RIVER_VARY_M * hash01(id) : STREAM_WIDTH_M;
    const half = width / 2;
    const { dx, dy, miter } = frames(p);
    const across = [-half, -half / 2, 0, half / 2, half];
    const low = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) {
      const pt = p[i] as [number, number];
      const lx = -(dy[i] as number) * (miter[i] as number);
      const ly = (dx[i] as number) * (miter[i] as number);
      let m = Infinity;
      for (const o of across) m = Math.min(m, this.ground(pt[0] + lx * o, pt[1] + ly * o));
      low[i] = m;
    }
    const level = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - RIVER_SMOOTH_PTS); j <= Math.min(p.length - 1, i + RIVER_SMOOTH_PTS); j++) {
        sum += low[j] as number;
        n++;
      }
      level[i] = Math.min(sum / n, (low[i] as number) + RIVER_FLOAT_M);
    }
    const colour = new THREE.Color(kind === 'river' ? WATER_FRESH : WATER_STREAM);
    const data = this.rows(p, [-half, half], (_x, _y, i, _k, c) => {
      c.copy(colour);
      return level[i] as number;
    });
    this.emitRibbon(id, kind === 'river' ? 'water' : 'streams', p, data, 2, 1);
  }

  /** A flat plane at the median ground height around the shore; higher ground hides it, lower ground shows it. */
  private addWater(w: WaterFeature): void {
    const ring = w.ring.slice();
    const f = ring[0] as Pt;
    const l = ring[ring.length - 1] as Pt;
    if (f[0] === l[0] && f[1] === l[1]) ring.pop();
    if (ring.length < 3) return;
    const heights = resample([...ring, f], STEP_M * 2)
      .map(([x, y]) => this.ground(x, y))
      .sort((a, b) => a - b);
    const level = heights[Math.floor(heights.length / 2)] as number;
    const tris = THREE.ShapeUtils.triangulateShape(
      ring.map((q) => new THREE.Vector2(q[0], q[1])),
      [],
    );
    let cx = 0;
    let cy = 0;
    for (const q of ring) {
      cx += q[0];
      cy += q[1];
    }
    const chunk = this.chunkAt(cx / ring.length, cy / ring.length);
    const md = this.dataFor(chunk, 'water');
    const start = md.idx.length;
    const base = md.pos.length / 3;
    const c = new THREE.Color(WATER_FRESH);
    for (const q of ring) md.vert(q[0], level, -q[1], c, 0);
    for (const t of tris) {
      const a = ring[t[0] as number] as Pt;
      const b = ring[t[1] as number] as Pt;
      const d = ring[t[2] as number] as Pt;
      // Counter-clockwise on the map is up-facing.
      const area = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
      if (area >= 0) md.idx.push(base + (t[0] as number), base + (t[1] as number), base + (t[2] as number));
      else md.idx.push(base + (t[0] as number), base + (t[2] as number), base + (t[1] as number));
    }
    this.record(w.id, 'water', chunk, start, md.idx.length - start);
  }

  // ---- bridges ----

  /**
   * A deck at a straight grade between the ground at its two ends (features.json records no height), never below
   * the ground under it, with kerbs and parapets. Short bridges are walls with an arched opening over a gap; long
   * ones stand on piers. The whole bridge sits in the chunk of its midpoint.
   */
  private addBridge(b: BridgeFeature, pts: readonly Pt[], cls: RoadClass | null): void {
    if (pts.length < 2) return;
    const isRail = b.on === 'rail';
    const layer: LineworkLayer = cls === 'path' ? 'detail' : 'solid';
    const w = isRail ? RAIL_WIDTH_M : ROAD_WIDTH_M[cls ?? 'minor'];
    const lift = DRAPE_M + (isRail ? RAIL_LIFT_M : CLASS_LIFT_M[cls ?? 'minor']);
    const hw = w / 2 + KERB_M;
    const parapetH = isRail ? PARAPET_RAIL_M : PARAPET_ROAD_M;
    const P = resample(pts, BRIDGE_STEP_M);
    const n = P.length;
    const { dx, dy, miter } = frames(P);
    const g = P.map((q) => this.ground(q[0], q[1]));
    const s = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const a = P[i - 1] as [number, number];
      const c = P[i] as [number, number];
      s[i] = (s[i - 1] as number) + Math.hypot(c[0] - a[0], c[1] - a[1]);
    }
    const L = s[n - 1] as number;
    if (L < 0.5) return;
    const gA = (g[0] as number) + lift;
    const gB = (g[n - 1] as number) + lift;
    const y = g.map((gi, i) => Math.max(gA + ((gB - gA) * (s[i] as number)) / L, gi + lift));

    // Arch opening over the middle of a short span, if there is a gap to span.
    const arch = L <= ARCH_MAX_LEN_M;
    const halfOpen = (L * ARCH_OPENING) / 2;
    let spring = Infinity;
    for (let i = 0; i < n; i++) if (Math.abs((s[i] as number) - L / 2) <= halfOpen) spring = Math.min(spring, g[i] as number);
    const crown = (y[Math.floor(n / 2)] as number) - DECK_DEPTH_M - 0.5;
    const hasOpening = arch && crown - spring >= ARCH_MIN_RISE_M;
    const archY = (i: number): number | null => {
      const u = ((s[i] as number) - L / 2) / halfOpen;
      return hasOpening && Math.abs(u) < 1 ? spring + (crown - spring) * Math.sqrt(1 - u * u) : null;
    };
    const bottom = y.map((yi, i) => {
      const a = archY(i);
      if (a !== null) return Math.min(yi - DECK_DEPTH_M, a);
      return arch ? Math.min(yi - DECK_DEPTH_M, (g[i] as number) - 0.3) : yi - DECK_DEPTH_M;
    });

    const stone = this.stone;
    const under = stone.clone().multiplyScalar(0.65);
    const roadBase = new THREE.Color(isRail ? RAIL_BALLAST : ROAD_COLORS[cls ?? 'minor']);
    const centre = new THREE.Color(RAIL_CENTRE);

    /** World-frame corner at path index i, `o` metres left of the centreline, height h. */
    const at = (i: number, o: number, h: number, c: THREE.Color): V => {
      const q = P[i] as [number, number];
      const lx = -(dy[i] as number) * (miter[i] as number);
      const ly = (dx[i] as number) * (miter[i] as number);
      return { x: q[0] + lx * o, y: h, z: -(q[1] + ly * o), c };
    };
    /** Outward normal on side `side` (+1 left, -1 right) in the world frame: z runs south, so the map's (-dy, dx) is (-dy, -dx). */
    const outward = (i: number, side: number): [number, number] => [-(dy[i] as number) * side, -(dx[i] as number) * side];

    const chunk = this.chunkAt(b.x, b.y);
    const md = this.dataFor(chunk, layer);
    const start = md.idx.length;

    for (let i = 0; i < n - 1; i++) {
      const j = i + 1;
      const yi = y[i] as number;
      const yj = y[j] as number;
      // Carriageway (or ballast with its darker bed): road colour muddied by the mark.
      const rowsAcross = isRail ? [-w / 2, -RAIL_CENTRE_HALF_M, RAIL_CENTRE_HALF_M, w / 2] : [-w / 2, w / 2];
      for (let k = 0; k < rowsAcross.length - 1; k++) {
        const colourOf = (kk: number): THREE.Color => {
          const q = P[i] as [number, number];
          const base = isRail && kk > 0 && kk < rowsAcross.length - 1 ? centre : roadBase;
          return this.muddy(base, q[0], q[1], yi, new THREE.Color());
        };
        const c0 = colourOf(k);
        const c1 = colourOf(k + 1);
        md.face(
          at(i, rowsAcross[k] as number, yi, c0),
          at(j, rowsAcross[k] as number, yj, c0),
          at(j, rowsAcross[k + 1] as number, yj, c1),
          at(i, rowsAcross[k + 1] as number, yi, c1),
          0,
          1,
          0,
        );
      }
      for (const side of [1, -1]) {
        const [nxw, nzw] = outward(i, side);
        const inner = (w / 2) * side;
        const kerbOut = (hw - PARAPET_THICK_M) * side;
        const outer = hw * side;
        // Kerb between the carriageway and the parapet, then the parapet's inner face, top and outer face.
        md.face(at(i, inner, yi, stone), at(j, inner, yj, stone), at(j, kerbOut, yj, stone), at(i, kerbOut, yi, stone), 0, 1, 0);
        md.face(
          at(i, kerbOut, yi, stone),
          at(j, kerbOut, yj, stone),
          at(j, kerbOut, yj + parapetH, stone),
          at(i, kerbOut, yi + parapetH, stone),
          -nxw,
          0,
          -nzw,
        );
        md.face(
          at(i, kerbOut, yi + parapetH, stone),
          at(j, kerbOut, yj + parapetH, stone),
          at(j, outer, yj + parapetH, stone),
          at(i, outer, yi + parapetH, stone),
          0,
          1,
          0,
        );
        md.face(
          at(i, outer, (bottom[i] as number), stone),
          at(j, outer, (bottom[j] as number), stone),
          at(j, outer, yj + parapetH, stone),
          at(i, outer, yi + parapetH, stone),
          nxw,
          0,
          nzw,
        );
      }
      // Underside: flat between piers, or the arch soffit inside the opening.
      const ai = archY(i);
      const aj = archY(j);
      if (!arch) {
        md.face(
          at(i, -hw, bottom[i] as number, under),
          at(j, -hw, bottom[j] as number, under),
          at(j, hw, bottom[j] as number, under),
          at(i, hw, bottom[i] as number, under),
          0,
          -1,
          0,
        );
      } else if (ai !== null && aj !== null) {
        md.face(at(i, -hw, ai, under), at(j, -hw, aj, under), at(j, hw, aj, under), at(i, hw, ai, under), 0, -1, 0);
      }
    }

    if (!arch) {
      const spans = Math.max(1, Math.ceil(L / PIER_SPAN_M));
      for (let m = 1; m < spans; m++) {
        const target = (L * m) / spans;
        let i = 0;
        while (i < n - 1 && (s[i] as number) < target) i++;
        const q = P[i] as [number, number];
        const top = bottom[i] as number;
        const foot = (g[i] as number) - 1.5;
        if (top - (g[i] as number) < 0.8) continue;
        const ax = dx[i] as number;
        const ay = dy[i] as number;
        const half = Math.max(0.75, hw - 0.6);
        // Pier box corners on the map, then four outward faces.
        const corner = (a: number, c: number): [number, number] => [
          q[0] + ax * a * PIER_ALONG_M - ay * c * half,
          q[1] + ay * a * PIER_ALONG_M + ax * c * half,
        ];
        const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        for (let e = 0; e < 4; e++) {
          const p0 = ring[e] as [number, number];
          const p1 = ring[(e + 1) % 4] as [number, number];
          const mx = (p0[0] + p1[0]) / 2 - q[0];
          const my = (p0[1] + p1[1]) / 2 - q[1];
          md.face(
            { x: p0[0], y: foot, z: -p0[1], c: stone },
            { x: p1[0], y: foot, z: -p1[1], c: stone },
            { x: p1[0], y: top, z: -p1[1], c: stone },
            { x: p0[0], y: top, z: -p0[1], c: stone },
            mx,
            0,
            -my,
          );
        }
      }
    }
    this.record(b.id, layer, chunk, start, md.idx.length - start);
  }

  // ---- meshes ----

  private finish(): void {
    for (const c of this.chunks.values()) {
      for (const layer of ['solid', 'detail', 'water', 'streams'] as const) {
        const md = c.layers[layer];
        if (!md || md.idx.length === 0) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(md.pos, 3));
        if (layer === 'solid' || layer === 'detail') geo.setAttribute('color', new THREE.Float32BufferAttribute(md.col, 3));
        geo.setAttribute('lift', new THREE.Float32BufferAttribute(md.lift, 1));
        geo.setIndex(new THREE.Uint32BufferAttribute(md.idx, 1));
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        const mat =
          layer === 'water' ? this.riverMat : layer === 'streams' ? this.streamMat : this.solidMat;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `linework-${layer}-${c.cx}-${c.cy}`;
        this.meshes.set(`${layer}-${c.cx}-${c.cy}`, mesh);
        this.group.add(mesh);
        if (layer === 'detail' || layer === 'streams') this.detail.push({ mesh, cx: c.cx, cy: c.cy });
      }
    }
  }
}
