// Contour lines by marching squares over a regular height grid. Pure: no three, no DOM.
// Local frame as in terrain.ts: x metres east, y metres north, post (i, j) at (i * cellM, j * cellM).

export type ContourPt = readonly [number, number];

export interface ContourGrid {
  /** Heights in metres, row-major, row 0 = south, column 0 = west. */
  heights: ArrayLike<number>;
  nx: number;
  ny: number;
  cellM: number;
}

export interface ContourLine {
  level: number;
  /** Closed lines repeat the first point at the end. */
  closed: boolean;
  pts: ContourPt[];
}

export interface ContourOptions {
  /** Chaikin corner-cutting passes. Default 1. */
  smooth?: number;
}

/** Heights in decimetres (as stored in terrain.bin) to metres. */
export function gridFromDm(heightsDm: ArrayLike<number>, nx: number, ny: number, cellM: number): ContourGrid {
  const heights = new Float32Array(nx * ny);
  for (let k = 0; k < heights.length; k++) heights[k] = (heightsDm[k] as number) / 10;
  return { heights, nx, ny, cellM };
}

/** Levels at every `interval` metres across [lo, hi]. */
export function levelsBetween(lo: number, hi: number, interval: number): number[] {
  const out: number[] = [];
  for (let l = Math.ceil(lo / interval) * interval; l <= hi; l += interval) out.push(l);
  return out;
}

/** One chaikin pass: each segment is replaced by points at 1/4 and 3/4. Open lines keep their end points. */
function chaikin(pts: ContourPt[], closed: boolean): ContourPt[] {
  const n = closed ? pts.length - 1 : pts.length;
  if (n < 3 && !closed) return pts;
  const out: ContourPt[] = [];
  const last = closed ? n : n - 1;
  if (!closed) out.push(pts[0] as ContourPt);
  for (let k = 0; k < last; k++) {
    const a = pts[k] as ContourPt;
    const b = pts[(k + 1) % n] as ContourPt;
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
    out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  if (!closed) out.push(pts[n - 1] as ContourPt);
  else out.push(out[0] as ContourPt);
  return out;
}

/** Joined, lightly smoothed contour polylines for every requested level. */
export function contours(grid: ContourGrid, levels: readonly number[], opts: ContourOptions = {}): ContourLine[] {
  const passes = opts.smooth ?? 1;
  const out: ContourLine[] = [];
  for (const level of levels) out.push(...contourLevel(grid, level, passes));
  return out;
}

function contourLevel(grid: ContourGrid, level: number, passes: number): ContourLine[] {
  const { heights, nx, ny, cellM } = grid;
  // v > 0 is "above". Exact ties are nudged above so no vertex sits exactly on a level.
  const v = (i: number, j: number): number => {
    const d = (heights[j * nx + i] as number) - level;
    return d === 0 ? 1e-6 : d;
  };

  // An edge is a node: horizontal edge from post (i, j) to (i + 1, j) has id 2 * (j * nx + i);
  // vertical edge from (i, j) to (i, j + 1) has id 2 * (j * nx + i) + 1.
  const pos = new Map<number, ContourPt>();
  const adj = new Map<number, number[]>();
  const hEdge = (i: number, j: number): number => {
    const id = 2 * (j * nx + i);
    if (!pos.has(id)) {
      const a = v(i, j);
      const b = v(i + 1, j);
      pos.set(id, [(i + a / (a - b)) * cellM, j * cellM]);
    }
    return id;
  };
  const vEdge = (i: number, j: number): number => {
    const id = 2 * (j * nx + i) + 1;
    if (!pos.has(id)) {
      const a = v(i, j);
      const b = v(i, j + 1);
      pos.set(id, [i * cellM, (j + a / (a - b)) * cellM]);
    }
    return id;
  };
  const link = (a: number, b: number): void => {
    let la = adj.get(a);
    if (!la) adj.set(a, (la = []));
    la.push(b);
    let lb = adj.get(b);
    if (!lb) adj.set(b, (lb = []));
    lb.push(a);
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const sw = v(i, j);
      const se = v(i + 1, j);
      const ne = v(i + 1, j + 1);
      const nw = v(i, j + 1);
      const code = (sw > 0 ? 1 : 0) | (se > 0 ? 2 : 0) | (ne > 0 ? 4 : 0) | (nw > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const s = (): number => hEdge(i, j);
      const e = (): number => vEdge(i + 1, j);
      const n = (): number => hEdge(i, j + 1);
      const w = (): number => vEdge(i, j);
      switch (code) {
        case 1:
        case 14:
          link(w(), s());
          break;
        case 2:
        case 13:
          link(s(), e());
          break;
        case 3:
        case 12:
          link(w(), e());
          break;
        case 4:
        case 11:
          link(e(), n());
          break;
        case 6:
        case 9:
          link(s(), n());
          break;
        case 7:
        case 8:
          link(w(), n());
          break;
        default: {
          // Saddles (5: sw and ne above, 10: se and nw above): the centre value decides which pair joins.
          const centreAbove = sw + se + ne + nw > 0;
          if ((code === 5) === centreAbove) {
            link(w(), n());
            link(s(), e());
          } else {
            link(w(), s());
            link(e(), n());
          }
        }
      }
    }
  }

  const done = new Set<number>();
  const lines: ContourLine[] = [];
  const walk = (start: number): number[] => {
    const ids = [start];
    done.add(start);
    let cur = start;
    for (;;) {
      const next = (adj.get(cur) as number[]).find((k) => !done.has(k));
      if (next === undefined) break;
      done.add(next);
      ids.push(next);
      cur = next;
    }
    return ids;
  };
  const emit = (ids: number[], closed: boolean): void => {
    if (ids.length < 2) return;
    let pts = ids.map((id) => pos.get(id) as ContourPt);
    if (closed) pts.push(pts[0] as ContourPt);
    for (let p = 0; p < passes; p++) pts = chaikin(pts, closed);
    lines.push({ level, closed, pts });
  };
  // Open lines first (they run off the grid edge), then whatever is left is a closed ring.
  for (const [id, nb] of adj) if (nb.length === 1 && !done.has(id)) emit(walk(id), false);
  for (const id of adj.keys()) if (!done.has(id)) emit(walk(id), true);
  return lines;
}
