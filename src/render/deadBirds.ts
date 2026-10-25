import * as THREE from 'three';
import type { Districts } from '../world/districts';
import { surfaceHeight, type Surface } from '../world/surface';
import { GAS_END_DAYS, GAS_START_DAYS } from '../sim/hazards';
import { hashStream } from './damage';

// World frame: x metres east, y metres up, z metres south (so local y north = -z).

/** One dead bird for every this many gas cells, and at least MIN_PER_HOLLOW round each hollow. */
const CELLS_PER_BIRD = 2;
const MIN_PER_HOLLOW = 3;
/** A grey body: length, height and width in metres. A skylark is about 18 cm. */
const BODY = { x: 0.1, y: 0.035, z: 0.05 };
const GREYS = [0x6e6e6a, 0x7d7b74, 0x5c5b57, 0x8a8880];

interface Bird {
  x: number;
  y: number;
  yaw: number;
  size: number;
  grey: number;
  fromDay: number;
  toDay: number;
}

/**
 * Dead birds lying on the ground in the gas hollows, as one instanced mesh of small grey shapes. They appear when the
 * gas does (Day 1 03:00) and go when it clears. Positions come from a hashed stream per hollow, so they never change.
 */
export class DeadBirds {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh | null;
  private readonly birds: Bird[] = [];
  private readonly geo = new THREE.SphereGeometry(1, 6, 4);
  private readonly mat = new THREE.MeshLambertMaterial({ flatShading: true });
  private shownKey = Number.NaN;

  constructor(
    private readonly surface: Surface,
    districts: Districts,
  ) {
    this.group.name = 'dead-birds';
    const cellM = surface.terrain.meta.cellM;
    for (const h of districts.tiles.flatMap((t) => t.gasHollows)) {
      const rnd = hashStream(h.id);
      const n = Math.max(MIN_PER_HOLLOW, Math.round(h.cells.length / CELLS_PER_BIRD));
      for (let k = 0; k < n; k++) {
        const [c, r] = h.cells[Math.floor(rnd() * h.cells.length)] as [number, number];
        this.birds.push({
          x: (c + rnd()) * cellM,
          y: (r + rnd()) * cellM,
          yaw: rnd() * Math.PI * 2,
          size: 0.8 + rnd() * 0.5,
          grey: GREYS[Math.floor(rnd() * GREYS.length)] as number,
          fromDay: Math.max(h.fromDay, GAS_START_DAYS),
          toDay: Math.min(h.toDay + 1, GAS_END_DAYS),
        });
      }
    }
    if (this.birds.length === 0) {
      this.mesh = null;
      return;
    }
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.birds.length);
    this.mesh.name = 'dead-birds-mesh';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  get count(): number {
    return this.mesh?.count ?? 0;
  }

  /** Call each frame with GameClock.gameDays. The instances are rewritten only when the set of live birds changes. */
  update(gameDays: number): void {
    if (!this.mesh) return;
    const key = gameDays < GAS_START_DAYS ? -1 : Math.floor(gameDays);
    if (key === this.shownKey) return;
    this.shownKey = key;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const color = new THREE.Color();
    let n = 0;
    for (const b of this.birds) {
      if (gameDays < b.fromDay || gameDays >= b.toDay) continue;
      // Lying a little tilted on the ground, half sunk into the grass.
      q.setFromEuler(e.set(Math.sin(b.x) * 0.15, b.yaw, Math.cos(b.y) * 0.15));
      m.compose(
        new THREE.Vector3(b.x, surfaceHeight(this.surface, b.x, b.y) + BODY.y * 0.4, -b.y),
        q,
        new THREE.Vector3(BODY.x * b.size, BODY.y * b.size, BODY.z * b.size),
      );
      this.mesh.setMatrixAt(n, m);
      this.mesh.setColorAt(n, color.setHex(b.grey));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh?.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
