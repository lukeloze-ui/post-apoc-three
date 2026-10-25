// The walk log: where the player was and when, for timing legs of the journey later.

export interface WalkLogEntry {
  /** Game minutes since Day 0 00:00. */
  minutes: number;
  x: number;
  y: number;
}

/** A new entry after this far, or after this much game time if the player has moved at all. */
export const WALK_LOG_DIST_M = 10;
export const WALK_LOG_SEC = 10;

export class WalkLog {
  readonly entries: WalkLogEntry[] = [];

  /** Offer the current time and position; returns true if it was logged. Standing still adds nothing. */
  record(minutes: number, x: number, y: number): boolean {
    const last = this.entries[this.entries.length - 1];
    if (last) {
      const dist = Math.hypot(x - last.x, y - last.y);
      const sec = (minutes - last.minutes) * 60;
      if (!(dist >= WALK_LOG_DIST_M || (sec >= WALK_LOG_SEC && dist > 0))) return false;
    }
    this.entries.push({ minutes, x, y });
    return true;
  }

  /** Game minutes taken to cover the entries from index a to b. */
  elapsedMin(a: number, b: number): number {
    const ea = this.entries[a];
    const eb = this.entries[b];
    return ea && eb ? eb.minutes - ea.minutes : 0;
  }
}
