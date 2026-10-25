import * as THREE from 'three';
import type { BuildingFeature, BuildingType, Features, Pt, WoodFeature } from '../world/features';
import { STRANDLINE_M, hwAt, type Flood } from '../world/flood';
import { STRAND_MUD } from '../world/palette';
import { surfaceHeight, type Surface } from '../world/surface';
import { CHUNK_M } from './terrainChunks';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).
// Everything here is built per 500 m chunk, from the same rules every visit: tree positions and fates come from a
// position hash, building looks from a hash of the feature id. No RNG.

/** One tree per this many square metres inside a wood (a jittered grid of this cell area). */
const TREE_CELL_M2 = 80;
/** Trees are at full density within this distance of a chunk, then thin geometrically to TREE_MIN_FRACTION. */
const TREE_FULL_M = 250;
const TREE_RANGE_M = 1600;
const TREE_MIN_FRACTION = 0.06;
/** Buildings are not drawn from chunks farther than this; the built-up terrain colour carries them. */
const BUILDING_RANGE_M = 2500;
/** Trees and buildings sink this far into the ground so slopes and coarse terrain LODs don't leave gaps (metres). */
const SINK_M = 0.4;
/** Re-evaluate what to build after the player moves this far. */
const REEVAL_M = 20;
const BUDGET_MS = 6;

/** Below the mark, per tree cell: chance of a stripped standing trunk and of a stump. */
const STRAND_TRUNK_P = 0.08;
const STRAND_STUMP_P = 0.1;
const SCOUR_TRUNK_P = 0.02;
const SCOUR_STUMP_P = 0.05;

/** Above the mark, the share of roofs that are holed. */
const HOLED_ROOF_P = 0.4;
const SLAB_M = 0.3;
const RUIN_MIN_M = 1;
const RUIN_MAX_M = 3;
const MIN_AREA_M2 = 4;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ---- hashing ----

function hash32(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash to [0, 1). */
const hash01 = (a: number, b: number, c: number): number => hash32(a, b, c) / 4294967296;

function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// ---- trees ----

interface TreeItem {
  /** Sort key: the first n items by key are the thinned set, so every mesh of a chunk thins consistently. */
  key: number;
  x: number;
  y: number;
  h: number;
  r: number;
  r2: number;
}

/** Built trees of one chunk. Each mesh holds its instances sorted by key; counts follow the distance fraction. */
interface TreeMeshes {
  meshes: { mesh: THREE.InstancedMesh; keys: Float32Array }[];
}

function pointInRing(ring: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Pt;
    const b = ring[j] as Pt;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function treeFraction(dist: number): number {
  if (dist <= TREE_FULL_M) return 1;
  if (dist > TREE_RANGE_M) return 0;
  return Math.pow(TREE_MIN_FRACTION, (dist - TREE_FULL_M) / (TREE_RANGE_M - TREE_FULL_M));
}

/** Number of leading keys (ascending) that are below f. */
function countBelow(keys: Float32Array, f: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid] as number) < f) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Unit tapered trunk: base at y = 0, height 1, bottom radius 1, top radius 0.65. */
function trunkGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.65, 1, 1, 5, 1, true).translate(0, 0.5, 0);
}
/** Unit cone: base at y = 0, height 1, base radius 1. */
function coneGeometry(): THREE.BufferGeometry {
  return new THREE.ConeGeometry(1, 1, 7, 1, true).translate(0, 0.5, 0);
}

// ---- buildings ----

type P3 = [number, number, number];

/** Triangles in local coordinates (x east, y north, h up), written out as world positions with flat colours. */
class Soup {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  tri(a: P3, b: P3, c: P3, color: THREE.Color): void {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[2], -p[1]);
      this.col.push(color.r, color.g, color.b);
    }
  }

  quad(a: P3, b: P3, c: P3, d: P3, color: THREE.Color): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }
}

interface Look {
  /** Height in metres, roof included. */
  height: number;
  pitched: boolean;
  walls: readonly number[];
  roofs: readonly number[];
}

const SLATE = [0x5f636b, 0x6c6e72];
const TILE = [0x7a4a3a, 0x6a4a40];
const RENDER = [0xa59c88, 0x8f8a80, 0x8a5e4a, 0xb0a48c];

const LOOKS: Readonly<Record<BuildingType, Look>> = {
  house: { height: 6, pitched: true, walls: RENDER, roofs: [...SLATE, ...TILE] },
  farm: { height: 7, pitched: true, walls: [0x8f8a7c, 0x9a9482], roofs: [0x5a5550, 0x6f7570] },
  shop: { height: 8, pitched: false, walls: [0x9a8f7c, 0x8a6a55], roofs: [0x55524e] },
  church: { height: 7, pitched: true, walls: [0x948f85], roofs: [0x5c6066] },
  industrial: { height: 8, pitched: false, walls: [0x707873, 0x7c7f7a], roofs: [0x5c625f] },
  military: { height: 6, pitched: false, walls: [0x6b6f55, 0x727660], roofs: [0x6a6e58] },
  school: { height: 7, pitched: true, walls: [0x8c6a55, 0x9a8f7c], roofs: SLATE },
  pub: { height: 7, pitched: true, walls: [0xa09078, 0x8f8a80], roofs: SLATE },
  other: { height: 4, pitched: false, walls: [0x80796e, 0x6f6a60], roofs: [0x5a5652] },
};
const CONCRETE = 0x777470;
const CHURCH_TOWER_M = 15;
const CHURCH_TOWER_CAP_M = 2.5;
const CHURCH_TOWER_RUIN_M = 4;

/** A footprint ring as open, counter-clockwise points; null if it is too small to bother with. */
function prepRing(ring: readonly Pt[]): [number, number][] | null {
  const pts: [number, number][] = ring.map((p) => [p[0], p[1]]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) pts.pop();
  if (pts.length < 3) return null;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as [number, number];
    const b = pts[(i + 1) % pts.length] as [number, number];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) / 2 < MIN_AREA_M2) return null;
  return area < 0 ? pts.reverse() : pts;
}

function isConvex(ring: readonly [number, number][]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i] as [number, number];
    const b = ring[(i + 1) % n] as [number, number];
    const c = ring[(i + 2) % n] as [number, number];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -1e-6) return false;
  }
  return true;
}

/** Triangles of a flat polygon at height h, facing up. Skips the ones the keep callback rejects. */
function flatPolygon(
  soup: Soup,
  ring: readonly [number, number][],
  h: number,
  color: THREE.Color,
  keep: (k: number, count: number) => boolean = () => true,
): void {
  const tris = THREE.ShapeUtils.triangulateShape(
    ring.map((p) => new THREE.Vector2(p[0], p[1])),
    [],
  );
  tris.forEach((t, k) => {
    if (!keep(k, tris.length)) return;
    const a = ring[t[0] as number] as [number, number];
    const b = ring[t[1] as number] as [number, number];
    const c = ring[t[2] as number] as [number, number];
    const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0;
    soup.tri([a[0], a[1], h], up ? [b[0], b[1], h] : [c[0], c[1], h], up ? [c[0], c[1], h] : [b[0], b[1], h], color);
  });
}

/** Walls round a counter-clockwise ring, from each vertex's own ground height to its top height. */
function walls(
  soup: Soup,
  ring: readonly [number, number][],
  bottoms: readonly number[],
  tops: readonly number[],
  color: THREE.Color,
): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = ring[i] as [number, number];
    const b = ring[j] as [number, number];
    soup.quad(
      [a[0], a[1], bottoms[i] as number],
      [b[0], b[1], bottoms[j] as number],
      [b[0], b[1], tops[j] as number],
      [a[0], a[1], tops[i] as number],
      color,
    );
  }
}

// ---- the system ----

interface ChunkState {
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  woods: WoodFeature[];
  buildings: BuildingFeature[];
  treesBuilt: boolean;
  buildingsBuilt: boolean;
  trees: TreeMeshes | null;
  buildingMesh: THREE.Mesh | null;
}

function chunkDist(c: ChunkState, x: number, y: number): number {
  const dx = Math.max(c.x0 - x, 0, x - (c.x0 + CHUNK_M));
  const dy = Math.max(c.y0 - y, 0, y - (c.y0 + CHUNK_M));
  return Math.hypot(dx, dy);
}

/**
 * Woods and buildings as the flood left them. Above the mark: instanced low-poly trees and standing buildings, some
 * with holed roofs. In the strandline: a few stripped trunks and stumps, roofless walls 1 to 3 m high. In the scour
 * zone: a few stumps, foundation slabs. Each 500 m chunk is built when the player comes near, then kept; trees thin
 * with distance (the wood's terrain colour carries the canopy far away) and buildings hide beyond a range.
 */
export class WoodsAndBuildings {
  readonly group = new THREE.Group();
  private readonly buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private readonly treeMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  private readonly trunkGeo = trunkGeometry();
  private readonly coneGeo = coneGeometry();
  private readonly blobGeo = new THREE.IcosahedronGeometry(1, 0);
  private readonly chunks: ChunkState[] = [];
  private readonly mud = new THREE.Color(STRAND_MUD);
  private px = Number.NaN;
  private py = Number.NaN;
  private force = true;
  private queue: ChunkState[] = [];

  constructor(
    private readonly surface: Surface,
    features: Features,
    private readonly flood: Flood,
  ) {
    this.group.name = 'woods-and-buildings';
    const nx = Math.ceil(surface.terrain.sizeX / CHUNK_M);
    const ny = Math.ceil(surface.terrain.sizeY / CHUNK_M);
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        this.chunks.push({
          cx,
          cy,
          x0: cx * CHUNK_M,
          y0: cy * CHUNK_M,
          woods: [],
          buildings: [],
          treesBuilt: false,
          buildingsBuilt: false,
          trees: null,
          buildingMesh: null,
        });
      }
    }
    const at = (cx: number, cy: number): ChunkState | undefined =>
      cx < 0 || cy < 0 || cx >= nx || cy >= ny ? undefined : this.chunks[cy * nx + cx];
    for (const w of features.woods) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of w.ring) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      for (let cy = Math.floor(y0 / CHUNK_M); cy <= Math.floor(y1 / CHUNK_M); cy++) {
        for (let cx = Math.floor(x0 / CHUNK_M); cx <= Math.floor(x1 / CHUNK_M); cx++) at(cx, cy)?.woods.push(w);
      }
    }
    for (const b of features.buildings) {
      const p = b.ring[0];
      if (p) at(Math.floor(p[0] / CHUNK_M), Math.floor(p[1] / CHUNK_M))?.buildings.push(b);
    }
  }

  /** Build everything in range now for a player at local (x, y). For the first frame. */
  buildAll(x: number, y: number): void {
    this.update(x, y, Infinity);
  }

  /** Call each frame with the player's local position. */
  update(x: number, y: number, budgetMs = BUDGET_MS): void {
    if (this.force || Math.hypot(x - this.px, y - this.py) > REEVAL_M) {
      this.force = false;
      this.px = x;
      this.py = y;
      this.queue = this.chunks
        .filter((c) => this.treesDue(c) || this.buildingsDue(c))
        .sort((a, b) => chunkDist(a, x, y) - chunkDist(b, x, y));
    }
    // Build what is due, nearest first, within the time budget (at least one chunk per frame).
    const t0 = performance.now();
    let done = 0;
    while (done < this.queue.length && (done === 0 || performance.now() - t0 < budgetMs)) {
      const c = this.queue[done] as ChunkState;
      if (this.treesDue(c)) this.buildTrees(c);
      if (this.buildingsDue(c)) this.buildBuildings(c);
      done++;
    }
    this.queue = this.queue.slice(done);

    // Distance culling and thinning every frame.
    for (const c of this.chunks) {
      const dist = chunkDist(c, x, y);
      if (c.trees) {
        const f = treeFraction(dist);
        for (const m of c.trees.meshes) {
          m.mesh.count = countBelow(m.keys, f);
          m.mesh.visible = m.mesh.count > 0;
        }
      }
      if (c.buildingMesh) c.buildingMesh.visible = dist <= BUILDING_RANGE_M;
    }
  }

  dispose(): void {
    for (const c of this.chunks) {
      c.buildingMesh?.geometry.dispose();
      for (const m of c.trees?.meshes ?? []) m.mesh.dispose();
    }
    this.buildingMat.dispose();
    this.treeMat.dispose();
    this.trunkGeo.dispose();
    this.coneGeo.dispose();
    this.blobGeo.dispose();
    this.group.removeFromParent();
  }

  private treesDue(c: ChunkState): boolean {
    return !c.treesBuilt && c.woods.length > 0 && chunkDist(c, this.px, this.py) <= TREE_RANGE_M;
  }

  private buildingsDue(c: ChunkState): boolean {
    return !c.buildingsBuilt && c.buildings.length > 0 && chunkDist(c, this.px, this.py) <= BUILDING_RANGE_M;
  }

  // ---- trees ----

  private buildTrees(c: ChunkState): void {
    c.treesBuilt = true;
    const s = Math.sqrt(TREE_CELL_M2);
    const trunks: (TreeItem & { kind: 'live' | 'dead' | 'stump' })[] = [];
    const cones: TreeItem[] = [];
    const blobs: TreeItem[] = [];
    const i0 = Math.ceil(c.x0 / s);
    const i1 = Math.ceil((c.x0 + CHUNK_M) / s) - 1;
    const j0 = Math.ceil(c.y0 / s);
    const j1 = Math.ceil((c.y0 + CHUNK_M) / s) - 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + hash01(i, j, 1)) * s;
        const y = (j + hash01(i, j, 2)) * s;
        if (!c.woods.some((w) => pointInRing(w.ring, x, y))) continue;
        const h = surfaceHeight(this.surface, x, y);
        const e = h - hwAt(this.flood.hw, x, y);
        const item: TreeItem = { key: hash01(i, j, 4), x, y, h, r: hash01(i, j, 5), r2: hash01(i, j, 6) };
        if (e > 0) {
          trunks.push({ ...item, kind: 'live' });
          (hash01(i, j, 3) < 0.45 ? blobs : cones).push(item);
        } else {
          const strand = e > -STRANDLINE_M;
          const pTrunk = strand ? STRAND_TRUNK_P : SCOUR_TRUNK_P;
          const pStump = strand ? STRAND_STUMP_P : SCOUR_STUMP_P;
          const f = hash01(i, j, 3);
          if (f < pTrunk) trunks.push({ ...item, kind: 'dead' });
          else if (f < pTrunk + pStump) trunks.push({ ...item, kind: 'stump' });
        }
      }
    }

    const meshes: TreeMeshes['meshes'] = [];
    const dummy = new THREE.Object3D();
    const add = <T extends TreeItem>(
      items: T[],
      geo: THREE.BufferGeometry,
      place: (t: T, o: THREE.Object3D, color: THREE.Color) => void,
    ): void => {
      if (items.length === 0) return;
      items.sort((a, b) => a.key - b.key);
      const mesh = new THREE.InstancedMesh(geo, this.treeMat, items.length);
      const color = new THREE.Color();
      items.forEach((t, k) => {
        dummy.position.set(0, 0, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        place(t, dummy, color);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        mesh.setColorAt(k, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Bounds over every instance, before the count is thinned.
      mesh.computeBoundingSphere();
      meshes.push({ mesh, keys: Float32Array.from(items, (t) => t.key) });
      this.group.add(mesh);
    };

    add(trunks, this.trunkGeo, (t, o, color) => {
      o.position.set(t.x, t.h - SINK_M, -t.y);
      if (t.kind === 'live') {
        const th = this.liveTrunkHeight(t);
        o.scale.set(0.2, th + SINK_M, 0.2);
        color.setHex(0x4a3a2c).multiplyScalar(0.8 + 0.4 * t.r2);
      } else if (t.kind === 'dead') {
        const rad = 0.2 + 0.08 * t.r2;
        o.scale.set(rad, 4.5 + 3.5 * t.r + SINK_M, rad);
        o.rotation.set((t.r2 - 0.5) * 0.12, 0, (t.r - 0.5) * 0.12);
        color.setHex(0x8a8272).multiplyScalar(0.85 + 0.3 * t.r2);
      } else {
        const rad = 0.3 + 0.2 * t.r2;
        o.scale.set(rad, 0.5 + 0.8 * t.r + SINK_M, rad);
        color.setHex(0x6e6150).multiplyScalar(0.85 + 0.3 * t.r);
      }
    });
    add(cones, this.coneGeo, (t, o, color) => {
      const height = 5 + 3 * t.r;
      const rad = 1.6 + 0.9 * t.r2;
      o.position.set(t.x, t.h + this.liveTrunkHeight(t) - 0.5, -t.y);
      o.scale.set(rad, height, rad);
      color.setHex(0x23401f).multiplyScalar(0.8 + 0.4 * t.r2);
    });
    add(blobs, this.blobGeo, (t, o, color) => {
      const rad = 2.2 + 1.4 * t.r2;
      o.position.set(t.x, t.h + this.liveTrunkHeight(t) + rad * 0.5, -t.y);
      o.scale.set(rad, rad * 0.85, rad);
      color.setHex(0x3d5c28).multiplyScalar(0.8 + 0.4 * t.r);
    });
    c.trees = { meshes };
  }

  /** Trunk height under a live crown (the same for the trunk and its crown). */
  private liveTrunkHeight(t: TreeItem): number {
    return 1.8 + 1.4 * t.r;
  }

  // ---- buildings ----

  private buildBuildings(c: ChunkState): void {
    c.buildingsBuilt = true;
    const soup = new Soup();
    for (const b of c.buildings) this.addBuilding(soup, b);
    if (soup.pos.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(soup.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(soup.col, 3));
    // Non-indexed, so every triangle gets its own flat normal.
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.buildingMat);
    mesh.name = `buildings-${c.cx}-${c.cy}`;
    c.buildingMesh = mesh;
    this.group.add(mesh);
  }

  private addBuilding(soup: Soup, b: BuildingFeature): void {
    const ring = prepRing(b.ring);
    if (!ring) return;
    const n = ring.length;
    const gs = ring.map((p) => surfaceHeight(this.surface, p[0], p[1]));
    const floor = Math.max(...gs);
    const bottoms = gs.map((g) => g - SINK_M);
    let mx = 0;
    let my = 0;
    for (const p of ring) {
      mx += p[0] / n;
      my += p[1] / n;
    }
    const e = surfaceHeight(this.surface, mx, my) - hwAt(this.flood.hw, mx, my);
    const sh = strHash(b.id);
    const look = LOOKS[b.type];
    const wallHex = look.walls[sh % look.walls.length] as number;
    const roofHex = look.roofs[(sh >>> 8) % look.roofs.length] as number;
    const church = b.type === 'church';

    if (e > 0) {
      const wallC = new THREE.Color(wallHex);
      const roofC = new THREE.Color(roofHex);
      const holed = hash01(sh, 0, 7) < HOLED_ROOF_P;
      let short = 0.55 * Math.sqrt(areaOf(ring));
      if (n === 4) short = Math.min(dist2(ring[0] as [number, number], ring[1] as [number, number]),
        dist2(ring[1] as [number, number], ring[2] as [number, number]),);
      const gable = look.pitched && n === 4;
      const hip = look.pitched && !gable && isConvex(ring);
      const rh = gable || hip ? clamp(0.3 * short, 1.2, 3) : 0;
      const eave = floor + Math.max(look.height - rh, 2.5);
      walls(soup, ring, bottoms, ring.map(() => eave), wallC);
      if (gable) this.gableRoof(soup, ring, eave, rh, roofC, holed ? sh % 2 : -1);
      else if (hip) {
        const apex: P3 = [mx, my, eave + rh];
        for (let i = 0; i < n; i++) {
          if (holed && (i + sh) % 2 === 0 && (n > 3 || i === 0)) continue;
          const a = ring[i] as [number, number];
          const d = ring[(i + 1) % n] as [number, number];
          soup.tri([a[0], a[1], eave], [d[0], d[1], eave], apex, roofC);
        }
      } else {
        flatPolygon(soup, ring, eave, roofC, holed ? (k) => (k + sh) % 2 === 0 : undefined);
      }
      if (church) this.churchTower(soup, ring, floor, wallC, roofC, CHURCH_TOWER_M, sh, false);
    } else if (e > -STRANDLINE_M) {
      // Roofless: broken walls 1 to 3 m, ragged from vertex to vertex.
      const wh = RUIN_MIN_M + (RUIN_MAX_M - RUIN_MIN_M) * hash01(sh, 0, 8);
      const tops = ring.map((_, i) => floor + wh * (0.5 + 0.5 * hash01(sh, i + 1, 9)));
      const wallC = new THREE.Color(wallHex).lerp(this.mud, 0.45);
      walls(soup, ring, bottoms, tops, wallC);
      if (church) this.churchTower(soup, ring, floor, wallC, wallC, CHURCH_TOWER_RUIN_M, sh, true);
    } else {
      // Scour: a foundation slab and nothing else.
      const slab = new THREE.Color(CONCRETE).lerp(this.mud, 0.25);
      const top = floor + SLAB_M;
      walls(soup, ring, bottoms, ring.map(() => top), slab);
      flatPolygon(soup, ring, top, slab);
    }
  }

  /** Gable roof over a four-cornered footprint, ridge along the long axis. skip = slope index to leave out, or -1. */
  private gableRoof(
    soup: Soup,
    ring: readonly [number, number][],
    eave: number,
    rh: number,
    color: THREE.Color,
    skip: number,
  ): void {
    let [a, b, c, d] = ring as [[number, number], [number, number], [number, number], [number, number]];
    if (dist2(a, b) < dist2(b, c)) [a, b, c, d] = [b, c, d, a];
    const top = eave + rh;
    const r0: P3 = [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, top];
    const r1: P3 = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, top];
    const e = (p: [number, number]): P3 => [p[0], p[1], eave];
    if (skip !== 0) soup.quad(e(a), e(b), r1, r0, color);
    if (skip !== 1) soup.quad(e(c), e(d), r0, r1, color);
    soup.tri(e(b), e(c), r1, color);
    soup.tri(e(d), e(a), r0, color);
  }

  /** A square tower at one end of the footprint's long axis, with a pyramid cap when it still stands. */
  private churchTower(
    soup: Soup,
    ring: readonly [number, number][],
    floor: number,
    wallC: THREE.Color,
    roofC: THREE.Color,
    height: number,
    sh: number,
    ruin: boolean,
  ): void {
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < ring.length; i++) {
      const len = dist2(ring[i] as [number, number], ring[(i + 1) % ring.length] as [number, number]);
      if (len > bestLen) {
        bestLen = len;
        best = i;
      }
    }
    const p = ring[best] as [number, number];
    const q = ring[(best + 1) % ring.length] as [number, number];
    const ux = (q[0] - p[0]) / bestLen;
    const uy = (q[1] - p[1]) / bestLen;
    const vx = -uy;
    const vy = ux;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const r of ring) {
      const u = r[0] * ux + r[1] * uy;
      const v = r[0] * vx + r[1] * vy;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const t = clamp(0.5 * Math.min(u1 - u0, v1 - v0), 2.5, 4.5);
    const uc = sh % 2 === 0 ? u1 - t / 2 : u0 + t / 2;
    const vc = (v0 + v1) / 2;
    const corner = (du: number, dv: number): [number, number] => {
      const u = uc + du * t * 0.5;
      const v = vc + dv * t * 0.5;
      return [u * ux + v * vx, u * uy + v * vy];
    };
    const tower = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const ccw = ux * vy - uy * vx > 0 ? tower : tower.reverse();
    const bottoms = ccw.map((c) => surfaceHeight(this.surface, c[0], c[1]) - SINK_M);
    const top = floor + height;
    walls(soup, ccw, bottoms, ccw.map(() => top), wallC);
    if (ruin) return;
    const [c0, c2] = [ccw[0] as [number, number], ccw[2] as [number, number]];
    const apex: P3 = [(c0[0] + c2[0]) / 2, (c0[1] + c2[1]) / 2, top + CHURCH_TOWER_CAP_M];
    for (let i = 0; i < 4; i++) {
      const a = ccw[i] as [number, number];
      const d = ccw[(i + 1) % 4] as [number, number];
      soup.tri([a[0], a[1], top], [d[0], d[1], top], apex, roofC);
    }
  }
}

function dist2(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number));
}

function areaOf(ring: readonly [number, number][]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as [number, number];
    const b = ring[(i + 1) % ring.length] as [number, number];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}
