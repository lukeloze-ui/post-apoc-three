// Imports OpenStreetMap (via Overpass) and writes features.json and landcover.bin for the patch.
// The raw response is untrusted: it is cached as JSON in its own folder, parsed defensively, and only
// read as data. Output is deterministic for a given cached response.
// All coordinates are local metres from the patch SW corner; rings are closed (first point repeated).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATCH_M, wgs84ToLocal, wgs84ToOsgb, ORIGIN_E, ORIGIN_N } from '../../../src/world/geo';
import { LandCover, START, heightAt, type Terrain, type TerrainMeta } from '../../../src/world/terrain';
import type { Step } from '../steps';
import { WORLD_DIR } from '../synthetic';

const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RAW_DIR = join(import.meta.dirname, '..', 'raw', 'osm');
const RAW_PATH = join(RAW_DIR, 'overpass.json');
const CELL = 50;
const CELLS = PATCH_M / CELL;
const MARGIN_DEG = 0.003;
const LINE_TOL_M = 2;
const BUILDING_TOL_M = 0.4;
const MAX_FEATURES_BYTES = 1_500_000;
/** Military zones larger than this (the Dartmoor firing ranges) are too big to be a camp. */
const MAX_CAMP_AREA_M2 = 2_000_000;
const MOOR_LINE_M = 300;

type Pt = [number, number];
type LL = { lat: number; lon: number };

// ---------- query ----------

/** Newton inversion of wgs84ToOsgb; good to well under a metre. */
function osgbToWgs84(e: number, n: number): LL {
  let lat = 50.72;
  let lon = -4;
  const d = 1e-5;
  for (let k = 0; k < 8; k++) {
    const p = wgs84ToOsgb(lat, lon);
    const pl = wgs84ToOsgb(lat + d, lon);
    const po = wgs84ToOsgb(lat, lon + d);
    const a = (po.e - p.e) / d;
    const b = (pl.e - p.e) / d;
    const c = (po.n - p.n) / d;
    const f = (pl.n - p.n) / d;
    const det = a * f - b * c;
    const re = e - p.e;
    const rn = n - p.n;
    lon += (f * re - b * rn) / det;
    lat += (a * rn - c * re) / det;
  }
  return { lat, lon };
}

/** South, west, north, east in degrees: the patch corners plus a small margin. */
export function patchBboxWgs84(): [number, number, number, number] {
  const corners = [
    osgbToWgs84(ORIGIN_E, ORIGIN_N),
    osgbToWgs84(ORIGIN_E + PATCH_M, ORIGIN_N),
    osgbToWgs84(ORIGIN_E, ORIGIN_N + PATCH_M),
    osgbToWgs84(ORIGIN_E + PATCH_M, ORIGIN_N + PATCH_M),
  ];
  const lats = corners.map((c) => c.lat);
  const lons = corners.map((c) => c.lon);
  const r = (v: number): number => Math.round(v * 1e5) / 1e5;
  return [r(Math.min(...lats) - MARGIN_DEG), r(Math.min(...lons) - MARGIN_DEG), r(Math.max(...lats) + MARGIN_DEG), r(Math.max(...lons) + MARGIN_DEG)];
}

export function buildQuery(bbox: readonly number[]): string {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:240][bbox:${s},${w},${n},${e}];
(
  way["highway"];
  way["railway"];
  way["disused:railway"];
  way["abandoned:railway"];
  way["waterway"~"^(river|stream|riverbank|dam)$"];
  nwr["natural"~"^(wood|scrub|heath|wetland|water|bare_rock|scree|grassland|fell|moor|peak|rock)$"];
  nwr["landuse"];
  nwr["building"];
  nwr["amenity"~"^(pub|bar|restaurant|cafe|school|college|kindergarten|place_of_worship|hotel)$"];
  nwr["shop"];
  nwr["military"];
  way["barrier"~"^(hedge|hedge_bank|wall|fence)$"];
  way["bridge"];
  node["place"];
  node["railway"~"^(station|halt)$"];
);
out geom qt;`;
}

// ---------- raw OSM, parsed defensively ----------

interface OsmEl {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags: Record<string, string>;
  pt?: Pt;
  pts?: Pt[];
  /** Relation members with geometry, in local metres. */
  members?: { role: string; pts: Pt[] }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLL = (v: unknown): v is LL => isObj(v) && typeof v.lat === 'number' && typeof v.lon === 'number' && Number.isFinite(v.lat) && Number.isFinite(v.lon);
const proj = (g: LL): Pt => {
  const p = wgs84ToLocal(g.lat, g.lon);
  return [p.x, p.y];
};

function readTags(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k.slice(0, 60)] = val.slice(0, 120);
  }
  return out;
}

const TYPE_ORDER = { node: 0, way: 1, relation: 2 } as const;

/** Validates the Overpass JSON and projects everything to local metres. Bad elements are dropped, not trusted. */
export function parseOverpass(json: unknown): { elements: OsmEl[]; timestamp: string } {
  if (!isObj(json) || !Array.isArray(json.elements)) throw new Error('osm: response has no elements array');
  const elements: OsmEl[] = [];
  for (const raw of json.elements as unknown[]) {
    if (!isObj(raw) || typeof raw.id !== 'number') continue;
    const type = raw.type;
    if (type !== 'node' && type !== 'way' && type !== 'relation') continue;
    const el: OsmEl = { type, id: raw.id, tags: readTags(raw.tags) };
    if (type === 'node') {
      if (!isLL(raw)) continue;
      el.pt = proj(raw);
    } else if (type === 'way') {
      if (!Array.isArray(raw.geometry)) continue;
      const g = (raw.geometry as unknown[]).filter(isLL);
      if (g.length < 2) continue;
      el.pts = g.map(proj);
    } else {
      if (!Array.isArray(raw.members)) continue;
      el.members = [];
      for (const m of raw.members as unknown[]) {
        if (!isObj(m) || m.type !== 'way' || !Array.isArray(m.geometry)) continue;
        const g = (m.geometry as unknown[]).filter(isLL);
        if (g.length >= 2) el.members.push({ role: typeof m.role === 'string' ? m.role : '', pts: g.map(proj) });
      }
    }
    elements.push(el);
  }
  elements.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id - b.id);
  const osm3s = isObj(json.osm3s) ? json.osm3s : {};
  const timestamp = typeof osm3s.timestamp_osm_base === 'string' ? osm3s.timestamp_osm_base.slice(0, 40) : 'unknown';
  return { elements, timestamp };
}

// ---------- geometry ----------

const eq = (a: Pt, b: Pt): boolean => a[0] === b[0] && a[1] === b[1];
const last = <T>(a: readonly T[]): T => a[a.length - 1] as T;

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on an open polyline; endpoints are kept. */
export function simplifyLine(pts: readonly Pt[], tol: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i] as Pt, pts[a] as Pt, pts[b] as Pt);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** Simplifies a closed ring (first point repeated). Returns null if it collapses. */
export function simplifyRing(ring: readonly Pt[], tol: number): Pt[] | null {
  const pts = ring.slice(0, -1);
  if (pts.length < 3) return null;
  const p0 = pts[0] as Pt;
  let far = 1;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot((pts[i] as Pt)[0] - p0[0], (pts[i] as Pt)[1] - p0[1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplifyLine(pts.slice(0, far + 1), tol);
  const b = simplifyLine([...pts.slice(far), p0], tol);
  const out = [...a, ...b.slice(1)];
  return out.length >= 4 ? out : null;
}

/** Clips a polyline to the patch square; returns the runs inside it. */
export function clipLine(pts: readonly Pt[], size = PATCH_M): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = (): void => {
    if (cur.length >= 2) runs.push(cur);
    cur = [];
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [
      [-dx, a[0]],
      [dx, size - a[0]],
      [-dy, a[1]],
      [dy, size - a[1]],
    ] as [number, number][]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!ok || t0 > t1) {
      flush();
      continue;
    }
    const s: Pt = [a[0] + t0 * dx, a[1] + t0 * dy];
    const e: Pt = [a[0] + t1 * dx, a[1] + t1 * dy];
    if (t0 > 0) flush();
    if (cur.length === 0) cur.push(s);
    cur.push(e);
    if (t1 < 1) flush();
  }
  flush();
  return runs;
}

/** Sutherland-Hodgman clip of a closed ring to the patch square. Returns null if nothing is left. */
export function clipRing(ring: readonly Pt[], size = PATCH_M): Pt[] | null {
  let poly: Pt[] = ring.slice(0, -1);
  const edges: { inside: (p: Pt) => boolean; cut: (a: Pt, b: Pt) => Pt }[] = [
    { inside: (p) => p[0] >= 0, cut: (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= size, cut: (a, b) => [size, a[1] + ((b[1] - a[1]) * (size - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= 0, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0] },
    { inside: (p) => p[1] <= size, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (size - a[1])) / (b[1] - a[1]), size] },
  ];
  for (const edge of edges) {
    const next: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length] as Pt;
      const b = poly[i] as Pt;
      if (edge.inside(b)) {
        if (!edge.inside(a)) next.push(edge.cut(a, b));
        next.push(b);
      } else if (edge.inside(a)) next.push(edge.cut(a, b));
    }
    poly = next;
    if (poly.length < 3) return null;
  }
  return [...poly, poly[0] as Pt];
}

const inPatch = (p: Pt): boolean => p[0] >= 0 && p[0] <= PATCH_M && p[1] >= 0 && p[1] <= PATCH_M;

export function ringArea(ring: readonly Pt[]): number {
  let s = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1] as Pt;
    const b = ring[i] as Pt;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

function centroid(ring: readonly Pt[]): Pt {
  const r = ring.slice(0, -1);
  return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
}

function pointInRing(x: number, y: number, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Pt;
    const b = ring[j] as Pt;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function lineLength(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot((pts[i] as Pt)[0] - (pts[i - 1] as Pt)[0], (pts[i] as Pt)[1] - (pts[i - 1] as Pt)[1]);
  return s;
}

function pointAlong(pts: readonly Pt[], dist: number): Pt {
  let left = dist;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= l && l > 0) return [a[0] + ((b[0] - a[0]) * left) / l, a[1] + ((b[1] - a[1]) * left) / l];
    left -= l;
  }
  return last(pts);
}

function segIntersects(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Joins way fragments end to end into closed rings; open leftovers are dropped. */
export function stitchRings(segs: readonly (readonly Pt[])[]): Pt[][] {
  const pool: Pt[][] = segs.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: Pt[][] = [];
  while (pool.length) {
    let cur = pool.pop() as Pt[];
    let progress = true;
    while (!eq(cur[0] as Pt, last(cur)) && progress) {
      progress = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i] as Pt[];
        if (eq(last(cur), s[0] as Pt)) cur = [...cur, ...s.slice(1)];
        else if (eq(last(cur), last(s))) cur = [...cur, ...s.slice(0, -1).reverse()];
        else if (eq(cur[0] as Pt, last(s))) cur = [...s, ...cur.slice(1)];
        else if (eq(cur[0] as Pt, s[0] as Pt)) cur = [...s.slice().reverse(), ...cur.slice(1)];
        else continue;
        pool.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (cur.length >= 4 && eq(cur[0] as Pt, last(cur))) rings.push(cur);
  }
  return rings;
}

// ---------- classification ----------

type RoadClass = 'A' | 'B' | 'minor' | 'track' | 'path';
const HIGHWAY: Record<string, RoadClass> = {
  trunk: 'A', trunk_link: 'A', primary: 'A', primary_link: 'A',
  secondary: 'B', secondary_link: 'B',
  tertiary: 'minor', tertiary_link: 'minor', unclassified: 'minor', residential: 'minor', service: 'minor', living_street: 'minor',
  track: 'track',
  path: 'path', footway: 'path', bridleway: 'path', cycleway: 'path', steps: 'path', pedestrian: 'path',
};
const ACTIVE_RAIL = new Set(['rail', 'preserved', 'light_rail', 'narrow_gauge', 'tram']);

type RailState = 'active' | 'disused' | 'abandoned';
function railState(t: Record<string, string>): RailState | null {
  const v = t.railway;
  if (v !== undefined) {
    if (ACTIVE_RAIL.has(v)) return 'active';
    if (v === 'disused') return 'disused';
    if (v === 'abandoned') return 'abandoned';
    return null;
  }
  if (t['disused:railway'] !== undefined) return 'disused';
  if (t['abandoned:railway'] !== undefined) return 'abandoned';
  return null;
}

export type BuildingType = 'house' | 'farm' | 'shop' | 'pub' | 'church' | 'school' | 'industrial' | 'military' | 'other';
const HOUSE = new Set(['house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'apartments', 'dormitory', 'static_caravan', 'cabin', 'hut']);
const FARM = new Set(['farm', 'farm_auxiliary', 'barn', 'stable', 'cowshed', 'agricultural', 'sty', 'greenhouse']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'service', 'storage_tank', 'silo', 'works', 'hangar']);
const SHOP = new Set(['retail', 'commercial', 'supermarket', 'kiosk', 'shop']);
const CHURCH = new Set(['church', 'chapel', 'cathedral']);
const SCHOOL = new Set(['school', 'college', 'kindergarten', 'university']);

/** Building type from building=*, amenity, shop and military zones. `inMilitary` is true inside a camp-sized military landuse. */
export function buildingType(t: Record<string, string>, inMilitary: boolean, areaM2: number): BuildingType {
  const b = t.building ?? '';
  if (b === 'military' || t.military !== undefined || inMilitary) return 'military';
  if (t.amenity === 'pub' || t.amenity === 'bar') return 'pub';
  if (t.amenity === 'place_of_worship' || CHURCH.has(b)) return 'church';
  if (t.amenity === 'school' || t.amenity === 'college' || t.amenity === 'kindergarten' || SCHOOL.has(b)) return 'school';
  if (t.shop !== undefined || SHOP.has(b)) return 'shop';
  if (FARM.has(b)) return 'farm';
  if (INDUSTRIAL.has(b)) return 'industrial';
  if (HOUSE.has(b)) return 'house';
  if (b === 'yes' && areaM2 < 250) return 'house';
  return 'other';
}

const LANDUSE_FIELD = new Set(['farmland', 'meadow', 'grass', 'farmyard', 'orchard', 'allotments', 'recreation_ground', 'village_green', 'cemetery', 'greenfield']);
const LANDUSE_BUILT = new Set(['residential', 'industrial', 'commercial', 'retail', 'garages', 'construction', 'railway', 'depot']);
const LANDUSE_WOOD = new Set(['forest']);

interface Poly {
  id: string;
  tags: Record<string, string>;
  ring: Pt[];
}

/** Closed way or multipolygon outer rings as polygons. */
function collectPolys(els: readonly OsmEl[]): Poly[] {
  const out: Poly[] = [];
  for (const el of els) {
    const k = el.type[0] as string;
    if (el.type === 'way' && el.pts && el.pts.length >= 4 && eq(el.pts[0] as Pt, last(el.pts))) {
      out.push({ id: `${k}${el.id}`, tags: el.tags, ring: el.pts });
    } else if (el.type === 'relation' && el.members && (el.tags.type === 'multipolygon' || el.tags.type === undefined)) {
      const outers = el.members.filter((m) => m.role === 'outer' || m.role === '').map((m) => m.pts);
      stitchRings(outers).forEach((ring, i) => out.push({ id: `${k}${el.id}${i ? `-${i}` : ''}`, tags: el.tags, ring }));
    }
  }
  return out;
}

// ---------- features ----------

const r1 = (v: number): number => Math.max(0, Math.min(PATCH_M, Math.round(v * 10) / 10));
const roundPts = (pts: readonly Pt[]): Pt[] => pts.map((p) => [r1(p[0]), r1(p[1])]);
const nameOf = (t: Record<string, string>): { name?: string } => (t.name ? { name: t.name } : {});

export interface FeatureBuild {
  features: Record<string, unknown>;
  landcover: Uint8Array;
  stats: Record<string, number>;
}

interface RiverOut {
  id: string;
  name?: string;
  kind: 'river' | 'stream';
  pts: Pt[];
}

/** Builds features.json content and the landcover raster from parsed OSM. `terrain` supplies heights for the unmapped default. */
export function buildFromOsm(elements: readonly OsmEl[], terrain: Terrain, source: string): FeatureBuild {
  const ways = elements.filter((e) => e.type === 'way' && e.pts);
  const polys = collectPolys(elements.filter((e) => e.type !== 'node'));

  // Lines
  const roads: { id: string; cls: RoadClass; name?: string; ref?: string; pts: Pt[] }[] = [];
  const rail: { id: string; state: RailState; name?: string; pts: Pt[] }[] = [];
  const rivers: RiverOut[] = [];
  const barriers: { id: string; kind: 'wall' | 'hedgebank' | 'fence'; pts: Pt[] }[] = [];
  const bridgeSrc: { carrier: string; on: 'road' | 'rail'; major: boolean; name?: string; pts: Pt[] }[] = [];

  const emit = (el: OsmEl, push: (id: string, pts: Pt[]) => string | void, minLen = 3): void => {
    const runs = clipLine(el.pts as Pt[]);
    runs.forEach((run, i) => {
      const pts = roundPts(simplifyLine(run, LINE_TOL_M));
      if (pts.length < 2 || lineLength(pts) < minLen) return;
      push(`w${el.id}${i ? `-${i}` : ''}`, pts);
    });
  };

  for (const el of ways) {
    const t = el.tags;
    const cls = t.highway !== undefined ? HIGHWAY[t.highway] : undefined;
    const state = cls === undefined ? railState(t) : null;
    const isBridge = t.bridge !== undefined && t.bridge !== 'no';
    if (cls !== undefined && t.area !== 'yes') {
      emit(el, (id, pts) => {
        const name = t.name ?? t.ref;
        roads.push({ id, cls, ...(name ? { name } : {}), ...(t.ref ? { ref: t.ref } : {}), pts });
        if (isBridge) bridgeSrc.push({ carrier: id, on: 'road', major: cls === 'A' || cls === 'B', ...nameOf(t), pts });
      });
    } else if (state !== null) {
      emit(el, (id, pts) => {
        rail.push({ id, state, ...nameOf(t), pts });
        if (isBridge) bridgeSrc.push({ carrier: id, on: 'rail', major: true, ...nameOf(t), pts });
      });
    } else if (t.waterway === 'river' || t.waterway === 'stream') {
      emit(el, (id, pts) => void rivers.push({ id, ...nameOf(t), kind: t.waterway as 'river' | 'stream', pts }), 5);
    } else if (t.barrier !== undefined) {
      const kind = t.barrier === 'hedge' || t.barrier === 'hedge_bank' ? 'hedgebank' : t.barrier === 'wall' ? 'wall' : t.barrier === 'fence' ? 'fence' : null;
      if (kind) emit(el, (id, pts) => void barriers.push({ id, kind, pts }), 8);
    }
  }

  // Military zones that are camp-sized (the Dartmoor firing ranges are far bigger).
  const milZones = polys.filter((p) => (p.tags.landuse === 'military' || p.tags.military !== undefined) && p.tags.building === undefined && ringArea(p.ring) <= MAX_CAMP_AREA_M2);

  // Polygons: buildings, water, woods
  const buildings: { id: string; type: BuildingType; name?: string; ring: Pt[] }[] = [];
  const water: { id: string; name?: string; ring: Pt[] }[] = [];
  const woods: { id: string; ring: Pt[] }[] = [];
  const buildingCentroids: Pt[] = [];
  for (const p of polys) {
    const t = p.tags;
    if (t.building !== undefined && t.building !== 'no') {
      if (!p.ring.every(inPatch)) continue;
      const ring = simplifyRing(p.ring, BUILDING_TOL_M);
      if (!ring) continue;
      const c = centroid(ring);
      buildingCentroids.push(c);
      const type = buildingType(t, milZones.some((z) => pointInRing(c[0], c[1], z.ring)), ringArea(ring));
      buildings.push({ id: p.id, type, ...nameOf(t), ring: roundPts(ring) });
    } else if (t.natural === 'water' || t.landuse === 'reservoir' || t.waterway === 'riverbank') {
      const clipped = clipRing(p.ring);
      const ring = clipped && simplifyRing(clipped, LINE_TOL_M);
      if (ring && ringArea(ring) >= 100) water.push({ id: p.id, ...nameOf(t), ring: roundPts(ring) });
    } else if (t.natural === 'wood' || LANDUSE_WOOD.has(t.landuse ?? '')) {
      const clipped = clipRing(p.ring);
      const ring = clipped && simplifyRing(clipped, LINE_TOL_M);
      if (ring && ringArea(ring) >= 400) woods.push({ id: p.id, ring: roundPts(ring) });
    }
  }

  // Standalone building nodes (rare) and place/station/peak nodes
  const nodes = elements.filter((e) => e.type === 'node' && e.pt && inPatch(e.pt));
  const settlements: { name: string; x: number; y: number; kind: string }[] = [];
  const pois: { kind: string; name: string; x: number; y: number }[] = [{ kind: 'target-railway', name: 'Old target railway', x: r1(START.x), y: r1(START.y) }];
  const PLACE: Record<string, string> = { city: 'town', town: 'town', village: 'village', hamlet: 'hamlet' };
  for (const el of nodes) {
    const t = el.tags;
    const [x, y] = el.pt as Pt;
    const place = t.place !== undefined ? PLACE[t.place] : undefined;
    if (place && t.name) settlements.push({ name: t.name, x: r1(x), y: r1(y), kind: place });
    if (t.natural === 'peak' && t.name) pois.push({ kind: /\b(tor|willhays)\b/i.test(t.name) ? 'tor' : 'peak', name: t.name, x: r1(x), y: r1(y) });
    else if (t.natural === 'rock' && t.name && /\btor\b/i.test(t.name)) pois.push({ kind: 'tor', name: t.name, x: r1(x), y: r1(y) });
    if ((t.railway === 'station' || t.railway === 'halt') && t.name) pois.push({ kind: 'station', name: t.name, x: r1(x), y: r1(y) });
  }
  for (const p of polys) {
    if (!p.tags.name) continue;
    const c = centroid(p.ring);
    if (!inPatch(c)) continue;
    const poi = (kind: string): void => void pois.push({ kind, name: p.tags.name as string, x: r1(c[0]), y: r1(c[1]) });
    if (p.tags.landuse === 'quarry') poi('quarry');
    if (milZones.includes(p) && /camp/i.test(p.tags.name)) {
      poi('camp');
      settlements.push({ name: p.tags.name, x: r1(c[0]), y: r1(c[1]), kind: 'camp' });
    }
  }
  for (const el of ways) {
    if (el.tags.waterway === 'dam' && el.tags.name) {
      const c = pointAlong(el.pts as Pt[], lineLength(el.pts as Pt[]) / 2);
      if (inPatch(c)) pois.push({ kind: 'dam', name: el.tags.name, x: r1(c[0]), y: r1(c[1]) });
    }
  }

  // Bridges: record the river each one crosses; road/rail over a river is major.
  const bridges: Record<string, unknown>[] = [];
  const riverCrossed = (pts: readonly Pt[]): RiverOut | null => {
    let found: RiverOut | null = null;
    for (const rv of rivers) {
      for (let i = 1; i < pts.length && found?.kind !== 'river'; i++) {
        for (let j = 1; j < rv.pts.length; j++) {
          if (segIntersects(pts[i - 1] as Pt, pts[i] as Pt, rv.pts[j - 1] as Pt, rv.pts[j] as Pt)) {
            if (!found || rv.kind === 'river') found = rv;
            break;
          }
        }
      }
    }
    if (found) return found;
    // Rivers are often broken at the bridge, so accept a river end close to the deck.
    let bestD = 15;
    const len = lineLength(pts);
    for (let s = 0; s <= len; s += 5) {
      const p = pointAlong(pts, s);
      for (const rv of rivers) {
        for (let j = 1; j < rv.pts.length; j++) {
          const d = segDist(p, rv.pts[j - 1] as Pt, rv.pts[j] as Pt);
          if (d < bestD) {
            bestD = d;
            found = rv;
          }
        }
      }
    }
    return found;
  };
  for (const b of bridgeSrc) {
    const len = lineLength(b.pts);
    const mid = pointAlong(b.pts, len / 2);
    const rv = riverCrossed(b.pts);
    const viaduct = /viaduct/i.test(b.name ?? '');
    bridges.push({
      id: `br-${b.carrier}`,
      on: b.on,
      refId: b.carrier,
      ...(b.name ? { name: b.name } : {}),
      x: r1(mid[0]),
      y: r1(mid[1]),
      len: Math.round(len * 10) / 10,
      ...(rv ? { crosses: rv.id, ...(rv.name ? { crossesName: rv.name } : {}) } : {}),
      major: viaduct || (b.major && rv?.kind === 'river'),
    });
  }

  // Landcover
  const landcover = rasteriseLandcover(polys, buildingCentroids, terrain);

  const features = { source, attribution: '(c) OpenStreetMap contributors, ODbL', roads, rail, rivers, water, woods, buildings, settlements, barriers, bridges, pois };
  return {
    features,
    landcover,
    stats: { roads: roads.length, rail: rail.length, rivers: rivers.length, water: water.length, woods: woods.length, buildings: buildings.length, barriers: barriers.length, bridges: bridges.length, majorBridges: bridges.filter((b) => b.major).length },
  };
}

// ---------- landcover ----------

/** Paint order, lowest first. Later entries overwrite earlier ones. */
function polyLandcover(t: Record<string, string>): { layer: number; code: number | 'scrub' } | null {
  const lu = t.landuse ?? '';
  const nat = t.natural ?? '';
  if (LANDUSE_FIELD.has(lu)) return { layer: 1, code: LandCover.Field };
  if (nat === 'grassland' || nat === 'fell' || nat === 'moor') return { layer: 2, code: LandCover.MoorGrass };
  if (nat === 'heath') return { layer: 2, code: LandCover.Heather };
  if (nat === 'scrub') return { layer: 3, code: 'scrub' };
  if (nat === 'wetland') return { layer: 4, code: LandCover.Bog };
  if (nat === 'wood' || LANDUSE_WOOD.has(lu)) return { layer: 5, code: LandCover.Wood };
  if (nat === 'bare_rock' || nat === 'scree' || nat === 'rock') return { layer: 6, code: LandCover.Rock };
  if (lu === 'quarry') return { layer: 7, code: LandCover.Quarry };
  if (LANDUSE_BUILT.has(lu)) return { layer: 8, code: LandCover.BuiltUp };
  if (nat === 'water' || lu === 'reservoir' || t.waterway === 'riverbank') return { layer: 9, code: LandCover.Water };
  return null;
}

export function rasteriseLandcover(polys: readonly Poly[], buildingCentroids: readonly Pt[], terrain: Terrain): Uint8Array {
  const out = new Uint8Array(CELLS * CELLS);
  const heightOf = (cx: number, cy: number): number => heightAt(terrain, (cx + 0.5) * CELL, (cy + 0.5) * CELL);
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) out[cy * CELLS + cx] = heightOf(cx, cy) > MOOR_LINE_M ? LandCover.MoorGrass : LandCover.Field;
  }
  const painted = polys
    .map((p) => ({ p, c: polyLandcover(p.tags) }))
    .filter((x): x is { p: Poly; c: { layer: number; code: number | 'scrub' } } => x.c !== null)
    .sort((a, b) => a.c.layer - b.c.layer);
  for (const { p, c } of painted) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of p.ring) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    const i0 = Math.max(0, Math.floor(x0 / CELL));
    const i1 = Math.min(CELLS - 1, Math.floor(x1 / CELL));
    const j0 = Math.max(0, Math.floor(y0 / CELL));
    const j1 = Math.min(CELLS - 1, Math.floor(y1 / CELL));
    for (let cy = j0; cy <= j1; cy++) {
      for (let cx = i0; cx <= i1; cx++) {
        if (!pointInRing((cx + 0.5) * CELL, (cy + 0.5) * CELL, p.ring)) continue;
        // Scrub is heather on the moor and woodland below it.
        out[cy * CELLS + cx] = c.code === 'scrub' ? (heightOf(cx, cy) > MOOR_LINE_M ? LandCover.Heather : LandCover.Wood) : c.code;
      }
    }
  }
  // A cell holding three or more buildings is built-up, unless it is water.
  const count = new Uint8Array(CELLS * CELLS);
  for (const b of buildingCentroids) {
    const k = Math.floor(b[1] / CELL) * CELLS + Math.floor(b[0] / CELL);
    if (k >= 0 && k < count.length) count[k] = Math.min(255, (count[k] as number) + 1);
  }
  for (let k = 0; k < out.length; k++) if ((count[k] as number) >= 3 && out[k] !== LandCover.Water) out[k] = LandCover.BuiltUp;
  return out;
}

// ---------- fetch and step ----------

async function fetchRaw(): Promise<void> {
  const bbox = patchBboxWgs84();
  const body = new URLSearchParams({ data: buildQuery(bbox) });
  console.log(`[osm] bbox S,W,N,E = ${bbox.join(', ')}`);
  let lastErr: unknown = null;
  for (const url of OVERPASS_URLS) {
    try {
      console.log(`[osm] querying ${url}`);
      const res = await fetch(url, { method: 'POST', body, headers: { 'User-Agent': 'high-water-mark-worldgen/0.1' }, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json: unknown = JSON.parse(text);
      if (!isObj(json) || !Array.isArray(json.elements) || json.elements.length === 0) throw new Error('no elements in response');
      mkdirSync(RAW_DIR, { recursive: true });
      writeFileSync(RAW_PATH, text);
      console.log(`[osm] saved ${(text.length / 1e6).toFixed(1)} MB to ${RAW_PATH}`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[osm] ${url} failed: ${String(err)}`);
    }
  }
  throw new Error(`osm: Overpass unreachable: ${String(lastErr)}`);
}

function loadTerrain(): Terrain {
  const meta = JSON.parse(readFileSync(join(WORLD_DIR, 'terrain.json'), 'utf8')) as TerrainMeta;
  const hb = readFileSync(join(WORLD_DIR, 'terrain.bin'));
  const heightsDm = new Int16Array(meta.postsX * meta.postsY);
  for (let k = 0; k < heightsDm.length; k++) heightsDm[k] = hb.readInt16LE(k * 2);
  return { meta, sizeX: meta.cellM * (meta.postsX - 1), sizeY: meta.cellM * (meta.postsY - 1), heightsDm, landcover: new Uint8Array(CELLS * CELLS) };
}

async function run(): Promise<void> {
  if (!existsSync(RAW_PATH)) await fetchRaw();
  const { elements, timestamp } = parseOverpass(JSON.parse(readFileSync(RAW_PATH, 'utf8')) as unknown);
  const built = buildFromOsm(elements, loadTerrain(), `OpenStreetMap via Overpass (data as of ${timestamp})`);
  const json = JSON.stringify(built.features) + '\n';
  if (json.length > MAX_FEATURES_BYTES) console.warn(`[osm] WARNING: features.json is ${(json.length / 1e6).toFixed(2)} MB, over the ${MAX_FEATURES_BYTES / 1e6} MB budget`);
  mkdirSync(WORLD_DIR, { recursive: true });
  writeFileSync(join(WORLD_DIR, 'features.json'), json);
  writeFileSync(join(WORLD_DIR, 'landcover.bin'), built.landcover);
  const hist = new Array<number>(9).fill(0);
  for (const c of built.landcover) hist[c] = (hist[c] as number) + 1;
  console.log(`[osm] wrote features.json (${(json.length / 1e6).toFixed(2)} MB) ${JSON.stringify(built.stats)}`);
  console.log(`[osm] landcover cells by code 0..8: ${hist.join(' ')}`);
}

/** Replaces the synthetic landcover and features with OSM. If Overpass cannot be had, the synthetic stand-in stays and this warns. */
export const osmStep: Step = {
  name: 'OpenStreetMap features and landcover',
  async run() {
    try {
      await run();
    } catch (err) {
      console.warn(`[worldgen:import] WARNING: OSM import failed, keeping SYNTHETIC features and landcover: ${String(err)}`);
    }
  },
};
