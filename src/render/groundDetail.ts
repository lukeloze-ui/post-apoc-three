import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BARRIER_BROKEN, type GroundObject, type GroundTile } from '../world/ground';
import { BOULDER_GREYS, BRIDGE_STONE, CRATER_SPOIL, DEBRIS_MUD, DEBRIS_TIMBER, DEBRIS_WRACK } from '../world/palette';
import { surfaceHeight, type Surface } from '../world/surface';
import { TILE_M } from '../world/terrain';
import { hashStream } from './damage';
import { tileRenderLevel } from './tileReveal';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).
// Shared geometry runs along -Z (north) from its origin; an object's heading h (radians clockwise from north) is a
// turn of -h about +y, and a slope is a pitch about x (positive lifts the -Z end) and a roll about z.

/** Small kinds are hidden when their 500 m block of a tile is farther than this (metres). */
const SMALL_RANGE_M = 400;
const BLOCK_M = TILE_M / 2;
const CAR_LEN_M = 4.3;
const CAR_COLOURS = [0x6a5a50, 0x585c5e, 0x4d5a52, 0x6d6658, 0x5a4a48, 0x70706a] as const;
const HEDGE_COLOURS = [0x4a5a3a, 0x56603e, 0x3f4f35, 0x5e5a3c] as const;
const ROOT_EARTH = [0x4a3a2c, 0x5e5040] as const;
/** Kinds that are split into 500 m blocks and culled by distance. */
const SMALL_KINDS: ReadonlySet<string> = new Set(['rubble', 'wrack', 'plank', 'crater']);

type Slot = 'rubble' | 'trunk' | 'root' | 'car' | 'wrack' | 'plank' | 'hedge' | 'wall' | 'crater';

interface Instance {
  matrix: THREE.Matrix4;
  color: number;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  /** Local-metre rectangle the batch covers. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  small: boolean;
}

interface LoadedTile {
  id: string;
  batches: Batch[];
}

/** A lumpy lump of unit radius with its lower half flattened (a mound) or kept (a blob); jitter is per position. */
function lump(seed: string, detail: number, jitter: number, flatBottom: boolean): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const rnd = hashStream(seed);
  const r = new Map<string, number>();
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) * 100)},${Math.round(p.getY(i) * 100)},${Math.round(p.getZ(i) * 100)}`;
    let f = r.get(key);
    if (f === undefined) {
      f = 1 + (rnd() * 2 - 1) * jitter;
      r.set(key, f);
    }
    p.setXYZ(i, p.getX(i) * f, flatBottom ? Math.max(0, p.getY(i) * f) : p.getY(i) * f, p.getZ(i) * f);
  }
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return geo;
}

/** A closed-ish prism: the section (x, y) pairs run along z from z0 to z1. Shade darkens low vertices. */
function prism(section: readonly (readonly [number, number])[], z0: number, z1: number, baseShade: number): THREE.BufferGeometry {
  const top = Math.max(...section.map((s) => s[1]));
  const pos: number[] = [];
  const col: number[] = [];
  const v = (x: number, y: number, z: number): void => {
    pos.push(x, y, z);
    const s = baseShade + (1 - baseShade) * (y / top);
    col.push(s, s, s);
  };
  const n = section.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = section[i] as [number, number];
    const [bx, by] = section[(i + 1) % n] as [number, number];
    v(ax, ay, z0); v(bx, by, z0); v(bx, by, z1);
    v(ax, ay, z0); v(bx, by, z1); v(ax, ay, z1);
  }
  for (let i = 1; i < n - 1; i++) {
    for (const z of [z0, z1]) {
      v((section[0] as [number, number])[0], (section[0] as [number, number])[1], z);
      v((section[i] as [number, number])[0], (section[i] as [number, number])[1], z);
      v((section[i + 1] as [number, number])[0], (section[i + 1] as [number, number])[1], z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Gives a geometry a flat vertex colour so it can merge with others. */
function shaded(geo: THREE.BufferGeometry, shade: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array<number>(n * 3).fill(shade), 3));
  return g;
}

function box(w: number, h: number, l: number, x: number, y: number, z: number, shade: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y, z);
  return shaded(g, shade);
}

function buildGeometries(): Record<Slot, THREE.BufferGeometry> {
  const paint = (g: THREE.BufferGeometry, shade = 1): THREE.BufferGeometry => shaded(g, shade);
  const trunk = new THREE.CylinderGeometry(0.55, 1, 1, 7, 1);
  trunk.rotateX(-Math.PI / 2);
  trunk.translate(0, 0, -0.5);
  // A root plate: an upturned disc of earth and roots, standing across the trunk's root end.
  const root = lump('root-plate', 1, 0.22, false);
  root.scale(1, 1, 0.22);
  const car = mergeGeometries([
    box(1.8, 0.62, CAR_LEN_M, 0, 0.5, 0, 1),
    box(1.6, 0.58, 2.2, 0, 1.1, 0.2, 0.55),
    box(0.2, 0.55, 0.6, -0.9, 0.3, -1.4, 0.15),
    box(0.2, 0.55, 0.6, 0.9, 0.3, -1.4, 0.15),
    box(0.2, 0.55, 0.6, -0.9, 0.3, 1.4, 0.15),
    box(0.2, 0.55, 0.6, 0.9, 0.3, 1.4, 0.15),
  ]) as THREE.BufferGeometry;
  const rim = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.55, -0.1),
      new THREE.Vector2(0.8, 0.8),
      new THREE.Vector2(0.95, 1),
      new THREE.Vector2(1.25, 0.25),
      new THREE.Vector2(1.5, 0),
    ],
    14,
  );
  rim.deleteAttribute('uv');
  const plank = new THREE.BoxGeometry(1, 1, 1);
  return {
    rubble: paint(lump('rubble', 1, 0.28, true)),
    trunk: paint(trunk),
    root: paint(root),
    car: car,
    wrack: paint(lump('wrack', 1, 0.3, true)),
    plank: paint(plank),
    hedge: prism([[-1.2, 0], [1.2, 0], [0.55, 1.3], [-0.55, 1.3]], -0.5, 0.5, 0.55),
    wall: prism([[-0.22, 0], [0.22, 0], [0.22, 1.3], [-0.22, 1.3]], -0.5, 0.5, 0.8),
    crater: paint(rim),
  };
}

/**
 * Ground detail from the loaded tiles: one InstancedMesh per kind per tile (small kinds per 500 m block of the tile,
 * so they can be hidden beyond SMALL_RANGE_M), all standing on surfaceHeight. At most 9 kinds, so a 3x3 block of
 * tiles costs at most 81 draw calls, plus the quarter-blocks of the busiest tiles: well under 200 in practice.
 * Geometry and material are shared; a tile's instance buffers are freed when it unloads.
 */
export class GroundDetail {
  readonly group = new THREE.Group();
  private readonly geos = buildGeometries();
  private readonly mat = new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true, side: THREE.DoubleSide });
  private readonly tiles = new Map<string, LoadedTile>();

  constructor(private readonly surface: Surface) {
    this.group.name = 'ground-detail';
  }

  /** Ids of the tiles shown. */
  get loaded(): string[] {
    return [...this.tiles.keys()];
  }

  /** Draw calls this adds (batches in view are fewer). */
  get batchCount(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.batches.length;
    return n;
  }

  /** Builds (or rebuilds, if already loaded) the meshes for a tile as the player finds it. */
  setTile(tile: GroundTile): void {
    this.unloadTile(tile.tile);
    const x0 = tile.i * TILE_M;
    const y0 = tile.j * TILE_M;
    const buckets = new Map<string, { slot: Slot; q: number; list: Instance[] }>();
    const add = (slot: Slot, o: { x: number; y: number }, matrix: THREE.Matrix4, color: number): void => {
      const q = SMALL_KINDS.has(slot) ? (o.x >= x0 + BLOCK_M ? 1 : 0) + (o.y >= y0 + BLOCK_M ? 2 : 0) : 0;
      const key = `${slot}-${q}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { slot, q, list: [] }));
      b.list.push({ matrix, color });
    };
    for (const o of tile.objects) this.place(o, add);

    const batches: Batch[] = [];
    const c = new THREE.Color();
    for (const { slot, q, list } of buckets.values()) {
      const mesh = new THREE.InstancedMesh(this.geos[slot], this.mat, list.length);
      mesh.name = `ground-${tile.tile}-${slot}-${q}`;
      list.forEach((inst, k) => {
        mesh.setMatrixAt(k, inst.matrix);
        mesh.setColorAt(k, c.setHex(inst.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      const small = SMALL_KINDS.has(slot);
      batches.push(
        small
          ? { mesh, small, x0: x0 + (q & 1) * BLOCK_M, y0: y0 + (q >> 1) * BLOCK_M, x1: x0 + ((q & 1) + 1) * BLOCK_M, y1: y0 + ((q >> 1) + 1) * BLOCK_M }
          : { mesh, small, x0, y0, x1: x0 + TILE_M, y1: y0 + TILE_M },
      );
    }
    this.tiles.set(tile.tile, { id: tile.tile, batches });
  }

  unloadTile(id: string): void {
    const t = this.tiles.get(id);
    if (!t) return;
    for (const b of t.batches) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    this.tiles.delete(id);
  }

  /** Call each frame: shows tiles at ground level and hides small kinds beyond SMALL_RANGE_M. */
  update(camera: THREE.Camera): void {
    const x = camera.position.x;
    const y = -camera.position.z;
    for (const t of this.tiles.values()) {
      const shown = tileRenderLevel(t.id) === 'ground';
      for (const b of t.batches) {
        if (!shown) {
          b.mesh.visible = false;
          continue;
        }
        const d = Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
        b.mesh.visible = !b.small || d <= SMALL_RANGE_M;
      }
    }
  }

  dispose(): void {
    for (const id of [...this.tiles.keys()]) this.unloadTile(id);
    for (const g of Object.values(this.geos)) g.dispose();
    this.mat.dispose();
    this.group.removeFromParent();
  }

  // ---- placement ----

  private h(x: number, y: number): number {
    return surfaceHeight(this.surface, x, y);
  }

  /**
   * Height and tilt for something centred at (x, y) heading `rot`, half `len` long and half `wid` wide.
   * Pitch lifts the front end; roll lifts the right side.
   */
  private frame(x: number, y: number, rot: number, len: number, wid: number): { h: number; pitch: number; roll: number } {
    const fx = Math.sin(rot);
    const fy = Math.cos(rot);
    const front = this.h(x + fx * len, y + fy * len);
    const back = this.h(x - fx * len, y - fy * len);
    let roll = 0;
    let across = 0;
    if (wid > 0) {
      const right = this.h(x + fy * wid, y - fx * wid);
      const left = this.h(x - fy * wid, y + fx * wid);
      roll = Math.atan2(right - left, 2 * wid);
      across = (right + left) / 2;
    }
    const along = (front + back) / 2;
    return { h: wid > 0 ? (along + across) / 2 : along, pitch: Math.atan2(front - back, 2 * len), roll };
  }

  private static readonly M = new THREE.Matrix4();
  private static readonly Q = new THREE.Quaternion();
  private static readonly E = new THREE.Euler(0, 0, 0, 'YXZ');
  private static readonly P = new THREE.Vector3();
  private static readonly S = new THREE.Vector3();

  private matrix(x: number, h: number, y: number, rot: number, pitch: number, roll: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
    const E = GroundDetail.E.set(pitch, -rot, roll);
    return new THREE.Matrix4().compose(GroundDetail.P.set(x, h, -y), GroundDetail.Q.setFromEuler(E), GroundDetail.S.set(sx, sy, sz));
  }

  private place(o: GroundObject, add: (slot: Slot, o: { x: number; y: number }, m: THREE.Matrix4, color: number) => void): void {
    const rnd = hashStream(o.key);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
    const tone = (hex: number, lo: number, hi: number): number => new THREE.Color(hex).multiplyScalar(lo + (hi - lo) * rnd()).getHex();
    const { x, y, rot, size } = o;
    switch (o.kind) {
      case 'rubble': {
        const r = size / 2;
        const f = this.frame(x, y, rot, r * 0.6, r * 0.6);
        const m = this.matrix(x, f.h - 0.1, y, rot + rnd() * 6, f.pitch * 0.5, f.roll * 0.5, r * (0.85 + 0.3 * rnd()), 0.35 + size * 0.14, r * (0.85 + 0.3 * rnd()));
        add('rubble', o, m, tone(pick(BOULDER_GREYS), 0.85, 1.1));
        break;
      }
      case 'trunk': {
        const girth = 0.14 + size * 0.016;
        const rootH = this.h(x, y);
        const crownH = this.h(x + Math.sin(rot) * size, y + Math.cos(rot) * size);
        const pitch = Math.atan2(crownH - rootH, size);
        add('trunk', o, this.matrix(x, rootH + girth * 0.7, y, rot, pitch, 0, girth, girth, size), tone(pick(DEBRIS_TIMBER), 0.8, 1.1));
        const rp = Math.min(2.6, 0.9 + size * 0.08);
        add('root', o, this.matrix(x, rootH + rp * 0.7, y, rot, 0, 0, rp, rp, rp), pick(ROOT_EARTH));
        break;
      }
      case 'car': {
        const half = size / 2;
        const f = this.frame(x, y, rot, half * 0.8, 0.9);
        const k = size / CAR_LEN_M;
        add('car', o, this.matrix(x, f.h - 0.05, y, rot, f.pitch, f.roll, k, k, k), tone(pick(CAR_COLOURS), 0.85, 1.1));
        break;
      }
      case 'wrack': {
        const r = size / 2;
        const f = this.frame(x, y, rot, r * 0.6, r * 0.6);
        add('wrack', o, this.matrix(x, f.h - 0.05, y, rot, f.pitch * 0.5, f.roll * 0.5, r * (0.8 + 0.4 * rnd()), 0.25 + size * 0.07, r * (0.8 + 0.4 * rnd())), tone(pick(DEBRIS_WRACK), 0.8, 1.1));
        // Planks poking out of the heap.
        const planks = size > 2.2 ? 1 + Math.floor(rnd() * 3) : 0;
        for (let k = 0; k < planks; k++) {
          const a = rnd() * Math.PI * 2;
          const d = r * 0.6 * rnd();
          const px = x + Math.sin(a) * d;
          const py = y + Math.cos(a) * d;
          const len = 1.5 + rnd() * 2.2;
          const m = this.matrix(px, this.h(px, py) + 0.2 + 0.2 * rnd(), py, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5, 0.14 + 0.06 * rnd(), 0.05 + 0.04 * rnd(), len);
          add('plank', { x: px, y: py }, m, tone(pick(DEBRIS_TIMBER), 0.9, 1.3));
        }
        break;
      }
      case 'hedgebank':
      case 'wall': {
        const broken = o.extra === BARRIER_BROKEN;
        const f = this.frame(x, y, rot, size / 2, 0);
        const slot = o.kind === 'wall' ? 'wall' : 'hedge';
        const colour = o.kind === 'wall' ? tone(BRIDGE_STONE, 0.85, 1.1) : tone(broken ? pick(DEBRIS_MUD) : pick(HEDGE_COLOURS), 0.85, 1.1);
        // A broken piece is a low scatter along the line; sunk a little so a slope never leaves a gap under it.
        add(slot, o, this.matrix(x, f.h - 0.25, y, rot, f.pitch, 0, broken ? 1.15 : 1, broken ? 0.3 : 1, size), colour);
        break;
      }
      case 'crater': {
        const r = size / 2;
        const rimH = Math.min(0.5, 0.1 + size * 0.04);
        add('crater', o, this.matrix(x, this.h(x, y) - 0.05, y, rot, 0, 0, r, rimH, r), tone(CRATER_SPOIL, 0.85, 1.1));
        break;
      }
      default:
        // 'door' and 'spot' are not drawn.
        break;
    }
  }
}
