// What the paper map knows: the world before the disaster. Terrain heights and features only.
// It must never import flood, bands, lakes, districts or ground data (see paperMap.test.ts).
import { contours, gridFromDm, levelsBetween, type ContourLine } from '../../world/contours';
import type { Features, Pt, SettlementFeature } from '../../world/features';
import type { Terrain } from '../../world/terrain';

export const CONTOUR_INTERVAL_M = 10;
export const INDEX_INTERVAL_M = 50;

/** A feature with its local-metre bounding box, for tile culling. */
export interface Boxed<T> {
  f: T;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ContourLabel {
  x: number;
  y: number;
  /** Radians anticlockwise from east, kept upright for reading. */
  angle: number;
  text: string;
}

export interface MapData {
  sizeX: number;
  sizeY: number;
  features: Features;
  settlements: SettlementFeature[];
  minor: Boxed<ContourLine>[];
  index: Boxed<ContourLine>[];
  labels: ContourLabel[];
  boxed: {
    roads: Boxed<Features['roads'][number]>[];
    rail: Boxed<Features['rail'][number]>[];
    rivers: Boxed<Features['rivers'][number]>[];
    water: Boxed<Features['water'][number]>[];
    woods: Boxed<Features['woods'][number]>[];
    buildings: Boxed<Features['buildings'][number]>[];
  };
}

function box<T>(f: T, pts: readonly Pt[]): Boxed<T> {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { f, x0, y0, x1, y1 };
}

const LABEL_EVERY_M = 1100;
const LABEL_MIN_LINE_M = 500;

/** Height labels along an index contour at fixed arc lengths, so every map tile agrees on where they go. */
function labelsFor(line: ContourLine): ContourLabel[] {
  const pts = line.pts;
  const out: ContourLabel[] = [];
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
  if (total < LABEL_MIN_LINE_M) return out;
  // Stagger by level so neighbouring index lines do not label side by side.
  let next = 200 + ((line.level / INDEX_INTERVAL_M) % 5) * 180;
  let run = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1] as Pt;
    const b = pts[k] as Pt;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (next <= run + seg && seg > 0) {
      const t = (next - run) / seg;
      const p = pts[Math.min(pts.length - 1, k + 2)] as Pt;
      const q = pts[Math.max(0, k - 3)] as Pt;
      let angle = Math.atan2(p[1] - q[1], p[0] - q[0]);
      if (Math.cos(angle) < 0) angle += Math.PI;
      out.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle, text: String(line.level) });
      next += LABEL_EVERY_M;
    }
    run += seg;
  }
  return out;
}

/** Contours, label positions and culling boxes. A one-off cost at load. */
export function prepareMapData(terrain: Terrain, features: Features): MapData {
  const { postsX, postsY, cellM } = terrain.meta;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of terrain.heightsDm) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const grid = gridFromDm(terrain.heightsDm, postsX, postsY, cellM);
  const lines = contours(grid, levelsBetween(lo / 10, hi / 10, CONTOUR_INTERVAL_M));
  const minor: Boxed<ContourLine>[] = [];
  const index: Boxed<ContourLine>[] = [];
  const labels: ContourLabel[] = [];
  for (const line of lines) {
    if (line.level % INDEX_INTERVAL_M === 0) {
      index.push(box(line, line.pts));
      labels.push(...labelsFor(line));
    } else {
      minor.push(box(line, line.pts));
    }
  }
  return {
    sizeX: terrain.sizeX,
    sizeY: terrain.sizeY,
    features,
    settlements: features.settlements ?? [],
    minor,
    index,
    labels,
    boxed: {
      roads: features.roads.map((f) => box(f, f.pts)),
      rail: features.rail.map((f) => box(f, f.pts)),
      rivers: features.rivers.map((f) => box(f, f.pts)),
      water: features.water.map((f) => box(f, f.ring)),
      woods: features.woods.map((f) => box(f, f.ring)),
      buildings: features.buildings.map((f) => box(f, f.ring)),
    },
  };
}
