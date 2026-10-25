import * as THREE from 'three';
import { ringContains, type Districts } from '../world/districts';
import type { Features, Pt } from '../world/features';
import { BOULDER_GREYS, DEBRIS_MUD, DEBRIS_TIMBER, DEBRIS_WRACK } from '../world/palette';
import { surfaceHeight, type Surface } from '../world/surface';
import { PATCH_M } from '../world/geo';
import { TILE_M } from '../world/terrain';
import { hashStream } from './damage';
import { CHUNK_M } from './terrainChunks';
import { renderLevelAt, showsDamage } from './tileReveal';

/** Wrack dams and landslip fans are seen from afar (to plan a way round); fallen trunks are dense and cull sooner. */
const BIG_RANGE_M = 1600;
const TRUNK_RANGE_M = 1200;
/** One lying trunk per this many square metres of fallen wood. */
const TRUNK_CELL_M2 = 110;
/** Spread (radians either side) of the common heading of fallen trunks. */
const FALL_JITTER = 0.18;

interface Piece {
  x: number;
  y: number;
  h: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  tilt: number;
  roll: number;
  color: number;
}

interface Chunk {
  cx: number;
  cy: number;
  jam: Piece[];
  heap: Piece[];
  fallen: Piece[];
  meshes: { mesh: THREE.InstancedMesh; fallen: boolean }[];
}

/**
 * Blockers seen in the landscape: wrack dams (piled trunks, planks and wrack across the river at bridges and
 * narrows), the boulder fan under each landslip, and fallen woodland (dense lying trunks, all the same way). The silt
 * flat and landslip ground colours live in createDamageColorFn. Instanced per 500 m chunk; shown at district level up.
 */
export class BlockerDamage {
  readonly group = new THREE.Group();
  /** Unit cylinder lying along z, thin end at -z. */
  private readonly trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6, 1).rotateX(Math.PI / 2);
  private readonly lumpGeo = new THREE.IcosahedronGeometry(1, 0);
  private readonly mat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly chunks = new Map<string, Chunk>();
  /** Heading of every fallen trunk, radians clockwise from north: the blast ran away from the storm centre. */
  readonly fallHeading: number;

  constructor(
    private readonly surface: Surface,
    features: Features,
    districts: Districts,
  ) {
    this.group.name = 'blockers';
    const c = districts.storm.centre;
    this.fallHeading = Math.atan2(PATCH_M / 2 - c.x, PATCH_M / 2 - c.y);
    const woods = new Map(features.woods.map((w) => [w.id, w]));
    for (const t of districts.tiles) {
      for (const d of t.wrackDams) this.addWrackDam(d.id, d.x, d.y, d.r);
      for (const l of t.landslips) this.addLandslip(l.id, l.x, l.y, l.r);
      for (const f of t.fallenWood) {
        const w = woods.get(f.woodId);
        if (w) this.addFallenWood(f.id, w.ring, t.i * TILE_M, t.j * TILE_M);
      }
    }
    this.finish();
  }

  update(camera: THREE.Camera): void {
    const x = camera.position.x;
    const y = -camera.position.z;
    for (const c of this.chunks.values()) {
      const x0 = c.cx * CHUNK_M;
      const y0 = c.cy * CHUNK_M;
      const shown = showsDamage(renderLevelAt(x0 + 1, y0 + 1));
      const dist = Math.hypot(Math.max(x0 - x, 0, x - (x0 + CHUNK_M)), Math.max(y0 - y, 0, y - (y0 + CHUNK_M)));
      for (const m of c.meshes) m.mesh.visible = shown && dist <= (m.fallen ? TRUNK_RANGE_M : BIG_RANGE_M);
    }
  }

  dispose(): void {
    for (const c of this.chunks.values()) for (const m of c.meshes) m.mesh.dispose();
    this.trunkGeo.dispose();
    this.lumpGeo.dispose();
    this.mat.dispose();
    this.group.removeFromParent();
  }

  private chunkAt(x: number, y: number): Chunk {
    const t = this.surface.terrain;
    const cx = Math.min(Math.ceil(t.sizeX / CHUNK_M) - 1, Math.max(0, Math.floor(x / CHUNK_M)));
    const cy = Math.min(Math.ceil(t.sizeY / CHUNK_M) - 1, Math.max(0, Math.floor(y / CHUNK_M)));
    const key = `${cx}-${cy}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { cx, cy, jam: [], heap: [], fallen: [], meshes: [] };
      this.chunks.set(key, c);
    }
    return c;
  }

  private trunk(kind: 'jam' | 'fallen', x: number, y: number, len: number, girth: number, yaw: number, tilt: number, roll: number, color: number, lift: number): void {
    const h = surfaceHeight(this.surface, x, y) + lift + girth * 0.5;
    this.chunkAt(x, y)[kind].push({ x, y, h, sx: girth, sy: girth, sz: len, yaw, tilt, roll, color });
  }

  private lump(x: number, y: number, sx: number, sy: number, sz: number, yaw: number, color: number): void {
    this.chunkAt(x, y).heap.push({ x, y, h: surfaceHeight(this.surface, x, y) - sy * 0.3, sx, sy, sz, yaw, tilt: 0, roll: 0, color });
  }

  /** A heap of wrack with trunks and planks jammed across it, the long side across the stream's way. */
  private addWrackDam(id: string, x: number, y: number, r: number): void {
    const rnd = hashStream(id);
    const rad = Math.max(r, 6);
    const axis = rnd() * Math.PI; // heading of the dam's long side
    const n = Math.min(70, Math.round(rad * 2.2));
    for (let k = 0; k < n; k++) {
      const u = (rnd() * 2 - 1) * rad;
      const v = (rnd() * 2 - 1) * rad * 0.28;
      const px = x + Math.sin(axis) * u + Math.cos(axis) * v;
      const py = y + Math.cos(axis) * u - Math.sin(axis) * v;
      const lift = rnd() * Math.min(2.2, rad * 0.16) * (1 - Math.abs(u) / rad);
      const plank = rnd() < 0.4;
      const len = plank ? 2.5 + rnd() * 3.5 : 4 + rnd() * 7;
      const girth = plank ? 0.3 + rnd() * 0.25 : 0.25 + rnd() * 0.3;
      const color = new THREE.Color(DEBRIS_TIMBER[Math.floor(rnd() * 3)] as number).multiplyScalar(0.8 + 0.5 * rnd()).getHex();
      this.trunk('jam', px, py, len, girth, axis + (rnd() - 0.5) * 1.3, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5, color, lift);
    }
    for (let k = 0; k < Math.round(rad * 0.7); k++) {
      const u = (rnd() * 2 - 1) * rad * 0.85;
      const px = x + Math.sin(axis) * u + (rnd() - 0.5) * 3;
      const py = y + Math.cos(axis) * u + (rnd() - 0.5) * 3;
      this.lump(px, py, 1.5 + rnd() * 2.2, 0.6 + rnd() * 1.1, 1.5 + rnd() * 2.2, rnd() * 6.3, DEBRIS_WRACK[Math.floor(rnd() * 3)] as number);
    }
  }

  /** Boulders and earth thrown downhill of the scar, widening as they go. */
  private addLandslip(id: string, x: number, y: number, r: number): void {
    const rnd = hashStream(id);
    const e = 15;
    const gx = (surfaceHeight(this.surface, x + e, y) - surfaceHeight(this.surface, x - e, y)) / (2 * e);
    const gy = (surfaceHeight(this.surface, x, y + e) - surfaceHeight(this.surface, x, y - e)) / (2 * e);
    const g = Math.hypot(gx, gy) || 1;
    const dx = -gx / g;
    const dy = -gy / g;
    const n = Math.min(160, Math.round(r * 1.6) + 12);
    for (let k = 0; k < n; k++) {
      const t = Math.sqrt(rnd());
      const along = r * (0.2 + 1.4 * t);
      const across = (rnd() * 2 - 1) * r * (0.4 + 0.5 * t);
      const px = x + dx * along - dy * across;
      const py = y + dy * along + dx * across;
      const mud = rnd() < 0.35;
      const size = (0.5 + rnd() * 1.1) * (1 + 0.5 * t);
      const color = (mud ? DEBRIS_MUD[Math.floor(rnd() * 3)] : BOULDER_GREYS[Math.floor(rnd() * 4)]) as number;
      this.lump(px, py, size * (mud ? 1.8 : 1), size * (mud ? 0.4 : 0.8), size * (mud ? 1.8 : 1.1), rnd() * 6.3, color);
    }
  }

  /** Lying trunks over the part of a wood in one tile, a jittered grid, all pointing the same way. */
  private addFallenWood(id: string, ring: readonly Pt[], tx0: number, ty0: number): void {
    const rnd = hashStream(id);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    x0 = Math.max(x0, tx0);
    x1 = Math.min(x1, tx0 + TILE_M);
    y0 = Math.max(y0, ty0);
    y1 = Math.min(y1, ty0 + TILE_M);
    const s = Math.sqrt(TRUNK_CELL_M2);
    for (let y = y0; y < y1; y += s) {
      for (let x = x0; x < x1; x += s) {
        const px = x + rnd() * s;
        const py = y + rnd() * s;
        const girth = 0.18 + rnd() * 0.22;
        const len = 5 + rnd() * 9;
        const yaw = this.fallHeading + (rnd() - 0.5) * 2 * FALL_JITTER;
        const tilt = (rnd() - 0.5) * 0.1;
        const color = new THREE.Color(DEBRIS_TIMBER[Math.floor(rnd() * 3)] as number).multiplyScalar(0.8 + 0.4 * rnd()).getHex();
        if (px < tx0 || px >= tx0 + TILE_M || py < ty0 || py >= ty0 + TILE_M || !ringContains(ring as Pt[], px, py)) continue;
        this.trunk('fallen', px, py, len, girth, yaw, tilt, 0, color, 0.05);
      }
    }
  }

  private finish(): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const build = (ch: Chunk, list: Piece[], geo: THREE.BufferGeometry, name: string, fallen: boolean): void => {
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, this.mat, list.length);
      mesh.name = `blockers-${name}-${ch.cx}-${ch.cy}`;
      list.forEach((pc, k) => {
        // A heading (clockwise from north) is a turn of -heading about +y, since z = -north.
        e.set(pc.tilt, -pc.yaw, pc.roll);
        m.compose(p.set(pc.x, pc.h, -pc.y), q.setFromEuler(e), s.set(pc.sx, pc.sy, pc.sz));
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, c.setHex(pc.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      ch.meshes.push({ mesh, fallen });
      this.group.add(mesh);
    };
    for (const ch of this.chunks.values()) {
      build(ch, ch.jam, this.trunkGeo, 'jam', false);
      build(ch, ch.heap, this.lumpGeo, 'heap', false);
      build(ch, ch.fallen, this.trunkGeo, 'fallen', true);
      ch.jam = [];
      ch.heap = [];
      ch.fallen = [];
    }
  }
}
