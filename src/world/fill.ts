// Depression filling over the height posts: how deep each closed hollow holds water before it spills.
// Priority-flood, Barnes, Lehman and Mulla 2014. Pure: no three, no DOM.

/** Hollow depth (m) a post must exceed to count as lake. */
export const MIN_LAKE_DEPTH_M = 0.5;

/** Eight neighbours: water escapes diagonally too. */
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/** Binary min-heap of post indices keyed by level. */
class MinHeap {
  private readonly keys: Float64Array;
  private readonly vals: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(key: number, val: number): void {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) <= key) break;
      this.keys[i] = this.keys[p] as number;
      this.vals[i] = this.vals[p] as number;
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  /** Removes the lowest entry and returns its value; its key is left in `topKey`. */
  topKey = 0;
  pop(): number {
    const val = this.vals[0] as number;
    this.topKey = this.keys[0] as number;
    const n = --this.size;
    if (n > 0) {
      const key = this.keys[n] as number;
      const v = this.vals[n] as number;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (this.keys[c + 1] as number) < (this.keys[c] as number)) c++;
        if ((this.keys[c] as number) >= key) break;
        this.keys[i] = this.keys[c] as number;
        this.vals[i] = this.vals[c] as number;
        i = c;
      }
      this.keys[i] = key;
      this.vals[i] = v;
    }
    return val;
  }
}

/**
 * Filled level of every post of a w x h grid (row-major, metres). The grid edge is the outlet: every edge
 * post is seeded at its own height. A post's filled level is the lowest level water must reach at that post
 * to flow off the edge; filled - ground is the depth the post holds. Never below the ground.
 */
export function priorityFlood(heights: ArrayLike<number>, w: number, h: number): Float64Array {
  const n = w * h;
  if (heights.length !== n) throw new Error(`priorityFlood: expected ${n} heights, got ${heights.length}`);
  const filled = new Float64Array(n);
  const seen = new Uint8Array(n);
  const heap = new MinHeap(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x !== 0 && y !== 0 && x !== w - 1 && y !== h - 1) continue;
      const k = y * w + x;
      filled[k] = heights[k] as number;
      seen[k] = 1;
      heap.push(filled[k] as number, k);
    }
  }
  while (heap.size > 0) {
    const k = heap.pop();
    const level = heap.topKey;
    const x = k % w;
    const y = (k - x) / w;
    for (let d = 0; d < 8; d++) {
      const nx = x + (DX[d] as number);
      const ny = y + (DY[d] as number);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const m = ny * w + nx;
      if (seen[m]) continue;
      seen[m] = 1;
      const g = heights[m] as number;
      const f = g > level ? g : level;
      filled[m] = f;
      heap.push(f, m);
    }
  }
  return filled;
}

export interface FillLake {
  /** 1-based; 0 is "no lake" in the id grid. */
  id: number;
  /** Level the water stands at when full, metres: the spill level of the hollow. */
  spill: number;
  /** Surface area at spill level, m^2 (posts deeper than MIN_LAKE_DEPTH_M, one post = cellM^2). */
  area: number;
  /** Water volume at spill level, m^3. */
  volume: number;
  maxDepth: number;
  /** Lowest ground under the lake, metres. */
  floor: number;
  /** Centroid of its posts, local metres. */
  x: number;
  y: number;
  /** Sea water if true (spill at or below the local mark); fresh bog, pond or reservoir if false. */
  salt: boolean;
}

export interface LabelOptions {
  cellM: number;
  /** High-water mark at local (x, y). Without it no hollow is salt. */
  markAt?: (x: number, y: number) => number;
  /** Forces a hollow fresh whatever its level (e.g. Meldon Reservoir). `posts` are its post indices. */
  isFresh?: (lake: FillLake, posts: readonly number[]) => boolean;
}

export interface Labelled {
  lakes: FillLake[];
  /** Lake id per post, row-major; 0 = none. */
  ids: Uint16Array;
}

/**
 * Groups posts holding more than MIN_LAKE_DEPTH_M of water into lakes: eight-connected posts sharing one
 * filled level. Lakes are numbered from 1 in row-major order of their first post.
 */
export function labelLakes(
  heights: ArrayLike<number>,
  filled: ArrayLike<number>,
  w: number,
  h: number,
  opts: LabelOptions,
): Labelled {
  const n = w * h;
  const ids = new Uint16Array(n);
  const lakes: FillLake[] = [];
  const wet = (k: number): boolean => (filled[k] as number) - (heights[k] as number) > MIN_LAKE_DEPTH_M;
  const cell2 = opts.cellM * opts.cellM;
  for (let start = 0; start < n; start++) {
    if (ids[start] !== 0 || !wet(start)) continue;
    if (lakes.length >= 0xffff) throw new Error('labelLakes: more than 65535 lakes');
    const id = lakes.length + 1;
    const level = filled[start] as number;
    const posts: number[] = [];
    const stack = [start];
    ids[start] = id;
    let volume = 0;
    let maxDepth = 0;
    let floor = Infinity;
    let sx = 0;
    let sy = 0;
    while (stack.length > 0) {
      const k = stack.pop() as number;
      posts.push(k);
      const x = k % w;
      const y = (k - x) / w;
      const g = heights[k] as number;
      const depth = level - g;
      volume += depth * cell2;
      if (depth > maxDepth) maxDepth = depth;
      if (g < floor) floor = g;
      sx += x;
      sy += y;
      for (let d = 0; d < 8; d++) {
        const nx = x + (DX[d] as number);
        const ny = y + (DY[d] as number);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const m = ny * w + nx;
        if (ids[m] !== 0 || !wet(m) || filled[m] !== level) continue;
        ids[m] = id;
        stack.push(m);
      }
    }
    const lake: FillLake = {
      id,
      spill: level,
      area: posts.length * cell2,
      volume,
      maxDepth,
      floor,
      x: (sx / posts.length) * opts.cellM,
      y: (sy / posts.length) * opts.cellM,
      salt: false,
    };
    lake.salt = opts.markAt !== undefined && level <= opts.markAt(lake.x, lake.y);
    if (opts.isFresh?.(lake, posts)) lake.salt = false;
    lakes.push(lake);
  }
  return { lakes, ids };
}
