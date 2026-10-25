// The map's tool palette and pointer handling: pencil, note, cross-out, eraser, plus a hand for panning and undo.
// DOM only; the marks themselves live in marks.ts and are drawn by drawMarks.ts.
import { NOTE_FONT, createMarksLayer, type LegLabel, type LegReal } from './drawMarks';
import type { Mark, Marks, Pt } from './marks';
import { toLocal, type MapView, type MarksLayer } from './renderMap';

export type Tool = 'hand' | 'pencil' | 'note' | 'cross' | 'leg' | 'eraser';

const TOOLS: Array<{ tool: Tool; label: string; title: string; cursor: string }> = [
  { tool: 'hand', label: 'Hand', title: 'Pan the map (drag)', cursor: 'grab' },
  { tool: 'pencil', label: 'Pencil', title: 'Draw (drag)', cursor: 'crosshair' },
  { tool: 'note', label: 'Note', title: 'Click to write a note', cursor: 'text' },
  { tool: 'cross', label: 'Cross out', title: 'Click for an X, drag to strike through', cursor: 'crosshair' },
  { tool: 'leg', label: 'Leg', title: 'Click waypoints, double-click to end a planned leg', cursor: 'crosshair' },
  { tool: 'eraser', label: 'Eraser', title: 'Rub out pencil and notes (drag)', cursor: 'cell' },
];

/** Pencil points closer than this many pixels are dropped, and simplification tolerance is this many pixels. */
const SIMPLIFY_PX = 1.5;
const ERASER_PX = 12;
const CROSS_HIT_PX = 14;
/** A cross-out drag shorter than this is a click. */
const CLICK_PX = 6;
/** Two leg clicks within this many ms and CLICK_PX of each other are a double-click. */
const DOUBLE_CLICK_MS = 400;

export interface MarksTools {
  readonly tool: Tool;
  /** The layer to hand to the map's marks slot. */
  readonly layer: MarksLayer;
  /** True when the tool took the press (so the map should not start panning). */
  pointerDown(px: number, py: number): boolean;
  pointerMove(px: number, py: number): void;
  pointerUp(px: number, py: number): void;
  /** True while the note text box is open, so map keys (M, Esc) must stay out of the way. */
  readonly typing: boolean;
  /** Cancels any half-made mark and closes the note box. */
  cancel(): void;
}

export interface MarksToolsOptions {
  parent: HTMLElement;
  canvas: HTMLCanvasElement;
  marks: Marks;
  view(): MapView;
  redraw(): void;
  /** Text beside each leg; called on every draw. */
  legLabel?: LegLabel;
  /** Real walked time beside the plan, per leg id; called on every draw. */
  legReal?: LegReal;
}

interface NoteBox {
  input: HTMLInputElement;
  at: Pt;
}

export function createMarksTools(o: MarksToolsOptions): MarksTools {
  const { marks, canvas } = o;
  let tool: Tool = 'hand';
  let stroke: Pt[] | undefined;
  let cross: { a: Pt; px: number; py: number; b: Pt } | undefined;
  let leg: Pt[] | undefined;
  let lastLegClick = { t: 0, px: 0, py: 0 };
  let erasing = false;
  let box: NoteBox | undefined;

  const preview = (): Mark | undefined => {
    if (leg) return { kind: 'leg', id: 0, pts: leg };
    if (stroke && stroke.length >= 2) return { kind: 'stroke', id: 0, pts: stroke };
    if (cross && Math.hypot(cross.b.x - cross.a.x, cross.b.y - cross.a.y) * o.view().scale > CLICK_PX) {
      return { kind: 'strike', id: 0, a: cross.a, b: cross.b };
    }
    return undefined;
  };
  const layer = createMarksLayer(marks, preview, o.legLabel, o.legReal);

  // ---- palette ----
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;top:12px;left:12px;display:flex;gap:4px;padding:6px;background:#e9e1c8ee;border:1px solid #4b4c52;' +
    'border-radius:3px;font:13px "Segoe Print","Bradley Hand",cursive;color:#2f3036;user-select:none';
  const buttons = new Map<Tool, HTMLButtonElement>();
  const btnCss =
    'padding:4px 8px;border:1px solid #4b4c52;border-radius:2px;background:#f4eed9;color:#2f3036;font:inherit;cursor:pointer';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.title = t.title;
    b.style.cssText = btnCss;
    b.addEventListener('click', () => setTool(t.tool));
    buttons.set(t.tool, b);
    bar.appendChild(b);
  }
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  undo.title = 'Undo the last action (Ctrl+Z)';
  undo.style.cssText = btnCss + ';margin-left:8px';
  undo.addEventListener('click', () => doUndo());
  bar.appendChild(undo);
  // Keep palette clicks and scrolls from reaching the map's pan and zoom.
  bar.addEventListener('mousedown', (ev) => ev.stopPropagation());
  bar.addEventListener('wheel', (ev) => ev.stopPropagation());
  o.parent.appendChild(bar);

  function syncUndo(): void {
    undo.disabled = !marks.canUndo;
    undo.style.opacity = marks.canUndo ? '1' : '0.45';
  }
  marks.subscribe(syncUndo);
  syncUndo();

  function finishLeg(): void {
    const pts = leg;
    leg = undefined;
    if (pts) marks.addLeg(pts);
    o.redraw();
  }

  function setTool(t: Tool): void {
    finishLeg();
    cancel();
    tool = t;
    for (const [k, b] of buttons) b.style.background = k === t ? '#c9c2ad' : '#f4eed9';
    canvas.style.cursor = TOOLS.find((x) => x.tool === t)?.cursor ?? 'grab';
  }
  setTool('hand');

  function doUndo(): void {
    cancel();
    if (marks.undo()) o.redraw();
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyZ' && (ev.ctrlKey || ev.metaKey) && o.parent.style.display !== 'none' && !box) {
      ev.preventDefault();
      doUndo();
    }
  });

  // ---- note box ----
  function openNote(at: Pt, px: number, py: number): void {
    closeBox(true);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Note…';
    input.style.cssText =
      `position:absolute;left:${px}px;top:${py - 20}px;min-width:140px;padding:2px 4px;border:1px dashed #4b4c52;` +
      `background:#f4eed9cc;color:#2f3036;font:${NOTE_FONT};outline:none`;
    // Typing must not walk, toggle the map or close it.
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') closeBox(true);
      else if (ev.key === 'Escape') closeBox(false);
    });
    input.addEventListener('keyup', (ev) => ev.stopPropagation());
    input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    input.addEventListener('blur', () => closeBox(true));
    box = { input, at };
    o.parent.appendChild(input);
    // Focus after the press that opened it has finished, or the canvas would take focus back.
    setTimeout(() => input.focus(), 0);
  }

  function closeBox(commit: boolean): void {
    const b = box;
    if (!b) return;
    box = undefined;
    const text = b.input.value;
    b.input.remove();
    if (commit && marks.addNote(b.at.x, b.at.y, text)) o.redraw();
  }

  function cancel(): void {
    if (stroke || cross || erasing || leg) {
      stroke = undefined;
      leg = undefined;
      cross = undefined;
      if (erasing) marks.endGesture();
      erasing = false;
      o.redraw();
    }
    closeBox(false);
  }

  const at = (px: number, py: number): Pt => toLocal(o.view(), px, py);

  function eraseAt(px: number, py: number): void {
    const p = at(px, py);
    if (marks.erase(p.x, p.y, ERASER_PX / o.view().scale)) o.redraw();
  }

  return {
    get tool() {
      return tool;
    },
    layer,
    get typing() {
      return box !== undefined;
    },
    cancel,
    pointerDown(px, py) {
      if (tool === 'hand') return false;
      closeBox(true);
      const p = at(px, py);
      if (tool === 'pencil') {
        stroke = [p];
      } else if (tool === 'note') {
        openNote(p, px, py);
      } else if (tool === 'leg') {
        const now = performance.now();
        const dbl = now - lastLegClick.t < DOUBLE_CLICK_MS && Math.hypot(px - lastLegClick.px, py - lastLegClick.py) <= CLICK_PX;
        lastLegClick = { t: now, px, py };
        if (dbl && leg) {
          finishLeg();
          lastLegClick.t = 0;
        } else {
          (leg ??= []).push(p);
          o.redraw();
        }
      } else if (tool === 'cross') {
        cross = { a: p, px, py, b: p };
      } else {
        erasing = true;
        marks.beginGesture();
        eraseAt(px, py);
      }
      return true;
    },
    pointerMove(px, py) {
      const p = at(px, py);
      if (stroke) {
        const last = stroke[stroke.length - 1]!;
        if (Math.hypot(p.x - last.x, p.y - last.y) * o.view().scale >= SIMPLIFY_PX) {
          stroke.push(p);
          o.redraw();
        }
      } else if (cross) {
        cross.b = p;
        o.redraw();
      } else if (erasing) {
        eraseAt(px, py);
      }
    },
    pointerUp(px, py) {
      const scale = o.view().scale;
      const p = at(px, py);
      if (stroke) {
        stroke.push(p);
        marks.addStroke(stroke, SIMPLIFY_PX / scale);
        stroke = undefined;
        o.redraw();
      } else if (cross) {
        if (Math.hypot(px - cross.px, py - cross.py) > CLICK_PX) {
          const mid = { x: (cross.a.x + p.x) / 2, y: (cross.a.y + p.y) / 2 };
          const target = marks.markNear(cross.a, CROSS_HIT_PX / scale) ?? marks.markNear(mid, CROSS_HIT_PX / scale);
          marks.addStrike(cross.a, p, target?.id);
        } else {
          marks.addCross(cross.a.x, cross.a.y);
        }
        cross = undefined;
        o.redraw();
      } else if (erasing) {
        erasing = false;
        marks.endGesture();
      }
    },
  };
}
