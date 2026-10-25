// Paper map renderer in the style of the OS Landranger 1:50k sheet. Canvas2D only.
// Static layers are drawn once per 1 km tile and zoom level into offscreen canvases; the overlay
// (grid numbers, place names, scale bar) is drawn fresh every frame.
// Local frame as in world/terrain.ts: x metres east, y metres north from the patch's SW corner.
import { ORIGIN_E, ORIGIN_N } from '../../world/geo';
import { TILES_PER_SIDE, TILE_M } from '../../world/terrain';
import type { Pt } from '../../world/features';
import type { Boxed, MapData } from './mapData';

/** A hook for the pencil layer: draws in world space through toPx, over the map and under the furniture. */
export type MarksLayer = (ctx: CanvasRenderingContext2D, view: MapView) => void;

export interface MapView {
  width: number;
  height: number;
  /** Local metres at the centre of the screen. */
  cx: number;
  cy: number;
  /** Pixels per metre. */
  scale: number;
  data: MapData;
  /** The marks layer slot. */
  marks?: MarksLayer;
}

export function toPx(view: MapView, x: number, y: number): { px: number; py: number } {
  return { px: view.width / 2 + (x - view.cx) * view.scale, py: view.height / 2 - (y - view.cy) * view.scale };
}

export function toLocal(view: MapView, px: number, py: number): { x: number; y: number } {
  return { x: view.cx + (px - view.width / 2) / view.scale, y: view.cy - (py - view.height / 2) / view.scale };
}

// ---- style -----------------------------------------------------------------------------------

const C = {
  desk: '#4a4333',
  paper: '#f0e8c8',
  wood: '#bcd9a2',
  tree: '#5d9a4a',
  water: '#a6cde8',
  waterEdge: '#3f84c0',
  river: '#3f8fd0',
  contour: '#c9915a',
  index: '#a35d27',
  contourText: '#8a4a1c',
  grid: '#3d86d8',
  gridText: '#2a62b0',
  roadA: '#e0262c',
  roadB: '#f29a2e',
  roadMinor: '#f7e45a',
  black: '#1c1c1c',
  building: '#4d4a46',
  ink: '#262626',
  halo: 'rgba(240,232,200,0.85)',
};

/** Tile image scales in pixels per metre; 1 km is a whole number of pixels at each. */
const LEVEL_SCALES = [0.1, 0.2, 0.4, 0.8];
/** Margin around each tile so lines and symbols that cross a seam are drawn by both tiles. */
const PAD = 48;
const MAX_CACHE_PIXELS = 40_000_000;

export const MIN_MAP_SCALE = 0.05;
export const MAX_MAP_SCALE = 0.8;

const SERIF = 'Georgia, "Times New Roman", serif';

// ---- tile cache ------------------------------------------------------------------------------

class TileCache {
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  private pixels = 0;

  get(data: MapData, level: number, i: number, j: number): HTMLCanvasElement {
    const key = `${level}:${i}:${j}`;
    const hit = this.tiles.get(key);
    if (hit) {
      // Re-insert to mark as most recently used.
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return hit;
    }
    const c = renderTile(data, level, i, j);
    this.tiles.set(key, c);
    this.pixels += c.width * c.height;
    for (const [k, old] of this.tiles) {
      if (this.pixels <= MAX_CACHE_PIXELS || k === key) break;
      this.tiles.delete(k);
      this.pixels -= old.width * old.height;
    }
    return c;
  }
}

const caches = new WeakMap<MapData, TileCache>();

function cacheFor(data: MapData): TileCache {
  let c = caches.get(data);
  if (!c) caches.set(data, (c = new TileCache()));
  return c;
}

// ---- static layers ---------------------------------------------------------------------------

type Tf = (x: number, y: number) => readonly [number, number];

/** Adds a polyline to the current path, dropping points under 0.7 px from the last one kept. */
function trace(g: CanvasRenderingContext2D, pts: readonly Pt[], tf: Tf): void {
  let lx = NaN;
  let ly = NaN;
  for (let k = 0; k < pts.length; k++) {
    const [px, py] = tf(pts[k]![0], pts[k]![1]);
    const last = k === pts.length - 1;
    if (k > 0 && !last && Math.abs(px - lx) + Math.abs(py - ly) < 0.7) continue;
    if (k === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
    lx = px;
    ly = py;
  }
}

function renderTile(data: MapData, level: number, i: number, j: number): HTMLCanvasElement {
  const s = LEVEL_SCALES[level] as number;
  const tilePx = Math.round(TILE_M * s);
  const size = tilePx + 2 * PAD;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  // Line widths and symbols grow gently with zoom, as printed maps would not.
  const wf = 1 + 0.4 * level;
  const tf = 1 + 0.15 * level;

  const x0 = i * TILE_M;
  const y1 = (j + 1) * TILE_M;
  const tfm: Tf = (x, y) => [(x - x0) * s + PAD, (y1 - y) * s + PAD];
  const m = PAD / s;
  const bx0 = x0 - m;
  const bx1 = x0 + TILE_M + m;
  const by0 = j * TILE_M - m;
  const by1 = y1 + m;
  const near = <T>(b: Boxed<T>): boolean => b.x1 >= bx0 && b.x0 <= bx1 && b.y1 >= by0 && b.y0 <= by1;

  g.fillStyle = C.paper;
  g.fillRect(0, 0, size, size);
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // Woods: green fill, tree symbols on a lattice fixed to the world so tiles agree.
  const space = (11 * wf) / s;
  for (const w of data.boxed.woods) {
    if (!near(w)) continue;
    g.beginPath();
    trace(g, w.f.ring, tfm);
    g.closePath();
    g.fillStyle = C.wood;
    g.fill();
    g.save();
    g.clip();
    g.strokeStyle = C.tree;
    g.lineWidth = 0.7 * tf;
    g.beginPath();
    const r = 2.1 * tf;
    const ra = Math.max(w.x0, bx0);
    const rb = Math.min(w.x1, bx1);
    const rc = Math.max(w.y0, by0);
    const rd = Math.min(w.y1, by1);
    for (let row = Math.floor(rc / space); row * space <= rd; row++) {
      const shift = row % 2 ? space / 2 : 0;
      for (let col = Math.floor((ra - shift) / space); col * space + shift <= rb; col++) {
        const [px, py] = tfm(col * space + shift, row * space);
        g.moveTo(px + r, py);
        g.arc(px, py, r, 0, Math.PI * 2);
      }
    }
    g.stroke();
    g.restore();
  }

  // Water.
  g.fillStyle = C.water;
  g.strokeStyle = C.waterEdge;
  g.lineWidth = 0.8 * wf;
  for (const w of data.boxed.water) {
    if (!near(w)) continue;
    g.beginPath();
    trace(g, w.f.ring, tfm);
    g.closePath();
    g.fill();
    g.stroke();
  }

  // Contours: 10 m thin, 50 m index thicker.
  const strokeLines = (set: Boxed<{ pts: Pt[] }>[], color: string, width: number): void => {
    g.beginPath();
    for (const b of set) if (near(b)) trace(g, b.f.pts, tfm);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  };
  strokeLines(data.minor, C.contour, 0.55 * wf);
  strokeLines(data.index, C.index, 1.1 * wf);

  g.font = `italic ${9 * tf}px ${SERIF}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 3 * tf;
  g.strokeStyle = C.paper;
  g.fillStyle = C.contourText;
  for (const l of data.labels) {
    if (l.x < bx0 || l.x > bx1 || l.y < by0 || l.y > by1) continue;
    const [px, py] = tfm(l.x, l.y);
    g.save();
    g.translate(px, py);
    g.rotate(-l.angle);
    g.strokeText(l.text, 0, 0);
    g.fillText(l.text, 0, 0);
    g.restore();
  }

  // Rivers and streams.
  g.strokeStyle = C.river;
  g.lineWidth = 1.7 * wf;
  g.beginPath();
  for (const r of data.boxed.rivers) if (near(r) && r.f.kind === 'river') trace(g, r.f.pts, tfm);
  g.stroke();
  g.lineWidth = 0.9 * wf;
  g.beginPath();
  for (const r of data.boxed.rivers) if (near(r) && r.f.kind === 'stream') trace(g, r.f.pts, tfm);
  g.stroke();

  // Railways: black line, with cross-ties on the active ones.
  g.strokeStyle = C.black;
  g.lineWidth = 1.3 * wf;
  g.beginPath();
  for (const r of data.boxed.rail) if (near(r) && r.f.state === 'active') trace(g, r.f.pts, tfm);
  g.stroke();
  g.lineWidth = 3.6 * wf;
  g.lineCap = 'butt';
  g.setLineDash([1 * wf, 6 * wf]);
  g.stroke();
  g.lineWidth = 0.9 * wf;
  g.setLineDash([5 * wf, 3 * wf]);
  g.beginPath();
  for (const r of data.boxed.rail) if (near(r) && r.f.state !== 'active') trace(g, r.f.pts, tfm);
  g.stroke();
  g.setLineDash([]);
  g.lineCap = 'round';

  // Roads: tracks and paths dashed, then casings, then fills from minor up to A.
  const roads = data.boxed.roads.filter(near);
  const roadPath = (cls: string): void => {
    g.beginPath();
    for (const r of roads) if (r.f.cls === cls) trace(g, r.f.pts, tfm);
  };
  g.strokeStyle = C.black;
  g.lineWidth = 0.8 * wf;
  g.lineCap = 'butt';
  g.setLineDash([1.4 * wf, 2.6 * wf]);
  roadPath('path');
  g.stroke();
  g.lineWidth = 1 * wf;
  g.setLineDash([4.5 * wf, 3 * wf]);
  roadPath('track');
  g.stroke();
  g.setLineDash([]);
  g.lineCap = 'round';
  const classes = [
    { cls: 'minor', color: C.roadMinor, fill: 1.5, casing: 2.6 },
    { cls: 'B', color: C.roadB, fill: 2.2, casing: 3.3 },
    { cls: 'A', color: C.roadA, fill: 2.6, casing: 3.8 },
  ];
  g.strokeStyle = C.black;
  for (const c of classes) {
    g.lineWidth = c.casing * wf;
    roadPath(c.cls);
    g.stroke();
  }
  for (const c of classes) {
    g.strokeStyle = c.color;
    g.lineWidth = c.fill * wf;
    roadPath(c.cls);
    g.stroke();
  }

  // Buildings.
  g.fillStyle = C.building;
  g.strokeStyle = C.building;
  g.lineWidth = 0.5;
  g.beginPath();
  for (const b of data.boxed.buildings) if (near(b)) trace(g, b.f.ring, tfm);
  g.fill();
  g.stroke();

  // Blue 1 km grid.
  g.strokeStyle = C.grid;
  g.lineWidth = 0.8 * wf;
  g.globalAlpha = 0.8;
  g.beginPath();
  for (let k = 0; k <= TILES_PER_SIDE; k++) {
    const v = k * TILE_M;
    if (v >= bx0 && v <= bx1) {
      g.moveTo(...tfm(v, by0));
      g.lineTo(...tfm(v, by1));
    }
    if (v >= by0 && v <= by1) {
      g.moveTo(...tfm(bx0, v));
      g.lineTo(...tfm(bx1, v));
    }
  }
  g.stroke();
  g.globalAlpha = 1;
  return canvas;
}

// ---- overlay ---------------------------------------------------------------------------------

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = C.halo;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function drawGridNumbers(ctx: CanvasRenderingContext2D, view: MapView): void {
  const { width, height, data } = view;
  const tl = toPx(view, 0, data.sizeY);
  const br = toPx(view, data.sizeX, 0);
  ctx.font = `bold 12px ${SERIF}`;
  ctx.fillStyle = C.gridText;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const topY = clamp(tl.py + 11, 11, height - 11);
  const botY = clamp(br.py - 11, 11, height - 11);
  const leftX = clamp(tl.px + 14, 14, width - 14);
  const rightX = clamp(br.px - 14, 14, width - 14);
  for (let k = 0; k < TILES_PER_SIDE; k++) {
    const e = String(Math.floor((ORIGIN_E + k * TILE_M) / 1000) % 100).padStart(2, '0');
    const n = String(Math.floor((ORIGIN_N + k * TILE_M) / 1000) % 100).padStart(2, '0');
    const { px } = toPx(view, k * TILE_M, 0);
    if (px > 8 && px < width - 8) {
      haloText(ctx, e, px, topY);
      haloText(ctx, e, px, botY);
    }
    const { py } = toPx(view, 0, k * TILE_M);
    if (py > 8 && py < height - 8) {
      haloText(ctx, n, leftX, py);
      haloText(ctx, n, rightX, py);
    }
  }
}

function drawPlaceNames(ctx: CanvasRenderingContext2D, view: MapView): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.ink;
  for (const s of view.data.settlements) {
    const { px, py } = toPx(view, s.x, s.y);
    if (px < -200 || px > view.width + 200 || py < -30 || py > view.height + 30) continue;
    switch (s.kind) {
      case 'town':
        ctx.font = `bold 17px ${SERIF}`;
        haloText(ctx, s.name.toUpperCase(), px, py);
        break;
      case 'village':
        ctx.font = `bold 13px ${SERIF}`;
        haloText(ctx, s.name, px, py);
        break;
      case 'camp':
        ctx.font = `italic 11px ${SERIF}`;
        haloText(ctx, s.name, px, py);
        break;
      default:
        ctx.font = `italic 11px ${SERIF}`;
        haloText(ctx, s.name, px, py);
    }
  }
}

const BAR_STEPS_M = [20, 50, 100, 200, 500, 1000, 2000, 5000];

function drawScaleBar(ctx: CanvasRenderingContext2D, view: MapView): void {
  const step = BAR_STEPS_M.find((d) => d * view.scale >= 70) ?? (BAR_STEPS_M[BAR_STEPS_M.length - 1] as number);
  const len = step * view.scale;
  const x = 40;
  const y = view.height - 44;
  ctx.save();
  ctx.fillStyle = C.halo;
  ctx.fillRect(x - 8, y - 20, len + 56, 38);
  ctx.strokeStyle = C.black;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, len, 6);
  ctx.fillStyle = C.black;
  ctx.fillRect(x, y, len / 2, 7);
  ctx.font = `11px ${SERIF}`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText('0', x - 2, y - 2);
  ctx.textAlign = 'center';
  ctx.fillText(step >= 1000 ? `${step / 1000} km` : `${step} m`, x + len, y - 2);
  ctx.restore();
}

function drawFurniture(ctx: CanvasRenderingContext2D, view: MapView): void {
  ctx.save();
  ctx.fillStyle = C.halo;
  ctx.fillRect(34, 26, 268, 38);
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `bold 13px ${SERIF}`;
  ctx.fillText('SX  OKEHAMPTON & NORTH DARTMOOR', 40, 31);
  ctx.font = `italic 11px ${SERIF}`;
  ctx.fillText('1 km grid · contours 10 m · heights in metres', 40, 48);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = `11px ${SERIF}`;
  ctx.fillStyle = C.halo;
  ctx.fillText('M or Esc: close   wheel: zoom   drag: pan', view.width - 29, view.height - 29);
  ctx.fillStyle = C.ink;
  ctx.fillText('M or Esc: close   wheel: zoom   drag: pan', view.width - 30, view.height - 30);
  ctx.restore();
}

// ---- entry point -----------------------------------------------------------------------------

/** Draws the whole map screen: desk, cached tiles, marks layer, then grid numbers, names and scale bar. */
export function renderMap(ctx: CanvasRenderingContext2D, view: MapView): void {
  const { data, scale } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.desk;
  ctx.fillRect(0, 0, view.width, view.height);

  let level = LEVEL_SCALES.findIndex((s) => s >= scale);
  if (level < 0) level = LEVEL_SCALES.length - 1;
  const cache = cacheFor(data);
  const tilePx = Math.round(TILE_M * (LEVEL_SCALES[level] as number));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const a = toLocal(view, 0, 0);
  const b = toLocal(view, view.width, view.height);
  const i0 = clamp(Math.floor(a.x / TILE_M), 0, TILES_PER_SIDE - 1);
  const i1 = clamp(Math.floor(b.x / TILE_M), 0, TILES_PER_SIDE - 1);
  const j0 = clamp(Math.floor(b.y / TILE_M), 0, TILES_PER_SIDE - 1);
  const j1 = clamp(Math.floor(a.y / TILE_M), 0, TILES_PER_SIDE - 1);
  const inPatch = b.x >= 0 && a.x <= data.sizeX && a.y >= 0 && b.y <= data.sizeY;
  if (inPatch) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const tile = cache.get(data, level, i, j);
        // Whole-pixel destination edges so neighbouring tiles abut without hairline seams.
        const l = Math.round(toPx(view, i * TILE_M, 0).px);
        const r = Math.round(toPx(view, (i + 1) * TILE_M, 0).px);
        const t = Math.round(toPx(view, 0, (j + 1) * TILE_M).py);
        const bt = Math.round(toPx(view, 0, j * TILE_M).py);
        ctx.drawImage(tile, PAD, PAD, tilePx, tilePx, l, t, r - l, bt - t);
      }
    }
  }

  const tl = toPx(view, 0, data.sizeY);
  const br = toPx(view, data.sizeX, 0);
  ctx.strokeStyle = C.black;
  ctx.lineWidth = 2;
  ctx.strokeRect(tl.px, tl.py, br.px - tl.px, br.py - tl.py);

  if (view.marks) {
    ctx.save();
    view.marks(ctx, view);
    ctx.restore();
  }
  drawPlaceNames(ctx, view);
  drawGridNumbers(ctx, view);
  drawScaleBar(ctx, view);
  drawFurniture(ctx, view);
}
