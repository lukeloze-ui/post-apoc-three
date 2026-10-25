import * as THREE from 'three';
import type { BlockCause, Districts, Fire, StrikeZone } from '../world/districts';
import type { Features, Pt, RoadClass } from '../world/features';
import {
  BOULDER_GREYS,
  BRIDGE_STONE,
  DEBRIS_MUD,
  DEBRIS_TIMBER,
  DEBRIS_WRACK,
  FIRE_GLOW,
  SMOKE_FIRE,
  SMOKE_STRIKE,
  WATER_FRESH,
} from '../world/palette';
import { CRATER_DEPTH_PER_D, surfaceHeight, type Surface } from '../world/surface';
import { daylightAt, newDaylight } from './daylight';
import { CHUNK_M } from './terrainChunks';
import { renderLevelAt, showsDamage } from './tileReveal';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).

/** Boulders, rubble and debris heaps are drawn only from chunks nearer than this (metres); they are sub-pixel beyond. */
const PIECE_RANGE_M = 800;
/** Standing water in a flagged crater: this fraction of the bowl depth above its floor, as a disc this many radii across. */
const CRATER_WATER_FILL = 0.4;
const CRATER_WATER_R = 0.66;
const WATER_SEGS = 20;
/** Road widths (metres) by class, as linework draws them. */
const ROAD_WIDTH_M: Readonly<Record<RoadClass, number>> = { A: 9, B: 7, minor: 5, track: 3, path: 1.5 };
const RAIL_WIDTH_M = 4;
/** Smoke drifts with a fixed west-south-west wind, to the east-north-east (map direction, unit length). */
const WIND_X = 0.91;
const WIND_Y = 0.41;

/** One thrown-out boulder, rubble block or debris piece: centre (local x, y, height), size and turn. */
interface Piece {
  x: number;
  y: number;
  h: number;
  sx: number;
  sy: number;
  sz: number;
  /** Turn about the vertical, radians, measured like a map angle from east toward north. */
  yaw: number;
  tilt: number;
  roll: number;
  color: number;
}

interface DamageChunk {
  cx: number;
  cy: number;
  pieces: Piece[];
  /** World-frame triangle positions of crater water discs. */
  water: number[];
  pieceMesh: THREE.InstancedMesh | null;
  waterMesh: THREE.Mesh | null;
}

interface Plume {
  x: number;
  y: number;
  /** Strike-zone smoke is seen from afar whatever the render level; fire smoke follows it. */
  strike: boolean;
  fromDay: number;
  toDay: number;
  planes: { mesh: THREE.Mesh; x: number; z: number; sway: number }[];
  glow: THREE.Sprite;
  group: THREE.Group;
}

/** Deterministic hashed stream in [0, 1) from a string id. Not an RNG: the same id always gives the same values. */
export function hashStream(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Point and unit direction halfway along a polyline. */
function midway(pts: readonly Pt[]): { x: number; y: number; dx: number; dy: number } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot((pts[i] as Pt)[0] - (pts[i - 1] as Pt)[0], (pts[i] as Pt)[1] - (pts[i - 1] as Pt)[1]);
  }
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l >= left && l > 0) {
      const t = left / l;
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / l, dy: (b[1] - a[1]) / l };
    }
    left -= l;
  }
  const a = pts[0] as Pt;
  return { x: a[0], y: a[1], dx: 1, dy: 0 };
}

/** Unit direction of the polyline segment nearest (x, y). */
function directionNear(pts: readonly Pt[], x: number, y: number): [number, number] {
  let best = Infinity;
  let dir: [number, number] = [1, 0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2));
    const d = Math.hypot(a[0] + vx * t - x, a[1] + vy * t - y);
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2);
      dir = [vx / l, vy / l];
    }
  }
  return dir;
}

/** Soft round puff, white with the shape in alpha; smoke puffs are broken up by two octaves of lattice noise. */
function puffTexture(size: number, noisy: boolean): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const rnd = hashStream('smoke-puff');
  const L = 8;
  const lattice = Array.from({ length: L * L }, () => rnd());
  // Wrapping value noise on an L x L lattice, u and v in [0, 1).
  const noise = (u: number, v: number): number => {
    const fx = u * L;
    const fy = v * L;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const at = (a: number, b: number): number => lattice[((b % L) + L) % L * L + (((a % L) + L) % L)] as number;
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
    const bot = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return top + (bot - top) * sy;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = ((i + 0.5) / size) * 2 - 1;
      const v = ((j + 0.5) / size) * 2 - 1;
      const r2 = u * u + v * v;
      let a = Math.max(0, Math.exp(-3.5 * r2) - Math.exp(-3.5)) / (1 - Math.exp(-3.5));
      if (noisy) {
        const n = 0.65 * noise(i / size, j / size) + 0.35 * noise((2 * i) / size + 0.31, (2 * j) / size + 0.57);
        a *= 0.35 + 0.65 * n;
      }
      const k = (j * size + i) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(255 * a);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The district damage that is not the ground mesh itself: thrown-out boulders round the large craters, still water
 * in flagged craters, rubble heaps where bridges fell, debris heaps across blocked road segments, and smoke columns
 * over strike zones and fires with a glow at their feet at night. Everything but strike-zone smoke shows only in
 * tiles at district render level or above. Pieces are instanced per 500 m chunk and hidden beyond PIECE_RANGE_M.
 */
export class DistrictDamage {
  readonly group = new THREE.Group();
  private readonly pieceGeo = new THREE.IcosahedronGeometry(1, 0);
  private readonly pieceMat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly waterMat = new THREE.MeshPhongMaterial({ color: WATER_FRESH, specular: 0x7a8a90, shininess: 90 });
  private readonly puffTex = puffTexture(64, true);
  private readonly glowTex = puffTexture(32, false);
  private readonly smokeMats: Record<'strike' | 'fire', { base: THREE.MeshLambertMaterial; top: THREE.MeshLambertMaterial }>;
  private readonly glowMat: THREE.SpriteMaterial;
  private readonly chunks = new Map<string, DamageChunk>();
  private readonly plumes: Plume[] = [];
  private readonly light = newDaylight();

  constructor(
    private readonly surface: Surface,
    features: Features,
    districts: Districts,
  ) {
    this.group.name = 'district-damage';
    const smokeMat = (color: number, opacity: number, glow: boolean): THREE.MeshLambertMaterial =>
      new THREE.MeshLambertMaterial({
        color,
        map: this.puffTex,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        emissive: glow ? FIRE_GLOW : 0x000000,
        emissiveIntensity: 0,
      });
    this.smokeMats = {
      strike: { base: smokeMat(SMOKE_STRIKE, 0.75, true), top: smokeMat(SMOKE_STRIKE, 0.6, false) },
      fire: { base: smokeMat(SMOKE_FIRE, 0.6, true), top: smokeMat(SMOKE_FIRE, 0.45, false) },
    };
    this.glowMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color: FIRE_GLOW,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    const roads = new Map(features.roads.map((r) => [r.id, r]));
    const rail = new Map(features.rail.map((r) => [r.id, r]));
    const bridgeFeatures = new Map(features.bridges.map((b) => [b.id, b]));
    const fires: Fire[] = [];
    const strikes: StrikeZone[] = [];
    for (const t of districts.tiles) {
      for (const c of t.craters) this.addCrater(c.id, c.x, c.y, c.r, c.water);
      strikes.push(...t.strikeZones);
      fires.push(...t.fires);
    }

    for (const b of districts.bridges) {
      if (b.standing) continue;
      const carrier = b.on === 'road' ? roads.get(b.refId) : rail.get(b.refId);
      if (!carrier) continue;
      const width = b.on === 'road' ? ROAD_WIDTH_M[(carrier as { cls: RoadClass }).cls] : RAIL_WIDTH_M;
      this.addBridgeRubble(b.id, carrier.pts, b.x, b.y, width, bridgeFeatures.get(b.id)?.len ?? 2 * width);
    }

    for (const s of districts.roadSegments) {
      if (!s.blocked || s.pts.length < 2) continue;
      const road = roads.get(s.roadId);
      this.addRoadDebris(s.id, s.pts, road ? ROAD_WIDTH_M[road.cls] : 5, s.cause);
    }

    // Burning strike zones carry the tall smoke; a fire on the same spot burns for the same days and adds none.
    const used = new Set<Fire>();
    for (const z of strikes) {
      if (z.kind !== 'burning') continue;
      const f = fires.find((q) => Math.hypot(q.x - z.x, q.y - z.y) < 1);
      if (f) used.add(f);
      this.addPlume(z.id, z.x, z.y, z.r, true, f?.fromDay ?? -Infinity, f?.toDay ?? Infinity);
    }
    for (const f of fires) if (!used.has(f)) this.addPlume(f.id, f.x, f.y, f.r, false, f.fromDay, f.toDay);

    this.finish();
  }

  /** Call each frame: camera, game day (GameClock.gameDays) and the sun's altitude in degrees. */
  update(camera: THREE.Camera, gameDays: number, sunAltitude: number, timeS: number): void {
    const x = camera.position.x;
    const y = -camera.position.z;
    for (const c of this.chunks.values()) {
      const x0 = c.cx * CHUNK_M;
      const y0 = c.cy * CHUNK_M;
      const shown = showsDamage(renderLevelAt(x0 + 1, y0 + 1));
      if (c.waterMesh) c.waterMesh.visible = shown;
      if (c.pieceMesh) {
        const dist = Math.hypot(Math.max(x0 - x, 0, x - (x0 + CHUNK_M)), Math.max(y0 - y, 0, y - (y0 + CHUNK_M)));
        c.pieceMesh.visible = shown && dist <= PIECE_RANGE_M;
      }
    }

    const night = daylightAt(sunAltitude, this.light).night;
    this.smokeMats.strike.base.emissiveIntensity = 0.9 * night;
    this.smokeMats.fire.base.emissiveIntensity = 0.7 * night;
    this.glowMat.opacity = 0.9 * night;
    for (const p of this.plumes) {
      p.group.visible =
        gameDays >= p.fromDay && gameDays < p.toDay && (p.strike || showsDamage(renderLevelAt(p.x, p.y)));
      if (!p.group.visible) continue;
      p.glow.visible = night > 0.02;
      for (const q of p.planes) {
        // Each puff turns about the vertical to face the camera, and sways a little.
        const sx = q.x + Math.sin(timeS * 0.12 + q.sway) * q.mesh.scale.x * 0.04;
        q.mesh.position.x = sx;
        q.mesh.rotation.y = Math.atan2(camera.position.x - sx, camera.position.z - q.z);
      }
    }
  }

  dispose(): void {
    for (const c of this.chunks.values()) {
      c.pieceMesh?.dispose();
      c.waterMesh?.geometry.dispose();
    }
    for (const p of this.plumes) for (const q of p.planes) q.mesh.geometry.dispose();
    this.pieceGeo.dispose();
    this.pieceMat.dispose();
    this.waterMat.dispose();
    for (const m of Object.values(this.smokeMats)) {
      m.base.dispose();
      m.top.dispose();
    }
    this.glowMat.dispose();
    this.puffTex.dispose();
    this.glowTex.dispose();
    this.group.removeFromParent();
  }

  // ---- building ----

  private chunkAt(x: number, y: number): DamageChunk {
    const t = this.surface.terrain;
    const cx = Math.min(Math.ceil(t.sizeX / CHUNK_M) - 1, Math.max(0, Math.floor(x / CHUNK_M)));
    const cy = Math.min(Math.ceil(t.sizeY / CHUNK_M) - 1, Math.max(0, Math.floor(y / CHUNK_M)));
    const key = `${cx}-${cy}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { cx, cy, pieces: [], water: [], pieceMesh: null, waterMesh: null };
      this.chunks.set(key, c);
    }
    return c;
  }

  /** A piece sunk a third of its height into the ground at (x, y). */
  private piece(x: number, y: number, sx: number, sy: number, sz: number, yaw: number, tilt: number, roll: number, color: number, lift = 0): void {
    const h = surfaceHeight(this.surface, x, y) - sy * 0.35 + lift;
    this.chunkAt(x, y).pieces.push({ x, y, h, sx, sy, sz, yaw, tilt, roll, color });
  }

  /** Thrown-out boulders scattered from the rim out to about 1.7 radii, more and bigger round bigger craters. */
  private addCrater(id: string, x: number, y: number, r: number, water: boolean): void {
    const rnd = hashStream(id);
    const n = Math.round(10 + r * 0.8);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2;
      const d = r * (0.95 + 0.75 * rnd() ** 1.5);
      const size = 0.3 + rnd() ** 2 * (0.4 + 0.04 * r);
      const color = BOULDER_GREYS[Math.floor(rnd() * BOULDER_GREYS.length)] as number;
      this.piece(
        x + Math.cos(a) * d,
        y + Math.sin(a) * d,
        size * (0.8 + 0.5 * rnd()),
        size * (0.5 + 0.4 * rnd()),
        size * (0.8 + 0.5 * rnd()),
        rnd() * Math.PI * 2,
        (rnd() - 0.5) * 0.6,
        (rnd() - 0.5) * 0.6,
        color,
      );
    }
    if (!water) return;
    // A flat disc part way up the bowl; the bowl walls hide its edge.
    const level = surfaceHeight(this.surface, x, y) + CRATER_WATER_FILL * CRATER_DEPTH_PER_D * 2 * r;
    const R = r * CRATER_WATER_R;
    const w = this.chunkAt(x, y).water;
    for (let k = 0; k < WATER_SEGS; k++) {
      const a0 = (k / WATER_SEGS) * Math.PI * 2;
      const a1 = ((k + 1) / WATER_SEGS) * Math.PI * 2;
      // Counter-clockwise from above in the world frame (z = -north).
      w.push(x, level, -y, x + Math.cos(a0) * R, level, -(y + Math.sin(a0) * R), x + Math.cos(a1) * R, level, -(y + Math.sin(a1) * R));
    }
  }

  /**
   * Where a bridge fell: a heap of stone blocks and tilted deck slabs at the lowest ground under the span (for an
   * unrecorded crossing, at the crossing), spread along the line of the bridge.
   */
  private addBridgeRubble(id: string, pts: readonly Pt[], bx: number, by: number, width: number, len: number): void {
    const rnd = hashStream(id);
    let cx = bx;
    let cy = by;
    if (id.startsWith('br-')) {
      // The whole carrier way is the bridge: find its lowest point.
      let low = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as Pt;
        const b = pts[i] as Pt;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
        for (let k = 0; k <= n; k++) {
          const px = a[0] + ((b[0] - a[0]) * k) / n;
          const py = a[1] + ((b[1] - a[1]) * k) / n;
          const h = surfaceHeight(this.surface, px, py);
          if (h < low) {
            low = h;
            cx = px;
            cy = py;
          }
        }
      }
    }
    const [dx, dy] = directionNear(pts, cx, cy);
    const yaw = Math.atan2(dy, dx);
    const along = Math.min(len * 0.35, 12) + 2;
    const across = width / 2 + 1.5;
    const n = Math.min(40, Math.round(16 + len * 0.3));
    const stone = new THREE.Color(BRIDGE_STONE);
    const tone = new THREE.Color();
    for (let k = 0; k < n; k++) {
      const u = (rnd() * 2 - 1) * along;
      const v = (rnd() * 2 - 1) * across;
      const rho = Math.min(1, Math.hypot(u / along, v / across));
      const x = cx + dx * u - dy * v;
      const y = cy + dy * u + dx * v;
      const slab = rnd() < 0.25;
      const size = 0.5 + rnd() * 0.9;
      const color = tone.copy(stone).multiplyScalar(0.7 + 0.4 * rnd()).getHex();
      // Heaped highest in the middle.
      const lift = (1 - rho * rho) * 1.2 * rnd();
      if (slab) {
        this.piece(x, y, 1.5 + rnd() * 2, 0.35, 1 + rnd() * 1.5, yaw + (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 1.2, (rnd() - 0.5) * 1.2, color, lift);
      } else {
        this.piece(x, y, size, size * (0.6 + 0.4 * rnd()), size, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8, color, lift);
      }
    }
  }

  /** A heap of debris across the road halfway along a blocked segment, made of what blocked it. */
  private addRoadDebris(id: string, pts: readonly Pt[], width: number, cause: BlockCause | null): void {
    const rnd = hashStream(id);
    const m = midway(pts);
    const yaw = Math.atan2(m.dy, m.dx);
    const across = width / 2 + 1;
    const along = 2 + rnd() * 2;
    const n = Math.round(7 + width);
    const palette: readonly number[] =
      cause === 'fallenWood'
        ? DEBRIS_TIMBER
        : cause === 'silt' || cause === 'water'
          ? DEBRIS_MUD
          : cause === 'wrack'
            ? DEBRIS_WRACK
            : cause === 'landslip'
              ? [...DEBRIS_MUD, ...BOULDER_GREYS]
              : BOULDER_GREYS;
    for (let k = 0; k < n; k++) {
      const u = (rnd() * 2 - 1) * along;
      const v = (rnd() * 2 - 1) * across;
      const x = m.x + m.dx * u - m.dy * v;
      const y = m.y + m.dy * u + m.dx * v;
      const color = palette[Math.floor(rnd() * palette.length)] as number;
      if (cause === 'fallenWood') {
        // Trunks and limbs lying roughly across the road.
        const len = 2.5 + rnd() * 4;
        const girth = 0.2 + rnd() * 0.25;
        this.piece(x, y, len, girth, girth, yaw + Math.PI / 2 + (rnd() - 0.5) * 1.2, (rnd() - 0.5) * 0.3, 0, color, girth * 0.3);
      } else if (cause === 'silt' || cause === 'water') {
        // Low banks of silt and mud.
        this.piece(x, y, 1.2 + rnd() * 1.5, 0.3 + rnd() * 0.35, 1 + rnd() * 1.2, rnd() * Math.PI * 2, 0, 0, color);
      } else {
        const size = 0.4 + rnd() * 0.8;
        this.piece(x, y, size * (0.8 + rnd()), size * 0.7, size, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8, color);
      }
    }
  }

  /**
   * A smoke column of camera-facing puffs, drifting downwind and widening as it rises. Strike zones: a few hundred
   * metres tall; fires: smaller. A glow sprite sits at the foot.
   */
  private addPlume(id: string, x: number, y: number, r: number, strike: boolean, fromDay: number, toDay: number): void {
    const rnd = hashStream(id);
    const base = surfaceHeight(this.surface, x, y);
    // Puffs about as tall as wide, overlapping heavily so the column reads as one body.
    const height = strike ? 320 + 2 * r : 40 + 2.5 * r;
    const w0 = strike ? r : 0.6 * r + 6;
    const K = strike ? 16 : 6;
    const mats = this.smokeMats[strike ? 'strike' : 'fire'];
    const group = new THREE.Group();
    group.name = `smoke-${id}`;
    const planes: Plume['planes'] = [];
    for (let i = 0; i < K; i++) {
      const f = i / (K - 1);
      const pw = 1.4 * w0 * (1 + 1.8 * f) * (0.9 + 0.2 * rnd());
      const drift = f ** 1.5 * height * 0.35;
      const px = x + WIND_X * drift;
      const py = y + WIND_Y * drift;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), i < (strike ? 3 : 1) ? mats.base : mats.top);
      mesh.scale.set(pw, pw * (1 + 0.2 * rnd()), 1);
      mesh.position.set(px, base + ((i + 0.5) * height) / K, -py);
      mesh.renderOrder = 2;
      group.add(mesh);
      planes.push({ mesh, x: px, z: -py, sway: rnd() * Math.PI * 2 });
    }
    const glow = new THREE.Sprite(this.glowMat);
    glow.scale.setScalar((strike ? 3 : 2) * r);
    glow.position.set(x, base + r * 0.2, -y);
    glow.renderOrder = 3;
    group.add(glow);
    this.group.add(group);
    this.plumes.push({ x, y, strike, fromDay, toDay, planes, glow, group });
  }

  private finish(): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    for (const ch of this.chunks.values()) {
      if (ch.pieces.length > 0) {
        const mesh = new THREE.InstancedMesh(this.pieceGeo, this.pieceMat, ch.pieces.length);
        mesh.name = `damage-pieces-${ch.cx}-${ch.cy}`;
        ch.pieces.forEach((pc, k) => {
          // A map angle from east toward north is a turn about +y in the world frame (z = -north).
          e.set(pc.tilt, pc.yaw, pc.roll);
          m.compose(p.set(pc.x, pc.h, -pc.y), q.setFromEuler(e), s.set(pc.sx, pc.sy, pc.sz));
          mesh.setMatrixAt(k, m);
          mesh.setColorAt(k, c.setHex(pc.color));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        ch.pieceMesh = mesh;
        this.group.add(mesh);
      }
      if (ch.water.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(ch.water, 3));
        const nor = new Float32Array(ch.water.length);
        for (let k = 1; k < nor.length; k += 3) nor[k] = 1;
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.waterMat);
        mesh.name = `damage-water-${ch.cx}-${ch.cy}`;
        ch.waterMesh = mesh;
        this.group.add(mesh);
      }
      ch.pieces = [];
      ch.water = [];
    }
  }
}
