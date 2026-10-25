// Times the player's real walks along planned legs, from the walk log. Pure: fed samples and the current legs.
// A leg is walked when the player leaves within START_END_RADIUS_M of its start and later arrives within that of its
// end, with at least CORRIDOR_SHARE of the samples in between within CORRIDOR_M of the line. Detours count toward the
// real time; that gap between plan and real is what the player learns from.
import type { LegPoint } from './naismith';
import type { WalkLogEntry } from './walkLog';

export const START_END_RADIUS_M = 100;
export const CORRIDOR_M = 300;
export const CORRIDOR_SHARE = 0.7;
/** Straying this far from the line cancels the attempt at once. */
export const ABANDON_M = CORRIDOR_M * 2;
/** Oldest completions are dropped past this many. */
export const MAX_HISTORY = 200;

/** Anything with an id and waypoints: a map `Leg` fits. */
export interface TrackedLeg {
  id: number;
  pts: readonly LegPoint[];
}

export interface LegCompletion {
  legId: number;
  /** Game minutes when the player left the start. */
  startMinutes: number;
  /** Game minutes when the player reached the end. */
  endMinutes: number;
  /** endMinutes - startMinutes. */
  realMinutes: number;
}

interface Attempt {
  startMinutes: number;
  samples: number;
  near: number;
  /** Has been clear of the end zone (so a leg that ends where it starts is not done at once). */
  leftEnd: boolean;
}

export interface LegTrackerData {
  /** Last completion per leg, shown beside the plan. */
  last: LegCompletion[];
  history: LegCompletion[];
  /** Minutes the player was last seen in a leg's start zone, for legs not yet under way. */
  armed: Array<{ legId: number; minutes: number }>;
  attempts: Array<{ legId: number } & Attempt>;
}

function distToPolyline(x: number, y: number, pts: readonly LegPoint[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return best;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseCompletion(raw: unknown): LegCompletion | undefined {
  const c = raw as Partial<LegCompletion> | null;
  if (!c || !isNum(c.legId) || !isNum(c.startMinutes) || !isNum(c.endMinutes) || !isNum(c.realMinutes)) return undefined;
  return { legId: c.legId, startMinutes: c.startMinutes, endMinutes: c.endMinutes, realMinutes: c.realMinutes };
}

export class LegTracker {
  private last = new Map<number, LegCompletion>();
  private historyList: LegCompletion[] = [];
  /** Leg id -> minutes last seen in its start zone, while no attempt is under way. */
  private armed = new Map<number, number>();
  private attempts = new Map<number, Attempt>();
  /** How many walk-log entries have been consumed. */
  private cursor = 0;
  private readonly listeners = new Set<() => void>();

  /** Called whenever a leg is completed or loaded. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The last completed real time for the leg, in game minutes. */
  realMinutes(legId: number): number | undefined {
    return this.last.get(legId)?.realMinutes;
  }

  /** Every completion, oldest first. */
  get history(): readonly LegCompletion[] {
    return this.historyList;
  }

  /** Whether an attempt is under way on the leg. */
  isActive(legId: number): boolean {
    return this.attempts.has(legId);
  }

  /** Consumes walk-log entries not yet seen. Returns the completions this call produced. */
  update(entries: readonly WalkLogEntry[], legs: readonly TrackedLeg[]): LegCompletion[] {
    if (entries.length < this.cursor) this.cursor = 0;
    const done: LegCompletion[] = [];
    const ids = new Set(legs.map((l) => l.id));
    for (const id of [...this.attempts.keys()]) if (!ids.has(id)) this.attempts.delete(id);
    for (const id of [...this.armed.keys()]) if (!ids.has(id)) this.armed.delete(id);
    for (; this.cursor < entries.length; this.cursor++) {
      const e = entries[this.cursor]!;
      for (const leg of legs) {
        const c = this.step(leg, e);
        if (c) done.push(c);
      }
    }
    if (done.length > 0) this.emit();
    return done;
  }

  private step(leg: TrackedLeg, e: WalkLogEntry): LegCompletion | undefined {
    const pts = leg.pts;
    if (pts.length < 2) return undefined;
    const start = pts[0]!;
    const end = pts[pts.length - 1]!;
    const inStart = Math.hypot(e.x - start.x, e.y - start.y) <= START_END_RADIUS_M;
    const inEnd = Math.hypot(e.x - end.x, e.y - end.y) <= START_END_RADIUS_M;
    const attempt = this.attempts.get(leg.id);

    if (attempt) {
      attempt.samples++;
      const d = distToPolyline(e.x, e.y, pts);
      if (d <= CORRIDOR_M) attempt.near++;
      if (!inEnd) attempt.leftEnd = true;
      if (d > ABANDON_M) {
        this.attempts.delete(leg.id);
        return undefined;
      }
      if (inEnd && attempt.leftEnd) {
        this.attempts.delete(leg.id);
        if (attempt.near / attempt.samples < CORRIDOR_SHARE) return undefined;
        const c: LegCompletion = {
          legId: leg.id,
          startMinutes: attempt.startMinutes,
          endMinutes: e.minutes,
          realMinutes: e.minutes - attempt.startMinutes,
        };
        this.last.set(leg.id, c);
        this.historyList.push(c);
        if (this.historyList.length > MAX_HISTORY) this.historyList.shift();
        if (inStart) this.armed.set(leg.id, e.minutes);
        return c;
      }
      if (inStart) {
        // Back at the start: a fresh attempt, not a continuation.
        this.attempts.delete(leg.id);
        this.armed.set(leg.id, e.minutes);
      }
      return undefined;
    }

    if (inStart) {
      this.armed.set(leg.id, e.minutes);
      return undefined;
    }
    const since = this.armed.get(leg.id);
    if (since !== undefined) {
      this.armed.delete(leg.id);
      if (Math.hypot(e.x - start.x, e.y - start.y) > ABANDON_M) return undefined;
      this.attempts.set(leg.id, {
        startMinutes: since,
        samples: 1,
        near: distToPolyline(e.x, e.y, pts) <= CORRIDOR_M ? 1 : 0,
        leftEnd: !inEnd,
      });
    }
    return undefined;
  }

  serialize(): LegTrackerData {
    return {
      last: [...this.last.values()].map((c) => ({ ...c })),
      history: this.historyList.map((c) => ({ ...c })),
      armed: [...this.armed].map(([legId, minutes]) => ({ legId, minutes })),
      attempts: [...this.attempts].map(([legId, a]) => ({ legId, ...a })),
    };
  }

  /** Replaces everything with saved data, ignoring entries that do not parse. The walk log restarts empty. */
  load(data: unknown): void {
    const d = (data ?? {}) as Partial<LegTrackerData>;
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    this.last = new Map();
    for (const raw of list(d.last)) {
      const c = parseCompletion(raw);
      if (c) this.last.set(c.legId, c);
    }
    this.historyList = list(d.history).map(parseCompletion).filter((c): c is LegCompletion => c !== undefined);
    this.armed = new Map();
    for (const raw of list(d.armed)) {
      const a = raw as { legId?: unknown; minutes?: unknown } | null;
      if (a && isNum(a.legId) && isNum(a.minutes)) this.armed.set(a.legId, a.minutes);
    }
    this.attempts = new Map();
    for (const raw of list(d.attempts)) {
      const a = raw as Partial<Attempt> & { legId?: unknown } | null;
      if (a && isNum(a.legId) && isNum(a.startMinutes) && isNum(a.samples) && isNum(a.near) && typeof a.leftEnd === 'boolean') {
        this.attempts.set(a.legId, { startMinutes: a.startMinutes, samples: a.samples, near: a.near, leftEnd: a.leftEnd });
      }
    }
    this.cursor = 0;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
