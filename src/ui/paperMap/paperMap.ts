// The full-screen paper map: a DOM overlay holding one canvas, with wheel zoom, drag pan and M / Esc to close.
// Local frame as in world/terrain.ts: x metres east, y metres north from the patch's SW corner.
import { MAX_MAP_SCALE, MIN_MAP_SCALE, renderMap, toLocal, type MapView, type MarksLayer } from './renderMap';
import type { MapData } from './mapData';
import type { Marks } from './marks';
import type { LegLabel } from './drawMarks';
import { createMarksTools } from './marksTools';

export interface PaperMapOptions {
  /** Local metres at the centre of the screen when first opened. Defaults to the middle of the patch. */
  centre?: { x: number; y: number };
  /** Pixels per metre when first opened. Defaults to fitting the whole patch. */
  scale?: number;
  parent?: HTMLElement;
  /** The player's pencil marks. With these, the map shows the tool palette. */
  marks?: Marks;
  /** Text beside each planned leg (distance, climb, plan time); called on every draw. */
  legLabel?: LegLabel;
  onChange?: (open: boolean) => void;
}

export interface PaperMap {
  readonly visible: boolean;
  setVisible(v: boolean): void;
  toggle(): void;
  redraw(): void;
  /** The slot the pencil task fills: drawn over the map in world space, under the scale bar and names. */
  setMarksLayer(layer: MarksLayer | undefined): void;
}

export function createPaperMap(data: MapData, opts: PaperMapOptions = {}): PaperMap {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:60;background:#4a4333;display:none';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;touch-action:none';
  root.appendChild(canvas);
  (opts.parent ?? document.body).appendChild(root);

  let visible = false;
  let marks: MarksLayer | undefined;
  let cx = opts.centre?.x ?? data.sizeX / 2;
  let cy = opts.centre?.y ?? data.sizeY / 2;
  let scale = opts.scale ?? 0;
  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  const view = (): MapView => ({ width: canvas.width, height: canvas.height, cx, cy, scale, data, marks });

  const tools = opts.marks
    ? createMarksTools({ parent: root, canvas, marks: opts.marks, legLabel: opts.legLabel, view, redraw: () => redraw() })
    : undefined;
  if (tools) marks = tools.layer;

  function redraw(): void {
    if (!visible) return;
    const w = Math.max(1, Math.floor(root.clientWidth));
    const h = Math.max(1, Math.floor(root.clientHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (scale === 0) scale = clamp((Math.min(w, h) / data.sizeX) * 0.95, MIN_MAP_SCALE, MAX_MAP_SCALE);
    cx = clamp(cx, 0, data.sizeX);
    cy = clamp(cy, 0, data.sizeY);
    renderMap(canvas.getContext('2d') as CanvasRenderingContext2D, view());
  }

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const before = toLocal(view(), px, py);
      scale = clamp(scale * Math.exp(-ev.deltaY * 0.0015), MIN_MAP_SCALE, MAX_MAP_SCALE);
      // Keep the point under the cursor fixed.
      cx = before.x - (px - canvas.width / 2) / scale;
      cy = before.y + (py - canvas.height / 2) / scale;
      redraw();
    },
    { passive: false },
  );

  let drag: { px: number; py: number } | undefined;
  let penDown = false;
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 0 && tools) {
      const rect = canvas.getBoundingClientRect();
      if (tools.pointerDown(ev.clientX - rect.left, ev.clientY - rect.top)) {
        penDown = true;
        return;
      }
    }
    drag = { px: ev.clientX, py: ev.clientY };
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', (ev) => {
    if (penDown) {
      const rect = canvas.getBoundingClientRect();
      penDown = false;
      tools?.pointerUp(ev.clientX - rect.left, ev.clientY - rect.top);
    }
    drag = undefined;
    canvas.style.cursor = 'grab';
  });
  window.addEventListener('mousemove', (ev) => {
    if (penDown) {
      const rect = canvas.getBoundingClientRect();
      tools?.pointerMove(ev.clientX - rect.left, ev.clientY - rect.top);
      return;
    }
    if (!drag) return;
    cx -= (ev.clientX - drag.px) / scale;
    cy += (ev.clientY - drag.py) / scale;
    drag = { px: ev.clientX, py: ev.clientY };
    redraw();
  });
  window.addEventListener('resize', redraw);

  const self: PaperMap = {
    get visible() {
      return visible;
    },
    setVisible(v) {
      if (v === visible) return;
      if (!v) tools?.cancel();
      visible = v;
      root.style.display = v ? 'block' : 'none';
      if (v) {
        // Release the mouse look so the pointer can drag the map.
        if (document.pointerLockElement) document.exitPointerLock();
        redraw();
      }
      opts.onChange?.(v);
    },
    toggle() {
      self.setVisible(!visible);
    },
    redraw,
    setMarksLayer(layer) {
      marks = layer;
      redraw();
    },
  };

  window.addEventListener('keydown', (ev) => {
    if (ev.repeat || tools?.typing) return;
    if (ev.code === 'KeyM') self.toggle();
    else if (ev.code === 'Escape' && visible) self.setVisible(false);
  });
  return self;
}
