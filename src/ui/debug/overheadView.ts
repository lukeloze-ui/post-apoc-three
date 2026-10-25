// Developer overhead view: full-screen Canvas2D map of the whole patch with a registry of toggleable layers.
// Local frame as in world/terrain.ts: x metres east, y metres north from the patch's SW corner.
import { localToOsgb } from '../../world/geo';
import { BAND_INFO, bandAt, hwAt, type BandCode, type Flood } from '../../world/flood';
import { bandWithLakes, type Lakes } from '../../world/lakes';
import { TILES_PER_SIDE, TILE_M, heightAt, type Terrain } from '../../world/terrain';

/** Game day used for lake levels until the clock exists. */
export const DEFAULT_GAME_DAY = 2;

export interface DebugData {
  terrain: Terrain;
  flood: Flood;
  lakes: Lakes;
  gameDay: number;
}

export interface PlayerPose {
  x: number;
  y: number;
  /** Degrees, 0 = north, clockwise. */
  yaw: number;
}

/** What a layer draws against: local metres map to pixels through toPx. */
export interface DebugViewport {
  width: number;
  height: number;
  /** Pixels per metre. */
  scale: number;
  toPx(x: number, y: number): { px: number; py: number };
  toLocal(px: number, py: number): { x: number; y: number };
  data: DebugData;
  player(): PlayerPose;
}

export interface DebugLayer {
  id: string;
  label: string;
  defaultOn: boolean;
  draw(ctx: CanvasRenderingContext2D, view: DebugViewport): void;
  /** Text for the record under the cursor at local (x, y), if any. The topmost layer with an answer wins. */
  hover?(view: DebugViewport, x: number, y: number): string | undefined;
}

const layers: DebugLayer[] = [];

/** Adds (or replaces, by id) a layer. Layers draw in registration order. */
export function registerDebugLayer(layer: DebugLayer): void {
  const at = layers.findIndex((l) => l.id === layer.id);
  if (at >= 0) layers[at] = layer;
  else layers.push(layer);
}

export function debugLayers(): readonly DebugLayer[] {
  return layers;
}

/** OS grid reference with 100 m precision, e.g. "SX 580 901". */
export function gridRef(e: number, n: number): string {
  const e100k = Math.floor(e / 100000);
  const n100k = Math.floor(n / 100000);
  const l1 = 19 - n100k - ((19 - n100k) % 5) + Math.floor((e100k + 10) / 5);
  const l2 = (((19 - n100k) * 5) % 25) + (e100k % 5);
  const letter = (k: number): string => String.fromCharCode(65 + (k > 7 ? k + 1 : k));
  const d = (v: number): string => String(Math.floor((v % 100000) / 100)).padStart(3, '0');
  return `${letter(l1)}${letter(l2)} ${d(e)} ${d(n)}`;
}

// ---- base layers -----------------------------------------------------------------------------

type Rgba = [number, number, number, number];

/** Image with one pixel per terrain cell, north at the top. */
function cellCanvas(nx: number, ny: number, shade: (cx: number, cy: number) => Rgba): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = nx;
  c.height = ny;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const img = g.createImageData(nx, ny);
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      const [r, gr, b, a] = shade(cx, cy);
      const o = ((ny - 1 - cy) * nx + cx) * 4;
      img.data[o] = r;
      img.data[o + 1] = gr;
      img.data[o + 2] = b;
      img.data[o + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function drawCells(ctx: CanvasRenderingContext2D, view: DebugViewport, img: HTMLCanvasElement, smooth: boolean): void {
  const { sizeX, sizeY } = view.data.terrain;
  const a = view.toPx(0, sizeY);
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(img, a.px, a.py, sizeX * view.scale, sizeY * view.scale);
}

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

let hillshadeCache: { terrain: Terrain; img: HTMLCanvasElement } | undefined;

const hillshadeLayer: DebugLayer = {
  id: 'hillshade',
  label: 'Hillshade + height tint',
  defaultOn: true,
  draw(ctx, view) {
    const t = view.data.terrain;
    if (hillshadeCache?.terrain !== t) {
      const { cellM, postsX, postsY } = t.meta;
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of t.heightsDm) {
        lo = Math.min(lo, h / 10);
        hi = Math.max(hi, h / 10);
      }
      // Light from the north-west.
      const lx = -0.6;
      const ly = 0.6;
      const img = cellCanvas(postsX - 1, postsY - 1, (cx, cy): Rgba => {
        const x = (cx + 0.5) * cellM;
        const y = (cy + 0.5) * cellM;
        const dzdx = (heightAt(t, x + cellM, y) - heightAt(t, x - cellM, y)) / (2 * cellM);
        const dzdy = (heightAt(t, x, y + cellM) - heightAt(t, x, y - cellM)) / (2 * cellM);
        const shade = Math.min(1.4, Math.max(0.5, 1 - 2.5 * (dzdx * lx + dzdy * ly)));
        const f = (heightAt(t, x, y) - lo) / (hi - lo || 1);
        return [
          Math.min(255, (70 + 150 * f) * shade),
          Math.min(255, (95 + 95 * f) * shade),
          Math.min(255, (70 + 70 * f) * shade),
          255,
        ];
      });
      hillshadeCache = { terrain: t, img };
    }
    drawCells(ctx, view, hillshadeCache.img, true);
  },
};

let bandCache: { data: DebugData; day: number; img: HTMLCanvasElement } | undefined;

const floodBandsLayer: DebugLayer = {
  id: 'bands',
  label: 'Flood bands (with lakes)',
  defaultOn: true,
  draw(ctx, view) {
    const d = view.data;
    if (bandCache?.data !== d || bandCache.day !== d.gameDay) {
      const { cellM, postsX, postsY } = d.terrain.meta;
      const nx = postsX - 1;
      const rgb = BAND_INFO.map((b) => hexRgb(b.color));
      const img = cellCanvas(nx, postsY - 1, (cx, cy): Rgba => {
        const x = (cx + 0.5) * cellM;
        const y = (cy + 0.5) * cellM;
        const base = d.flood.bands[cy * nx + cx] as BandCode;
        const band = bandWithLakes(d.lakes, d.terrain, base, x, y, d.gameDay);
        const [r, g, b] = rgb[band] as [number, number, number];
        return [r, g, b, 150];
      });
      bandCache = { data: d, day: d.gameDay, img };
    }
    drawCells(ctx, view, bandCache.img, false);
  },
};

const gridLayer: DebugLayer = {
  id: 'grid',
  label: '1 km grid, tile id + hw',
  defaultOn: true,
  draw(ctx, view) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const side = TILES_PER_SIDE * TILE_M;
    for (let k = 0; k <= TILES_PER_SIDE; k++) {
      const a = view.toPx(k * TILE_M, 0);
      const b = view.toPx(k * TILE_M, side);
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      const c = view.toPx(0, k * TILE_M);
      const d = view.toPx(side, k * TILE_M);
      ctx.moveTo(c.px, c.py);
      ctx.lineTo(d.px, d.py);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 3;
    ctx.font = '12px monospace';
    ctx.textBaseline = 'top';
    for (const t of view.data.flood.meta.tiles) {
      const p = view.toPx(t.i * TILE_M, (t.j + 1) * TILE_M);
      const hw = `${t.hw.toFixed(0)} m`;
      for (const [k, text] of [t.id, hw].entries()) {
        ctx.strokeText(text, p.px + 4, p.py + 3 + k * 14);
        ctx.fillText(text, p.px + 4, p.py + 3 + k * 14);
      }
    }
    ctx.restore();
  },
};

const playerLayer: DebugLayer = {
  id: 'player',
  label: 'Player',
  defaultOn: true,
  draw(ctx, view) {
    const p = view.player();
    const { px, py } = view.toPx(p.x, p.y);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate((p.yaw * Math.PI) / 180);
    ctx.fillStyle = '#ff2d2d';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
};

registerDebugLayer(hillshadeLayer);
registerDebugLayer(floodBandsLayer);
registerDebugLayer(gridLayer);
registerDebugLayer(playerLayer);

// ---- the view --------------------------------------------------------------------------------

export interface OverheadView {
  readonly visible: boolean;
  setVisible(v: boolean): void;
  toggle(): void;
  redraw(): void;
  /** Centres the view on local (x, y), optionally at a zoom in pixels per metre. */
  lookAt(x: number, y: number, scale?: number): void;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;

export function createOverheadView(
  data: DebugData,
  player: () => PlayerPose,
  parent: HTMLElement = document.body,
): OverheadView {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:50;background:#111;display:none;font:12px monospace;color:#fff';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair';
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);padding:6px 10px;user-select:none';
  const readout = document.createElement('div');
  readout.style.cssText =
    'position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,0.7);padding:4px 8px;white-space:pre';
  root.append(canvas, panel, readout);
  parent.appendChild(root);

  const on = new Map<string, boolean>();
  let panelCount = -1;
  const buildPanel = (): void => {
    panelCount = layers.length;
    panel.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'Debug layers (F2)';
    panel.appendChild(title);
    for (const l of layers) {
      if (!on.has(l.id)) on.set(l.id, l.defaultOn);
      const label = document.createElement('label');
      label.style.display = 'block';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on.get(l.id) as boolean;
      cb.addEventListener('change', () => {
        on.set(l.id, cb.checked);
        redraw();
      });
      label.append(cb, ' ' + l.label);
      panel.appendChild(label);
    }
  };

  let scale = 0.1;
  let cx = (TILES_PER_SIDE * TILE_M) / 2;
  let cy = cx;
  let visible = false;
  let mouse: { px: number; py: number } | undefined;

  const viewport = (): DebugViewport => ({
    width: canvas.width,
    height: canvas.height,
    scale,
    data,
    player,
    toPx: (x, y) => ({ px: canvas.width / 2 + (x - cx) * scale, py: canvas.height / 2 - (y - cy) * scale }),
    toLocal: (px, py) => ({ x: cx + (px - canvas.width / 2) / scale, y: cy - (py - canvas.height / 2) / scale }),
  });

  const updateReadout = (): void => {
    if (!mouse) {
      readout.textContent = '';
      return;
    }
    const vp = viewport();
    const { x, y } = vp.toLocal(mouse.px, mouse.py);
    const { terrain, flood, lakes, gameDay } = data;
    if (x < 0 || y < 0 || x >= terrain.sizeX || y >= terrain.sizeY) {
      readout.textContent = `local ${x.toFixed(0)}, ${y.toFixed(0)} m (outside patch)`;
      return;
    }
    const o = localToOsgb(x, y);
    const base = bandAt(flood, terrain.meta.cellM, terrain.meta.postsX - 1, x, y);
    const band = bandWithLakes(lakes, terrain, base, x, y, gameDay);
    readout.textContent =
      `local ${x.toFixed(0)}, ${y.toFixed(0)} m   OSGB ${o.e.toFixed(0)}, ${o.n.toFixed(0)}   ${gridRef(o.e, o.n)}\n` +
      `height ${heightAt(terrain, x, y).toFixed(1)} m   mark ${hwAt(flood.hw, x, y).toFixed(1)} m   ` +
      `band ${band} ${BAND_INFO[band]?.name ?? '?'}   (day ${gameDay})`;
    for (let k = layers.length - 1; k >= 0; k--) {
      const l = layers[k] as DebugLayer;
      if (!l.hover || !(on.get(l.id) ?? l.defaultOn)) continue;
      const text = l.hover(vp, x, y);
      if (text) {
        readout.textContent += '\n' + text;
        break;
      }
    }
  };

  function redraw(): void {
    if (!visible) return;
    const w = Math.max(1, Math.floor(root.clientWidth));
    const h = Math.max(1, Math.floor(root.clientHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (panelCount !== layers.length) buildPanel();
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    const vp = viewport();
    for (const l of layers) if (on.get(l.id) ?? l.defaultOn) l.draw(ctx, vp);
    updateReadout();
  }

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const before = viewport().toLocal(px, py);
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * Math.exp(-ev.deltaY * 0.0015)));
      // Keep the point under the cursor fixed.
      cx = before.x - (px - canvas.width / 2) / scale;
      cy = before.y + (py - canvas.height / 2) / scale;
      redraw();
    },
    { passive: false },
  );

  let drag: { px: number; py: number } | undefined;
  canvas.addEventListener('mousedown', (ev) => {
    drag = { px: ev.clientX, py: ev.clientY };
  });
  window.addEventListener('mouseup', () => {
    drag = undefined;
  });
  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    mouse = { px: ev.clientX - rect.left, py: ev.clientY - rect.top };
    if (drag) {
      cx -= (ev.clientX - drag.px) / scale;
      cy += (ev.clientY - drag.py) / scale;
      drag = { px: ev.clientX, py: ev.clientY };
    }
    redraw();
  });
  window.addEventListener('resize', redraw);

  const self: OverheadView = {
    get visible() {
      return visible;
    },
    setVisible(v) {
      visible = v;
      root.style.display = v ? 'block' : 'none';
      if (v) {
        scale = (Math.min(root.clientWidth, root.clientHeight) / (TILES_PER_SIDE * TILE_M)) * 0.95;
        redraw();
      }
    },
    toggle() {
      self.setVisible(!visible);
    },
    redraw,
    lookAt(x, y, s) {
      cx = x;
      cy = y;
      if (s !== undefined) scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
      redraw();
    },
  };
  return self;
}
