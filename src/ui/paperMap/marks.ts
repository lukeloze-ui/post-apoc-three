// The player's pencil marks on the paper map. Pure state: no DOM, no canvas. Coordinates are local metres
// (as in world/terrain.ts), so marks survive zoom. Marks belong to the player alone; the game never adds any.

export interface Pt {
  x: number;
  y: number;
}

/** A pencil stroke: a simplified polyline of at least two points. */
export interface Stroke {
  kind: 'stroke';
  id: number;
  pts: Pt[];
}

/** Text at a point. */
export interface Note {
  kind: 'note';
  id: number;
  x: number;
  y: number;
  text: string;
}

/** An X at a point, drawn over whatever is there. */
export interface Cross {
  kind: 'cross';
  id: number;
  x: number;
  y: number;
}

/** A line struck through something, from a to b. `target` is the mark it was struck through, if any. */
export interface Strike {
  kind: 'strike';
  id: number;
  a: Pt;
  b: Pt;
  target?: number;
}

/** A planned leg: waypoints the player clicked, drawn as a pencil line with ticks and a time label. */
export interface Leg {
  kind: 'leg';
  id: number;
  pts: Pt[];
}

export type Mark = Stroke | Note | Cross | Strike | Leg;

/** How many actions undo can go back. */
export const UNDO_LIMIT = 20;
/** Longest note, characters. */
export const MAX_NOTE_LENGTH = 200;

export interface MarksData {
  nextId: number;
  marks: Mark[];
}

/** Douglas-Peucker: drops points that lie within tol of the line between their kept neighbours. */
export function simplifyPolyline(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    let worst = -1;
    let worstD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(pts[i]!, pts[lo]!, pts[hi]!);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]).map((p) => ({ x: p.x, y: p.y }));
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The parts of segment a-b that lie outside the disc (c, r), as [t0, t1] parameter intervals. */
function outsideIntervals(a: Pt, b: Pt, c: Pt, r: number): Array<[number, number]> {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (A === 0) return C > 0 ? [[0, 1]] : [];
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [[0, 1]];
  const s = Math.sqrt(disc);
  const t0 = (-B - s) / (2 * A);
  const t1 = (-B + s) / (2 * A);
  if (t1 <= 0 || t0 >= 1) return [[0, 1]];
  const out: Array<[number, number]> = [];
  if (t0 > 0) out.push([0, t0]);
  if (t1 < 1) out.push([t1, 1]);
  return out;
}

/** Cuts the disc (c, r) out of a polyline. Returns the surviving pieces (each of at least two points). */
export function cutPolyline(pts: readonly Pt[], c: Pt, r: number): Pt[][] {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = (): void => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    for (const [t0, t1] of outsideIntervals(a, b, c, r)) {
      const p0 = t0 === 0 ? a : lerp(a, b, t0);
      const p1 = t1 === 1 ? b : lerp(a, b, t1);
      const last = cur[cur.length - 1];
      if (!last || Math.hypot(last.x - p0.x, last.y - p0.y) > 1e-9) {
        flush();
        cur.push({ x: p0.x, y: p0.y });
      }
      cur.push({ x: p1.x, y: p1.y });
      if (t1 < 1) flush();
    }
  }
  flush();
  return pieces;
}

export class Marks {
  private items: Mark[] = [];
  private nextId = 1;
  private history: Mark[][] = [];
  private gesture = false;
  private gestureSaved = false;
  private readonly listeners = new Set<() => void>();

  get all(): readonly Mark[] {
    return this.items;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /** Called after every change, including undo and load. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Everything between begin and end (a mouse drag, say) undoes as one action. */
  beginGesture(): void {
    this.gesture = true;
    this.gestureSaved = false;
  }

  endGesture(): void {
    this.gesture = false;
    this.gestureSaved = false;
  }

  addStroke(pts: readonly Pt[], tol = 0): Stroke | undefined {
    const simple = simplifyPolyline(pts, tol);
    if (simple.length < 2) return undefined;
    const m: Stroke = { kind: 'stroke', id: this.nextId, pts: simple };
    return this.add(m);
  }

  addLeg(pts: readonly Pt[]): Leg | undefined {
    if (pts.length < 2) return undefined;
    return this.add({ kind: 'leg', id: this.nextId, pts: pts.map((p) => ({ x: p.x, y: p.y })) });
  }

  addNote(x: number, y: number, text: string): Note | undefined {
    const t = text.trim().slice(0, MAX_NOTE_LENGTH);
    if (t === '') return undefined;
    return this.add({ kind: 'note', id: this.nextId, x, y, text: t });
  }

  addCross(x: number, y: number): Cross {
    return this.add({ kind: 'cross', id: this.nextId, x, y });
  }

  /** A line struck through the mark `target` (if given). Never removes the target. */
  addStrike(a: Pt, b: Pt, target?: number): Strike {
    const m: Strike = { kind: 'strike', id: this.nextId, a: { ...a }, b: { ...b } };
    if (target !== undefined) m.target = target;
    return this.add(m);
  }

  /** The nearest stroke, note or cross within r of the point, for striking through. */
  markNear(p: Pt, r: number): Mark | undefined {
    let best: Mark | undefined;
    let bestD = r;
    for (const m of this.items) {
      if (m.kind === 'strike') continue;
      let d: number;
      if (m.kind === 'stroke' || m.kind === 'leg') {
        d = Infinity;
        for (let i = 0; i + 1 < m.pts.length; i++) d = Math.min(d, distToSegment(p, m.pts[i]!, m.pts[i + 1]!));
      } else {
        d = Math.hypot(p.x - m.x, p.y - m.y);
      }
      if (d <= bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** Rubs out strokes and notes within r of (x, y); strokes are split where they are erased. Returns whether anything changed. */
  erase(x: number, y: number, r: number): boolean {
    const c = { x, y };
    const next: Mark[] = [];
    let nextId = this.nextId;
    let changed = false;
    for (const m of this.items) {
      if (m.kind === 'note') {
        if (Math.hypot(m.x - x, m.y - y) <= r) changed = true;
        else next.push(m);
      } else if (m.kind === 'stroke') {
        const pieces = cutPolyline(m.pts, c, r);
        const untouched = pieces.length === 1 && pieces[0]!.length === m.pts.length && samePts(pieces[0]!, m.pts);
        if (untouched) {
          next.push(m);
          continue;
        }
        changed = true;
        for (const pts of pieces) next.push({ kind: 'stroke', id: nextId++, pts });
      } else {
        next.push(m);
      }
    }
    if (!changed) return false;
    this.checkpoint();
    this.items = next;
    this.nextId = nextId;
    this.emit();
    return true;
  }

  /** Undoes the last action; returns whether there was one. Goes back UNDO_LIMIT actions. */
  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.items = prev;
    this.emit();
    return true;
  }

  serialize(): MarksData {
    return { nextId: this.nextId, marks: this.items.map(cloneMark) };
  }

  /** Replaces everything with saved data, ignoring entries that do not parse. Clears undo. */
  load(data: unknown): void {
    const d = (data ?? {}) as Partial<MarksData>;
    const marks = Array.isArray(d.marks) ? d.marks.map(parseMark).filter((m): m is Mark => m !== undefined) : [];
    this.items = marks;
    const top = marks.reduce((a, m) => Math.max(a, m.id), 0);
    this.nextId = Math.max(top + 1, typeof d.nextId === 'number' && Number.isFinite(d.nextId) ? d.nextId : 1);
    this.history = [];
    this.emit();
  }

  private add<T extends Mark>(m: T): T {
    this.checkpoint();
    this.items = [...this.items, m];
    this.nextId = m.id + 1;
    this.emit();
    return m;
  }

  private checkpoint(): void {
    if (this.gesture) {
      if (this.gestureSaved) return;
      this.gestureSaved = true;
    }
    this.history.push(this.items);
    if (this.history.length > UNDO_LIMIT) this.history.shift();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function samePts(a: readonly Pt[], b: readonly Pt[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);
}

function cloneMark(m: Mark): Mark {
  return JSON.parse(JSON.stringify(m)) as Mark;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown): v is Pt => !!v && isNum((v as Pt).x) && isNum((v as Pt).y);

function parseMark(raw: unknown): Mark | undefined {
  const m = raw as Record<string, unknown> | null;
  if (!m || !isNum(m.id)) return undefined;
  const id = m.id;
  switch (m.kind) {
    case 'stroke': {
      if (!Array.isArray(m.pts) || m.pts.length < 2 || !m.pts.every(isPt)) return undefined;
      return { kind: 'stroke', id, pts: m.pts.map((p: Pt) => ({ x: p.x, y: p.y })) };
    }
    case 'leg': {
      if (!Array.isArray(m.pts) || m.pts.length < 2 || !m.pts.every(isPt)) return undefined;
      return { kind: 'leg', id, pts: m.pts.map((p: Pt) => ({ x: p.x, y: p.y })) };
    }
    case 'note':
      if (!isNum(m.x) || !isNum(m.y) || typeof m.text !== 'string' || m.text === '') return undefined;
      return { kind: 'note', id, x: m.x, y: m.y, text: m.text.slice(0, MAX_NOTE_LENGTH) };
    case 'cross':
      if (!isNum(m.x) || !isNum(m.y)) return undefined;
      return { kind: 'cross', id, x: m.x, y: m.y };
    case 'strike': {
      if (!isPt(m.a) || !isPt(m.b)) return undefined;
      const s: Strike = { kind: 'strike', id, a: { x: m.a.x, y: m.a.y }, b: { x: m.b.x, y: m.b.y } };
      if (isNum(m.target)) s.target = m.target;
      return s;
    }
    default:
      return undefined;
  }
}
