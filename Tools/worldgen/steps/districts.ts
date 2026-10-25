// District level: bridges, road segments and the 1 km tile records (see src/world/districts.ts).
// For now every bridge stands and nothing is blocked; later steps fill in the damage. No RNG yet.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  DISTRICTS_VERSION,
  MAX_SEGMENT_M,
  validateDistricts,
  type DistrictBridge,
  type DistrictTile,
  type Districts,
  type RoadSegment,
} from '../../../src/world/districts';
import type { Features, Pt, RiverFeature, RoadFeature, WoodFeature } from '../../../src/world/features';
import { Band, bandAt, hwAt, parseFlood, type BandCode, type FloodMeta } from '../../../src/world/flood';
import { osgbToLocal } from '../../../src/world/geo';
import { isUnderWater, parseLakes, type LakesMeta } from '../../../src/world/lakes';
import { TILES_PER_SIDE, TILE_M, heightAt, parseTerrain, tileId, tileOf, type TerrainMeta } from '../../../src/world/terrain';
import { STORM, SURVIVORS } from '../decisions';
import type { Step } from '../steps';

const dir = 'public/world/';

/** A deck sits at least this far above the ground beneath it, metres. */
export const DECK_CLEARANCE_M = 2;
/** A crossing within this distance of a bridge record of the same kind (road or rail) is that bridge, metres. */
const SAME_BRIDGE_M = 40;
/** For a crossing with no record, the deck ends are taken this far either side along the carrier, metres. */
const CROSSING_HALF_SPAN_M = 10;
/** Band and wood sampling step along a segment, metres. */
const SAMPLE_M = 10;
/** A road end this close to another road joins it, metres. */
const JUNCTION_SNAP_M = 1;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

function polyLength(pts: readonly Pt[]): number {
  let L = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1] as Pt;
    const b = pts[k] as Pt;
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** The point at distance s along pts (clamped). */
function pointAlong(pts: readonly Pt[], s: number): Pt {
  let left = Math.max(0, s);
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1] as Pt;
    const b = pts[k] as Pt;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= d && d > 0) return [a[0] + ((b[0] - a[0]) * left) / d, a[1] + ((b[1] - a[1]) * left) / d];
    left -= d;
  }
  return pts[pts.length - 1] as Pt;
}

/** Intersection parameters (t along ab, u along cd) of two segments, or null. */
function segHit(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number } | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

interface Wood {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ring: readonly Pt[];
}

function woodBox(w: WoodFeature): Wood {
  const xs = w.ring.map((p) => p[0]);
  const ys = w.ring.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), ring: w.ring };
}

function inRing(ring: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
    const [xi, yi] = ring[k] as Pt;
    const [xj, yj] = ring[m] as Pt;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const onTileEdge = (p: Pt): boolean =>
  p.some((v) => v > 0 && v < TILES_PER_SIDE * TILE_M && v % TILE_M === 0);

/** Splits one road at tile edges and junction vertices, then into equal pieces of at most MAX_SEGMENT_M. */
export function splitRoad(pts: readonly Pt[], isJunction: (p: Pt) => boolean): Pt[][] {
  // Expand with the tile-edge crossings; mark where a piece must end.
  const out: Pt[] = [];
  const cut: boolean[] = [];
  const push = (p: Pt, isCut: boolean): void => {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) {
      cut[cut.length - 1] ||= isCut;
      return;
    }
    out.push(p);
    cut.push(isCut);
  };
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k] as Pt;
    push(a, k > 0 && k < pts.length - 1 && (isJunction(a) || onTileEdge(a)));
    if (k + 1 === pts.length) break;
    const b = pts[k + 1] as Pt;
    const ts: number[] = [];
    for (let e = 1; e < TILES_PER_SIDE; e++) {
      const edge = e * TILE_M;
      if ((a[0] - edge) * (b[0] - edge) < 0) ts.push((edge - a[0]) / (b[0] - a[0]));
      if ((a[1] - edge) * (b[1] - edge) < 0) ts.push((edge - a[1]) / (b[1] - a[1]));
    }
    ts.sort((p, q) => p - q);
    for (const t of ts) push([r1(a[0] + t * (b[0] - a[0])), r1(a[1] + t * (b[1] - a[1]))], true);
  }
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  out.forEach((p, k) => {
    cur.push(p);
    if (k > 0 && (cut[k] || k === out.length - 1)) {
      if (cur.length >= 2) pieces.push(cur);
      cur = [p];
    }
  });
  // Equal subdivision of long pieces.
  const result: Pt[][] = [];
  for (const piece of pieces) {
    const L = polyLength(piece);
    const n = Math.ceil(L / MAX_SEGMENT_M - 1e-9);
    if (n <= 1) {
      result.push(piece);
      continue;
    }
    let sub: Pt[] = [piece[0] as Pt];
    let s0 = 0;
    let m = 1;
    for (let k = 1; k < piece.length; k++) {
      const a = piece[k - 1] as Pt;
      const b = piece[k] as Pt;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (m < n && s0 + d >= (L * m) / n) {
        const f = ((L * m) / n - s0) / d;
        const p: Pt = [r1(a[0] + f * (b[0] - a[0])), r1(a[1] + f * (b[1] - a[1]))];
        const last = sub[sub.length - 1] as Pt;
        if (last[0] !== p[0] || last[1] !== p[1]) sub.push(p);
        if (sub.length >= 2) result.push(sub);
        sub = [p];
        m++;
      }
      const last = sub[sub.length - 1] as Pt;
      if (last[0] !== b[0] || last[1] !== b[1]) sub.push(b);
      s0 += d;
    }
    if (sub.length >= 2) result.push(sub);
  }
  return result;
}

export const districtsStep: Step = {
  name: 'districts',
  run() {
    const tmeta = JSON.parse(readFileSync(dir + 'terrain.json', 'utf8')) as TerrainMeta;
    const terrain = parseTerrain(tmeta, readFileSync(dir + 'terrain.bin'), readFileSync(dir + 'landcover.bin'));
    const fmeta = JSON.parse(readFileSync(dir + 'flood.json', 'utf8')) as FloodMeta;
    const flood = parseFlood(fmeta, readFileSync(dir + 'bands.bin'), terrain);
    const lmeta = JSON.parse(readFileSync(dir + 'lakes.json', 'utf8')) as LakesMeta;
    const lakes = parseLakes(lmeta, readFileSync(dir + 'lakeid.bin'), terrain);
    const features = JSON.parse(readFileSync(dir + 'features.json', 'utf8')) as Features;
    const cellsPerSide = tmeta.postsX - 1;

    const survivorIds = new Set(SURVIVORS.flatMap((s) => s.bridgeIds));
    const roadById = new Map(features.roads.map((r) => [r.id, r]));
    const railById = new Map(features.rail.map((r) => [r.id, r]));
    const riverById = new Map(features.rivers.map((r) => [r.id, r]));

    const makeBridge = (
      b: Omit<DistrictBridge, 'deckH' | 'hwAt' | 'depthBelowMark' | 'standing' | 'reason'>,
      ends: readonly Pt[],
    ): DistrictBridge => {
      const endH = ends.reduce((s, p) => s + heightAt(terrain, p[0], p[1]), 0) / ends.length;
      const deckH = r2(Math.max(endH, heightAt(terrain, b.x, b.y) + DECK_CLEARANCE_M));
      const hw = r2(hwAt(flood.hw, b.x, b.y));
      const survivor = survivorIds.has(b.id);
      return { ...b, deckH, hwAt: hw, depthBelowMark: r2(hw - deckH), standing: true, reason: survivor ? 'survivor' : 'undecided' };
    };

    // Bridge records from features.json: the carrier way is the bridge, so its ends are the deck ends.
    const bridges: DistrictBridge[] = features.bridges.map((fb) => {
      const carrier = (fb.on === 'rail' ? railById : roadById).get(fb.refId);
      if (!carrier) throw new Error(`districts: bridge ${fb.id} refers to missing ${fb.on} ${fb.refId}`);
      const ends = [carrier.pts[0] as Pt, carrier.pts[carrier.pts.length - 1] as Pt];
      return makeBridge(
        { id: fb.id, source: 'osm', x: fb.x, y: fb.y, major: fb.major, on: fb.on, refId: fb.refId, crosses: fb.crosses ?? null },
        ends,
      );
    });
    for (const id of survivorIds) {
      if (!bridges.some((b) => b.id === id)) throw new Error(`districts: survivor ${id} is not a features.json bridge`);
    }

    // Crossings with no bridge record: roads (not paths, which mostly ford or step across) and rail over rivers and streams.
    const BUCKET = 250;
    const nb = Math.ceil((TILES_PER_SIDE * TILE_M) / BUCKET) + 1;
    const buckets = new Map<number, { river: RiverFeature; k: number }[]>();
    for (const river of features.rivers) {
      for (let k = 0; k + 1 < river.pts.length; k++) {
        const a = river.pts[k] as Pt;
        const b = river.pts[k + 1] as Pt;
        const bx0 = Math.floor(Math.min(a[0], b[0]) / BUCKET);
        const bx1 = Math.floor(Math.max(a[0], b[0]) / BUCKET);
        const by0 = Math.floor(Math.min(a[1], b[1]) / BUCKET);
        const by1 = Math.floor(Math.max(a[1], b[1]) / BUCKET);
        for (let by = by0; by <= by1; by++) {
          for (let bx = bx0; bx <= bx1; bx++) {
            const key = by * nb + bx;
            const list = buckets.get(key) ?? [];
            list.push({ river, k });
            buckets.set(key, list);
          }
        }
      }
    }
    const recordCarriers = new Set(features.bridges.map((b) => b.refId));
    const carriers: { on: 'road' | 'rail'; id: string; pts: readonly Pt[]; major: boolean }[] = [
      ...features.roads
        .filter((r) => r.cls !== 'path')
        .map((r) => ({ on: 'road' as const, id: r.id, pts: r.pts, major: r.cls === 'A' || r.cls === 'B' })),
      ...features.rail.map((r) => ({ on: 'rail' as const, id: r.id, pts: r.pts, major: true })),
    ];
    const derived: DistrictBridge[] = [];
    for (const c of carriers) {
      if (recordCarriers.has(c.id)) continue;
      const hits: { river: RiverFeature; s: number; x: number; y: number }[] = [];
      let s0 = 0;
      for (let k = 0; k + 1 < c.pts.length; k++) {
        const a = c.pts[k] as Pt;
        const b = c.pts[k + 1] as Pt;
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const seen = new Set<string>();
        const bx0 = Math.floor(Math.min(a[0], b[0]) / BUCKET);
        const bx1 = Math.floor(Math.max(a[0], b[0]) / BUCKET);
        const by0 = Math.floor(Math.min(a[1], b[1]) / BUCKET);
        const by1 = Math.floor(Math.max(a[1], b[1]) / BUCKET);
        const local: { river: RiverFeature; s: number; x: number; y: number }[] = [];
        for (let by = by0; by <= by1; by++) {
          for (let bx = bx0; bx <= bx1; bx++) {
            for (const { river, k: rk } of buckets.get(by * nb + bx) ?? []) {
              const tag = `${river.id}:${rk}`;
              if (seen.has(tag)) continue;
              seen.add(tag);
              const hit = segHit(a, b, river.pts[rk] as Pt, river.pts[rk + 1] as Pt);
              if (hit) local.push({ river, s: s0 + hit.t * d, x: a[0] + hit.t * (b[0] - a[0]), y: a[1] + hit.t * (b[1] - a[1]) });
            }
          }
        }
        local.sort((p, q) => p.s - q.s || (p.river.id < q.river.id ? -1 : 1));
        hits.push(...local);
        s0 += d;
      }
      const L = s0;
      const n = new Map<string, number>();
      for (const h of hits) {
        const near = (b: DistrictBridge): boolean =>
          Math.hypot(b.x - h.x, b.y - h.y) < SAME_BRIDGE_M && (b.crosses === null || b.crosses === h.river.id);
        if (bridges.some((b) => b.on === c.on && near(b))) continue;
        if (derived.some((b) => b.refId === c.id && near(b))) continue;
        const count = n.get(h.river.id) ?? 0;
        n.set(h.river.id, count + 1);
        const ends = [pointAlong(c.pts, Math.max(0, h.s - CROSSING_HALF_SPAN_M)), pointAlong(c.pts, Math.min(L, h.s + CROSSING_HALF_SPAN_M))];
        derived.push(
          makeBridge(
            {
              id: `xb-${c.id}-${h.river.id}-${count}`,
              source: 'crossing',
              x: r1(h.x),
              y: r1(h.y),
              major: c.major && h.river.kind === 'river',
              on: c.on,
              refId: c.id,
              crosses: h.river.id,
            },
            ends,
          ),
        );
      }
    }
    bridges.push(...derived);

    // Junctions: a vertex shared by two or more roads (OSM ways share nodes; coordinates are rounded identically).
    // Simplification can drop the shared node from the through road, so a road end within JUNCTION_SNAP_M of another
    // road is also a junction: on that road's nearest vertex, or inserted into it.
    const key = (p: Pt): string => `${p[0]},${p[1]}`;
    const junctions = new Set<string>();
    const roadPts = new Map<string, Pt[]>(features.roads.map((r) => [r.id, [...r.pts]]));
    const segBuckets = new Map<number, { road: RoadFeature; k: number }[]>();
    for (const road of features.roads) {
      for (let k = 0; k + 1 < road.pts.length; k++) {
        const a = road.pts[k] as Pt;
        const b = road.pts[k + 1] as Pt;
        for (let by = Math.floor(Math.min(a[1], b[1]) / BUCKET); by <= Math.floor(Math.max(a[1], b[1]) / BUCKET); by++) {
          for (let bx = Math.floor(Math.min(a[0], b[0]) / BUCKET); bx <= Math.floor(Math.max(a[0], b[0]) / BUCKET); bx++) {
            const list = segBuckets.get(by * nb + bx) ?? [];
            list.push({ road, k });
            segBuckets.set(by * nb + bx, list);
          }
        }
      }
    }
    const inserts = new Map<string, { k: number; t: number; p: Pt }[]>();
    for (const road of features.roads) {
      for (const e of [road.pts[0] as Pt, road.pts[road.pts.length - 1] as Pt]) {
        const seen = new Set<string>();
        for (let by = Math.floor((e[1] - JUNCTION_SNAP_M) / BUCKET); by <= Math.floor((e[1] + JUNCTION_SNAP_M) / BUCKET); by++) {
          for (let bx = Math.floor((e[0] - JUNCTION_SNAP_M) / BUCKET); bx <= Math.floor((e[0] + JUNCTION_SNAP_M) / BUCKET); bx++) {
            for (const { road: o, k } of segBuckets.get(by * nb + bx) ?? []) {
              if (o === road || seen.has(`${o.id}:${k}`)) continue;
              seen.add(`${o.id}:${k}`);
              const a = o.pts[k] as Pt;
              const b = o.pts[k + 1] as Pt;
              const dx = b[0] - a[0];
              const dy = b[1] - a[1];
              const len2 = dx * dx + dy * dy;
              const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((e[0] - a[0]) * dx + (e[1] - a[1]) * dy) / len2));
              if (Math.hypot(a[0] + t * dx - e[0], a[1] + t * dy - e[1]) > JUNCTION_SNAP_M) continue;
              junctions.add(key(e));
              const da = Math.hypot(e[0] - a[0], e[1] - a[1]);
              const db = Math.hypot(e[0] - b[0], e[1] - b[1]);
              if (Math.min(da, db) <= JUNCTION_SNAP_M) junctions.add(key(da <= db ? a : b));
              else {
                const list = inserts.get(o.id) ?? [];
                list.push({ k, t, p: e });
                inserts.set(o.id, list);
              }
            }
          }
        }
      }
    }
    for (const [id, list] of inserts) {
      const pts = roadById.get(id)?.pts ?? [];
      list.sort((p, q) => p.k - q.k || p.t - q.t);
      const out: Pt[] = [];
      let n = 0;
      for (let k = 0; k < pts.length; k++) {
        out.push(pts[k] as Pt);
        while (n < list.length && (list[n] as { k: number }).k === k) {
          const p = (list[n] as { p: Pt }).p;
          const last = out[out.length - 1] as Pt;
          if (last[0] !== p[0] || last[1] !== p[1]) out.push(p);
          n++;
        }
      }
      roadPts.set(id, out);
    }
    const vertexUse = new Map<string, number>();
    for (const pts of roadPts.values()) {
      for (const p of new Set(pts.map(key))) vertexUse.set(p, (vertexUse.get(p) ?? 0) + 1);
    }
    const isJunction = (p: Pt): boolean => junctions.has(key(p)) || (vertexUse.get(key(p)) ?? 0) >= 2;

    const woods = features.woods.map(woodBox);
    const inWoodAt = (x: number, y: number): boolean =>
      woods.some((w) => x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1 && inRing(w.ring, x, y));
    const bandAtPt = (x: number, y: number): BandCode =>
      isUnderWater(lakes, terrain, x, y, 0) ? Band.UnderWater : bandAt(flood, tmeta.cellM, cellsPerSide, x, y);

    const roadSegments: RoadSegment[] = [];
    const segmentRoad = (road: RoadFeature): void => {
      splitRoad(roadPts.get(road.id) ?? road.pts, isJunction).forEach((pts, n) => {
        const L = polyLength(pts);
        const mid = pointAlong(pts, L / 2);
        const t = tileOf(mid[0], mid[1]);
        const samples = Math.max(1, Math.ceil(L / SAMPLE_M));
        let wooded = 0;
        let band: BandCode = Band.Above;
        for (let k = 0; k < samples; k++) {
          const [x, y] = pointAlong(pts, ((k + 0.5) * L) / samples);
          if (inWoodAt(x, y)) wooded++;
          band = Math.max(band, bandAtPt(x, y)) as BandCode;
        }
        roadSegments.push({
          id: `${road.id}-${n}`,
          roadId: road.id,
          tile: tileId(t.i, t.j),
          pts: pts.map((p) => [p[0], p[1]]),
          length: r1(L),
          inWood: wooded * 2 >= samples,
          band,
          blocked: false,
          cause: null,
        });
      });
    };
    features.roads.forEach(segmentRoad);

    const tiles: DistrictTile[] = fmeta.tiles.map((ft) => ({
      id: ft.id,
      i: ft.i,
      j: ft.j,
      hw: ft.hw,
      craters: [],
      strikeZones: [],
      fires: [],
      gasHollows: [],
      animals: {},
      pocked: 0,
      wrackDams: [],
      landslips: [],
      silt: [],
      fallenWoods: [],
    }));
    tiles.sort((a, b) => a.j - b.j || a.i - b.i);

    const centre = osgbToLocal(STORM.e, STORM.n);
    const districts: Districts = {
      version: DISTRICTS_VERSION,
      method:
        'Bridges: every features.json bridge (deck ends = the carrier way ends), plus every crossing of a road (not a path) or ' +
        `rail line over a river or stream with no record of the same kind within ${SAME_BRIDGE_M} m (deck ends ${CROSSING_HALF_SPAN_M} m ` +
        `either side). deckH = max(mean end height, ground + ${DECK_CLEARANCE_M} m); hwAt from flood.json, interpolated. ` +
        `Road segments: each road split at tile edges and at vertices shared with another road, then into equal pieces of at most ` +
        `${MAX_SEGMENT_M} m. inWood = at least half the ${SAMPLE_M} m samples inside a woods polygon; band = deepest band sampled ` +
        '(3 under a trapped lake at spill). Storm and survivors are hand-picked in Tools/worldgen/decisions.ts. ' +
        'No damage yet: every bridge stands, nothing is blocked, tile lists are empty.',
      storm: { worstSide: STORM.worstSide, centre: { e: STORM.e, n: STORM.n, x: r1(centre.x), y: r1(centre.y) }, why: STORM.why },
      survivors: SURVIVORS.map((s) => ({ name: s.name, bridgeIds: [...s.bridgeIds], why: s.why })),
      bridges,
      roadSegments,
      tiles,
    };
    const errs = validateDistricts(districts, features);
    if (errs.length > 0) throw new Error(`districts: invalid output:\n  ${errs.slice(0, 20).join('\n  ')}`);
    writeFileSync(dir + 'districts.json', serialise(districts));
    console.log(
      `[worldgen] districts: ${bridges.length} bridges (${derived.length} unrecorded crossings), ${roadSegments.length} road segments`,
    );
  },
};

/** JSON with one array element per line, so diffs stay readable. */
function serialise(d: Districts): string {
  const lines = Object.entries(d).map(([k, v]) => {
    if (Array.isArray(v) && v.length > 0) return `  ${JSON.stringify(k)}: [\n${v.map((e) => '    ' + JSON.stringify(e)).join(',\n')}\n  ]`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}
