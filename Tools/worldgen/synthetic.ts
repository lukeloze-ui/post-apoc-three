// SYNTHETIC STAND-IN for OS Terrain 50 and OS OpenMap/OSM features. Replace with real data via worldgen:import.
// Everything is shaped by deterministic analytic functions (no RNG), so re-running gives byte-identical files.
// Rings in features.json are closed (first point repeated at the end). All coordinates are local metres.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORIGIN_E, ORIGIN_N, gridRefSX } from '../../src/world/geo';
import { LandCover, START, YES_TOR, type TerrainMeta } from '../../src/world/terrain';
import type { Step } from './steps';

export const SYNTHETIC_SOURCE = 'SYNTHETIC STAND-IN - replace with OS Terrain 50';

const CELL = 50;
const POSTS = 201;
const CELLS = POSTS - 1;

type Pt = [number, number];

// ---------- small maths helpers ----------
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const half = (v: number): number => Math.round(v * 2) / 2;
const gauss = (d: number, w: number): number => Math.exp(-((d / w) ** 2));
const R = (p: Pt): Pt => [half(p[0]), half(p[1])];

/** Smooth pseudo-noise in about [-1, 1]; a fixed sum of sinusoids, no RNG. */
function noise(x: number, y: number, seed: number): number {
  const s = seed * 1.7;
  return (
    0.5 * Math.sin(x * 0.0071 + s) * Math.sin(y * 0.0083 + s * 2.3) +
    0.3 * Math.sin(x * 0.0173 + y * 0.0121 + s * 3.1) +
    0.2 * Math.sin(x * 0.0311 - y * 0.0277 + s * 0.7)
  );
}

function segDist(px: number, py: number, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1);
  return { d: Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t };
}

interface Line {
  pts: Pt[];
  cum: number[];
  len: number;
}
function makeLine(pts: Pt[]): Line {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1] as Pt;
    const b = pts[k] as Pt;
    cum.push((cum[k - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, cum, len: cum[cum.length - 1] as number };
}
/** Nearest distance to the line and the arc fraction (0..1) at that point. */
function project(line: Line, x: number, y: number): { d: number; s: number } {
  let best = Infinity;
  let s = 0;
  for (let k = 1; k < line.pts.length; k++) {
    const r = segDist(x, y, line.pts[k - 1] as Pt, line.pts[k] as Pt);
    if (r.d < best) {
      best = r.d;
      const c0 = line.cum[k - 1] as number;
      s = (c0 + r.t * ((line.cum[k] as number) - c0)) / line.len;
    }
  }
  return { d: best, s };
}
function distToLine(pts: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let k = 1; k < pts.length; k++) best = Math.min(best, segDist(x, y, pts[k - 1] as Pt, pts[k] as Pt).d);
  return best;
}
/** Catmull-Rom through the control points, then resampled at an even spacing. */
function smoothLine(ctrl: Pt[], step: number): Pt[] {
  const dense: Pt[] = [];
  for (let k = 0; k < ctrl.length - 1; k++) {
    const p0 = ctrl[Math.max(k - 1, 0)] as Pt;
    const p1 = ctrl[k] as Pt;
    const p2 = ctrl[k + 1] as Pt;
    const p3 = ctrl[Math.min(k + 2, ctrl.length - 1)] as Pt;
    for (let u = 0; u < 1; u += 0.05) {
      const f = (i: 0 | 1): number =>
        0.5 *
        (2 * p1[i] +
          (-p0[i] + p2[i]) * u +
          (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u * u +
          (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u * u * u);
      dense.push([f(0), f(1)]);
    }
  }
  dense.push(ctrl[ctrl.length - 1] as Pt);
  return resample(dense, step);
}
function resample(pts: Pt[], step: number): Pt[] {
  const line = makeLine(pts);
  const out: Pt[] = [pts[0] as Pt];
  let next = step;
  for (let k = 1; k < pts.length && next < line.len; k++) {
    while (next <= (line.cum[k] as number) && next < line.len) {
      const a = pts[k - 1] as Pt;
      const b = pts[k] as Pt;
      const c0 = line.cum[k - 1] as number;
      const t = ((next - c0) / ((line.cum[k] as number) - c0)) as number;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      next += step;
    }
  }
  out.push(pts[pts.length - 1] as Pt);
  return out;
}
/** Ring around a polyline with a half-width that varies along it (index fraction 0..1). */
function bufferRing(pts: Pt[], hw: (f: number) => number): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[Math.max(k - 1, 0)] as Pt;
    const b = pts[Math.min(k + 1, pts.length - 1)] as Pt;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / l;
    const ny = (b[0] - a[0]) / l;
    const w = hw(k / (pts.length - 1));
    const p = pts[k] as Pt;
    left.push([p[0] + nx * w, p[1] + ny * w]);
    right.push([p[0] - nx * w, p[1] - ny * w]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0] as Pt);
  return ring;
}
function inRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Pt;
    const b = ring[j] as Pt;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function box(cx: number, cy: number, w: number, h: number, angDeg = 0): Pt[] {
  const c = Math.cos((angDeg * Math.PI) / 180);
  const s = Math.sin((angDeg * Math.PI) / 180);
  const corners: Pt[] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const ring = corners.map(([x, y]): Pt => R([cx + x * c - y * s, cy + x * s + y * c]));
  ring.push(ring[0] as Pt);
  return ring;
}
function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}
const g = (e100m: number, n100m: number): Pt => {
  const p = gridRefSX(e100m, n100m);
  return [p.x, p.y];
};

// ---------- hand-placed geography (local metres; SX refs noted where useful) ----------
const TOWN: Pt = [6700, 7100]; // SX 587 951
const CAMP: Pt = [7000, 5000]; // SX 59 93
const CONFLUENCE: Pt = [6800, 7000];
const HIGH_WILLHAYS = g(580, 892);
const ROW_TOR: Pt = [7700, 3500];

const WEST_OKEMENT = smoothLine(
  [[5050, 700], [4850, 1600], [4800, 2300], [4650, 3000], [4600, 3600], [4600, 4150], [4500, 4700], [4800, 5500], [5400, 6100], [6100, 6600], CONFLUENCE],
  50,
);
const EAST_OKEMENT = smoothLine([[9900, 4300], [9300, 4800], [8700, 5300], [8200, 5900], [7600, 6500], CONFLUENCE], 50);
const OKEMENT = smoothLine([CONFLUENCE, [6850, 7800], [7000, 8500], [7250, 9300], [7300, 10000]], 50);
const STREAM_W = smoothLine([[6700, 1700], [5900, 1900], [5300, 1950], [4820, 2000]], 50);
const STREAM_E = smoothLine([[8500, 2600], [8600, 3600], [8800, 4400], [8750, 5250]], 50);

const westLine = makeLine(WEST_OKEMENT);
const eastLine = makeLine(EAST_OKEMENT);
const mainLine = makeLine(OKEMENT);
const streamWLine = makeLine(STREAM_W);
const streamELine = makeLine(STREAM_E);

const RESERVOIR_Y0 = 3150;
const RESERVOIR_Y1 = 4150;
const reservoirSpine = WEST_OKEMENT.filter((p) => p[1] >= RESERVOIR_Y0 && p[1] <= RESERVOIR_Y1);
const RESERVOIR = bufferRing(reservoirSpine, (f) => 70 + 50 * Math.sin(f * Math.PI) + 15 * Math.sin(f * 17));

const QUARRY: Pt = [3950, 4850]; // Meldon Quarry
const QUARRY_R = 260;

// ---------- terrain ----------
function ridgeBump(x: number, y: number): number {
  const a: Pt = [5800, 300];
  const b: Pt = [6250, 2900];
  const r = segDist(x, y, a, b);
  return 98 * gauss(r.d, 520);
}
function baseHeight(x: number, y: number): number {
  const west = smooth(3000, 0, x);
  const east = smooth(8300, 10000, x);
  const moor = 475 - 100 * west - 55 * east + 9 * noise(x, y, 1) + 4 * noise(x * 3, y * 3, 2);
  const low = 152 + 14 * noise(x, y, 3) - 15 * smooth(7200, 10000, y) + 20 * west;
  const fall = smooth(5500, 7200, y);
  return moor + (low - moor) * fall;
}
function valleyCut(x: number, y: number): number {
  let cut = 0;
  const w = project(westLine, x, y);
  // depth by arc fraction: shallow high up, deepest around Meldon, shallow in town
  const wDepth = 55 + 55 * smooth(0, 0.35, w.s) - 78 * smooth(0.55, 1, w.s);
  cut = Math.max(cut, wDepth * gauss(w.d, 240));
  const e = project(eastLine, x, y);
  cut = Math.max(cut, (40 + 40 * smooth(0, 0.4, e.s) - 50 * smooth(0.7, 1, e.s)) * gauss(e.d, 220));
  const m = project(mainLine, x, y);
  cut = Math.max(cut, 24 * gauss(m.d, 180));
  cut = Math.max(cut, 28 * gauss(project(streamWLine, x, y).d, 110));
  cut = Math.max(cut, 28 * gauss(project(streamELine, x, y).d, 110));
  return cut;
}
const peakBase = (p: Pt): number => baseHeight(p[0], p[1]) + ridgeBump(p[0], p[1]) - valleyCut(p[0], p[1]);
const HW_EXTRA = 621 - peakBase(HIGH_WILLHAYS);
const YT_EXTRA = 619 - peakBase([YES_TOR.x, YES_TOR.y]);

/** Synthetic ground height in metres. */
export function syntheticHeight(x: number, y: number): number {
  let h = baseHeight(x, y) + ridgeBump(x, y);
  h += HW_EXTRA * gauss(Math.hypot(x - HIGH_WILLHAYS[0], y - HIGH_WILLHAYS[1]), 260);
  h += YT_EXTRA * gauss(Math.hypot(x - YES_TOR.x, y - YES_TOR.y), 230);
  h += 22 * gauss(Math.hypot(x - ROW_TOR[0], y - ROW_TOR[1]), 200);
  h -= valleyCut(x, y);
  return h;
}

// ---------- features ----------
interface Road {
  id: string;
  cls: 'A' | 'B' | 'minor' | 'track' | 'path';
  name?: string;
  pts: Pt[];
}
const roads: Road[] = [];
const road = (id: string, cls: Road['cls'], pts: Pt[], name?: string): Road => {
  const r: Road = { id, cls, pts: pts.map(R), ...(name ? { name } : {}) };
  roads.push(r);
  return r;
};

road('r-a30', 'A', smoothLine([[0, 9250], [1800, 9150], [3600, 9300], [5400, 9500], [7300, 9350], [8800, 9100], [10000, 9150]], 100), 'A30');
road('r-b3260', 'B', [[6700, 7600], [7000, 7900], [7300, 8400], [7450, 9000], [7450, 9400]], 'B3260');
road('r-meldon', 'minor', smoothLine([[6200, 6900], [5500, 6350], [4900, 5700], [4550, 4950], [4650, 4150]], 100), 'Meldon Road');
road('r-sourton', 'minor', smoothLine([[4650, 4150], [3700, 3700], [2600, 3100], [1500, 2500], [0, 2000]], 100), 'Sourton Road');
road('r-belstone', 'minor', smoothLine([[7300, 7050], [8300, 6900], [9300, 6300], [10000, 5900]], 100), 'Belstone Road');
road('r-camp', 'minor', [[6900, 6850], [6980, 6000], [7000, 5300], CAMP], 'Camp Road');
road('r-military', 'track', smoothLine([CAMP, [7050, 4400], [7150, 3700], [START.x, START.y]], 100), 'Military Road');
road('r-moor-1', 'track', smoothLine([[START.x, START.y], [6600, 2700], [6200, 2300], [YES_TOR.x, YES_TOR.y]], 100), 'Yes Tor path');
road('r-moor-2', 'path', smoothLine([[YES_TOR.x, YES_TOR.y], [5980, 1700], HIGH_WILLHAYS], 100), 'Tor ridge path');
road('r-ok-1', 'path', smoothLine([[START.x, START.y], [7500, 3300], ROW_TOR], 100));
road('r-field-lane', 'minor', [[7370, 8200], [7000, 8350], [6200, 8350], [5400, 8100], [4600, 8400]], 'Halsdon Lane');
road('r-west-lane', 'minor', [[5500, 6350], [4100, 6900], [2600, 7200], [1000, 7800], [0, 8000]], 'Okement Lane');

// Okehampton streets
road('s-fore', 'minor', [[5900, 7050], [6300, 7080], [6700, 7100], [7100, 7150], [7300, 7050]], 'Fore Street');
road('s-high', 'minor', [[6700, 7100], [6720, 7350], [6700, 7600]], 'High Street');
road('s-station', 'minor', [[6200, 6820], [6250, 7000], [6300, 7080]], 'Station Road');
road('s-market', 'minor', [[6450, 7090], [6460, 7300], [6600, 7420]], 'Market Street');
road('s-st-james', 'minor', [[6950, 7130], [6950, 7350], [7120, 7500]], 'St James Street');
road('s-castle', 'minor', [[6500, 6880], [6420, 7000], [6330, 7090]], 'Castle Lane');
road('s-mill', 'minor', [[6900, 7140], [7000, 6900], [6900, 6850]], 'Mill Road');
road('s-new', 'minor', [[6720, 7500], [6400, 7550], [6250, 7400]], 'New Road');
road('s-church', 'minor', [[6700, 7350], [6900, 7380], [6950, 7350]], 'Church Lane');

const rail = [
  {
    id: 'rail-1',
    state: 'disused' as const,
    pts: smoothLine([[6350, 6900], [5700, 6550], [5100, 6200], [4800, 5750], [4550, 5150], [4500, 4650], [4150, 4650], [3200, 4400], [2000, 4000], [0, 3700]], 50).map(R),
  },
];

const rivers = [
  { id: 'rv-west-1', name: 'West Okement', kind: 'river' as const, pts: WEST_OKEMENT.filter((p) => p[1] <= RESERVOIR_Y0) },
  { id: 'rv-west-2', name: 'West Okement', kind: 'river' as const, pts: WEST_OKEMENT.filter((p) => p[1] >= RESERVOIR_Y1) },
  { id: 'rv-east', name: 'East Okement', kind: 'river' as const, pts: EAST_OKEMENT },
  { id: 'rv-main', name: 'Okement', kind: 'river' as const, pts: OKEMENT },
  { id: 'rv-stream-w', kind: 'stream' as const, pts: STREAM_W },
  { id: 'rv-stream-e', kind: 'stream' as const, pts: STREAM_E },
].map((r) => ({ ...r, pts: r.pts.map(R) }));

const water = [{ id: 'w-meldon', name: 'Meldon Reservoir', ring: RESERVOIR.map(R) }];

// Valley woods along the lower West and East Okement.
const sliceByArc = (pts: Pt[], f0: number, f1: number): Pt[] =>
  pts.slice(Math.floor(f0 * (pts.length - 1)), Math.ceil(f1 * (pts.length - 1)) + 1);
const woodRings: { id: string; ring: Pt[] }[] = [
  { id: 'wd-meldon', ring: bufferRing(sliceByArc(WEST_OKEMENT, 0.38, 0.5), (f) => 130 + 50 * Math.sin(f * 9)) },
  { id: 'wd-west-lower', ring: bufferRing(sliceByArc(WEST_OKEMENT, 0.62, 0.8), (f) => 160 + 60 * Math.sin(f * 7)) },
  { id: 'wd-east-lower', ring: bufferRing(sliceByArc(EAST_OKEMENT, 0.5, 0.88), (f) => 120 + 40 * Math.sin(f * 8)) },
  { id: 'wd-okement-north', ring: bufferRing(sliceByArc(OKEMENT, 0.05, 0.5), (f) => 110 + 35 * Math.sin(f * 6)) },
  { id: 'wd-west-upper', ring: bufferRing(sliceByArc(WEST_OKEMENT, 0.06, 0.2), (f) => 90 + 30 * Math.sin(f * 11)) },
].map((w) => ({ id: w.id, ring: w.ring.map(R) }));

// Buildings
interface Building {
  id: string;
  type: 'house' | 'farm' | 'shop' | 'pub' | 'church' | 'school' | 'industrial' | 'military' | 'other';
  name?: string;
  ring: Pt[];
}
const buildings: Building[] = [];
const addBuilding = (type: Building['type'], cx: number, cy: number, w: number, h: number, ang = 0, name?: string): void => {
  buildings.push({ id: `b-${buildings.length + 1}`, type, ...(name ? { name } : {}), ring: box(cx, cy, w, h, ang) });
};
const roadById = (id: string): Road => roads.find((r) => r.id === id) as Road;
/** Houses along both sides of a street every `step` metres, skipping spots near water or other streets' junction points. */
function terrace(roadId: string, step: number, offset: number, w: number, h: number): void {
  const pts = resample(roadById(roadId).pts, step);
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1] as Pt;
    const b = pts[k + 1] as Pt;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / l;
    const ny = (b[0] - a[0]) / l;
    const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const p = pts[k] as Pt;
    for (const side of [1, -1]) {
      const cx = p[0] + nx * offset * side;
      const cy = p[1] + ny * offset * side;
      const nearWater = [WEST_OKEMENT, EAST_OKEMENT, OKEMENT].some((rv) => distToLine(rv, cx, cy) < 45);
      if (!nearWater) addBuilding('house', cx, cy, w, h, ang);
    }
  }
}
terrace('s-fore', 34, 17, 10, 8);
terrace('s-high', 32, 16, 9, 8);
terrace('s-market', 30, 15, 9, 8);
terrace('s-st-james', 34, 16, 9, 8);
terrace('s-new', 36, 16, 10, 8);
terrace('s-station', 30, 15, 9, 8);
// Town landmarks
addBuilding('church', 6790, 7330, 24, 12, 0, 'All Saints Church');
addBuilding('school', 6560, 7480, 40, 18, 15, 'Okehampton Primary School');
addBuilding('pub', 6600, 7118, 16, 12, 0, 'The White Hart');
addBuilding('pub', 6850, 7082, 16, 12, 0, 'The Plume of Feathers');
addBuilding('shop', 6650, 7120, 14, 10, 0, 'Co-op');
addBuilding('shop', 6760, 7082, 12, 10);
addBuilding('shop', 6500, 7062, 12, 10);
addBuilding('industrial', 6180, 6760, 50, 25, 20, 'Station goods shed');
addBuilding('industrial', 7050, 6830, 40, 20, 0, 'Mill works');
addBuilding('other', 6360, 6840, 40, 22, 40, 'Okehampton Castle');
addBuilding('other', 6280, 6960, 30, 14, 0, 'Okehampton Station');
// Farms around the edge of town and the Meldon road
addBuilding('farm', 6150, 8340, 30, 16, 5, 'Halsdon Farm');
addBuilding('farm', 7100, 8300, 28, 16, 0, 'Okement Farm');
addBuilding('farm', 4550, 8450, 26, 14, 0, 'Prewley Farm');
addBuilding('farm', 4700, 5000, 24, 14, 0, 'Meldon Farm');
addBuilding('house', 4520, 4900, 9, 8);
addBuilding('house', 4560, 4780, 9, 8);
// Meldon quarry works
addBuilding('industrial', 4100, 4800, 60, 30, 0, 'Meldon quarry works');
addBuilding('industrial', 4000, 4920, 40, 20, 0, 'Meldon crusher');
// Okehampton Camp
const campHuts: [number, number, number][] = [
  [-80, -40, 0], [-40, -40, 0], [0, -40, 0], [40, -40, 0], [80, -40, 0],
  [-80, 40, 0], [-40, 40, 0], [0, 40, 0], [40, 40, 0], [80, 40, 0],
];
for (const [dx, dy, ang] of campHuts) addBuilding('military', CAMP[0] + dx, CAMP[1] + dy, 28, 9, ang, 'Camp hut');
addBuilding('military', CAMP[0], CAMP[1], 36, 22, 0, 'Okehampton Camp HQ');
addBuilding('military', CAMP[0] + 130, CAMP[1], 30, 20, 0, 'Camp mess');
addBuilding('military', CAMP[0] - 130, CAMP[1] + 10, 30, 20, 0, 'Camp stores');

const settlements = [
  { name: 'Okehampton', x: TOWN[0], y: TOWN[1], kind: 'town' },
  { name: 'Okehampton Camp', x: CAMP[0], y: CAMP[1], kind: 'camp' },
  { name: 'Meldon', x: 4550, y: 4850, kind: 'hamlet' },
  { name: 'Belstone', x: 9900, y: 5500, kind: 'village' },
  { name: 'Sourton', x: 1400, y: 2400, kind: 'village' },
  { name: 'Prewley', x: 4600, y: 8420, kind: 'hamlet' },
].map((s) => ({ ...s, x: half(s.x), y: half(s.y) }));

const barrierDefs: { id: string; kind: 'wall' | 'hedgebank' | 'fence'; pts: Pt[] }[] = [
  { id: 'bar-1', kind: 'hedgebank', pts: [[5800, 8300], [6000, 8700], [6150, 9000]] },
  { id: 'bar-2', kind: 'hedgebank', pts: [[6300, 7900], [6900, 7880]] },
  { id: 'bar-3', kind: 'hedgebank', pts: [[6300, 7900], [6250, 8350]] },
  { id: 'bar-4', kind: 'hedgebank', pts: [[7100, 7700], [7500, 7750], [7800, 8000]] },
  { id: 'bar-5', kind: 'hedgebank', pts: [[7100, 8600], [7600, 8650], [7650, 9000]] },
  { id: 'bar-6', kind: 'hedgebank', pts: [[4300, 8700], [4900, 8650], [5000, 8200]] },
  { id: 'bar-7', kind: 'wall', pts: [[6300, 5600], [6700, 5700], [7500, 5650], [8000, 5500]] },
  { id: 'bar-8', kind: 'wall', pts: [[5200, 5300], [5600, 5900]] },
  { id: 'bar-9', kind: 'fence', pts: [[CAMP[0] - 220, CAMP[1] - 120], [CAMP[0] + 220, CAMP[1] - 120], [CAMP[0] + 220, CAMP[1] + 120], [CAMP[0] - 220, CAMP[1] + 120], [CAMP[0] - 220, CAMP[1] - 120]] },
];
const barriers = barrierDefs.map((b) => ({ ...b, pts: b.pts.map(R) }));
const pois = [
  { kind: 'target-railway', name: 'Old target railway', x: START.x, y: START.y },
  { kind: 'tor', name: 'Yes Tor', x: YES_TOR.x, y: YES_TOR.y },
  { kind: 'tor', name: 'High Willhays', x: HIGH_WILLHAYS[0], y: HIGH_WILLHAYS[1] },
  { kind: 'tor', name: 'Row Tor', x: ROW_TOR[0], y: ROW_TOR[1] },
  { kind: 'dam', name: 'Meldon Dam', x: 4600, y: RESERVOIR_Y1 + 20 },
  { kind: 'quarry', name: 'Meldon Quarry', x: QUARRY[0], y: QUARRY[1] },
  { kind: 'station', name: 'Okehampton Station', x: 6280, y: 6960 },
  { kind: 'camp', name: 'Okehampton Camp', x: CAMP[0], y: CAMP[1] },
].map((p) => ({ ...p, x: half(p.x), y: half(p.y) }));

// Bridges wherever a road or the railway crosses a river.
const bridges: { id: string; on: 'road' | 'rail'; refId: string; x: number; y: number; len: number; crosses?: string }[] = [];
{
  const carriers = [
    ...roads.filter((r) => r.cls !== 'track' && r.cls !== 'path').map((r) => ({ on: 'road' as const, id: r.id, pts: r.pts, len: r.cls === 'A' ? 30 : r.cls === 'B' ? 20 : 12 })),
    ...rail.map((r) => ({ on: 'rail' as const, id: r.id, pts: r.pts, len: 60 })),
  ];
  for (const c of carriers) {
    for (const rv of rivers) {
      const found: Pt[] = [];
      for (let a = 1; a < c.pts.length; a++) {
        for (let b = 1; b < rv.pts.length; b++) {
          const p = segIntersect(c.pts[a - 1] as Pt, c.pts[a] as Pt, rv.pts[b - 1] as Pt, rv.pts[b] as Pt);
          if (p && !found.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < (c.on === 'rail' ? 300 : 60))) found.push(p);
        }
      }
      for (const p of found) {
        bridges.push({ id: `br-${bridges.length + 1}`, on: c.on, refId: c.id, x: half(p[0]), y: half(p[1]), len: c.len, ...(rv.name || rv.id ? { crosses: rv.id } : {}) });
      }
    }
  }
}

// ---------- rasters ----------
function buildHeights(): Int16Array {
  const out = new Int16Array(POSTS * POSTS);
  const level = syntheticHeight(4600, RESERVOIR_Y1) + 2;
  for (let j = 0; j < POSTS; j++) {
    for (let i = 0; i < POSTS; i++) {
      const x = i * CELL;
      const y = j * CELL;
      let h = syntheticHeight(x, y);
      if (inRing(x, y, RESERVOIR)) h = Math.min(h, level - 3);
      out[j * POSTS + i] = Math.round(clamp(h, 0, 3200) * 10);
    }
  }
  return out;
}

function buildLandcover(): Uint8Array {
  const out = new Uint8Array(CELLS * CELLS);
  const hAt = (x: number, y: number): number => syntheticHeight(x, y);
  const centroids = buildings.map((b) => {
    const r = b.ring.slice(0, -1);
    return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length] as Pt;
  });
  const rvLines = rivers.map((r) => r.pts);
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const x = (cx + 0.5) * CELL;
      const y = (cy + 0.5) * CELL;
      const h = hAt(x, y);
      const slope = Math.hypot(hAt(x + 25, y) - hAt(x - 25, y), hAt(x, y + 25) - hAt(x, y - 25)) / 50;
      let code: number = LandCover.MoorGrass;
      if (inRing(x, y, RESERVOIR) || rvLines.some((l) => distToLine(l, x, y) < 22)) code = LandCover.Water;
      else if (centroids.some((c) => Math.hypot(c[0] - x, c[1] - y) < 55)) code = LandCover.BuiltUp;
      else if (Math.hypot(x - QUARRY[0], y - QUARRY[1]) < QUARRY_R * (0.85 + 0.15 * noise(x, y, 5))) code = LandCover.Quarry;
      else if (woodRings.some((w) => inRing(x, y, w.ring))) code = LandCover.Wood;
      else if (h > 565 || (h > 430 && slope > 0.55)) code = LandCover.Rock;
      else if (h < 300 && slope < 0.3) code = LandCover.Field;
      else if (h > 380 && h < 560 && slope < 0.12 && noise(x, y, 7) > 0.15) code = LandCover.Bog;
      else if (h >= 330 && noise(x, y, 9) > -0.15) code = LandCover.Heather;
      out[cy * CELLS + cx] = code;
    }
  }
  return out;
}

export interface SyntheticWorld {
  meta: TerrainMeta;
  heights: Buffer;
  landcover: Buffer;
  features: string;
}

/** Builds all four files' contents in memory. Pure and deterministic. */
export function buildSynthetic(): SyntheticWorld {
  const heightsDm = buildHeights();
  const hb = Buffer.alloc(heightsDm.length * 2);
  heightsDm.forEach((v, k) => hb.writeInt16LE(v, k * 2));
  const meta: TerrainMeta = {
    version: 1,
    source: SYNTHETIC_SOURCE,
    crs: 'EPSG:27700',
    originE: ORIGIN_E,
    originN: ORIGIN_N,
    cellM: CELL,
    postsX: POSTS,
    postsY: POSTS,
    heightUnit: 'dm',
  };
  const features = {
    roads,
    rail,
    rivers,
    water,
    woods: woodRings,
    buildings,
    settlements,
    barriers,
    bridges,
    pois,
  };
  return { meta, heights: hb, landcover: Buffer.from(buildLandcover()), features: JSON.stringify(features) };
}

export const WORLD_DIR = join(import.meta.dirname, '..', '..', 'public', 'world');

export const syntheticStep: Step = {
  name: 'synthetic terrain and features',
  run() {
    console.warn(`[worldgen:import] WARNING: writing ${SYNTHETIC_SOURCE}`);
    const w = buildSynthetic();
    mkdirSync(WORLD_DIR, { recursive: true });
    writeFileSync(join(WORLD_DIR, 'terrain.json'), JSON.stringify(w.meta, null, 2) + '\n');
    writeFileSync(join(WORLD_DIR, 'terrain.bin'), w.heights);
    writeFileSync(join(WORLD_DIR, 'landcover.bin'), w.landcover);
    writeFileSync(join(WORLD_DIR, 'features.json'), w.features + '\n');
  },
};
