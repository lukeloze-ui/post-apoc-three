// The game clock: game minutes since Day 0 00:00. Day 0 is 15 July 2026, local time BST (UTC+1).

/** Game seconds per real second. Tunable. */
export const TIME_SCALE = 4;

export const MINUTES_PER_DAY = 1440;
/** Day 0 starts at 18:00 (SX 01). */
export const START_MINUTES = 18 * 60;

/** Day 0 00:00 BST as a UTC instant: 2026-07-14T23:00Z. */
export const DAY0_UTC_MS = Date.UTC(2026, 6, 15, 0, 0, 0) - 3600_000;

/** The UTC instant (ms since the Unix epoch) at a game time in minutes since Day 0 00:00. */
export function gameMinutesToUtcMs(minutes: number): number {
  return DAY0_UTC_MS + minutes * 60_000;
}

export class GameClock {
  /** Game minutes since Day 0 00:00. */
  minutes: number;

  constructor(minutes: number = START_MINUTES) {
    this.minutes = minutes;
  }

  /** Whole day number; Day 0 is 15 July. */
  get day(): number {
    return Math.floor(this.minutes / MINUTES_PER_DAY);
  }

  /** Days since Day 0 00:00, fractional. */
  get gameDays(): number {
    return this.minutes / MINUTES_PER_DAY;
  }

  /** Minutes since local midnight, 0..1440. */
  get minuteOfDay(): number {
    return this.minutes - this.day * MINUTES_PER_DAY;
  }

  get hh(): number {
    return Math.floor(this.minuteOfDay / 60);
  }

  get mm(): number {
    return Math.floor(this.minuteOfDay % 60);
  }

  get utcMs(): number {
    return gameMinutesToUtcMs(this.minutes);
  }

  advance(gameSeconds: number): void {
    this.minutes += gameSeconds / 60;
  }

  /** "d1-07:00". */
  format(): string {
    return formatGameTime(this.minutes);
  }
}

export function formatGameTime(minutes: number): string {
  const m = Math.floor(minutes);
  const day = Math.floor(m / MINUTES_PER_DAY);
  const mod = m - day * MINUTES_PER_DAY;
  const hh = String(Math.floor(mod / 60)).padStart(2, '0');
  const mm = String(mod % 60).padStart(2, '0');
  return `d${day}-${hh}:${mm}`;
}

/** Parse "d1-07:00" (also "d3-18:30"; "d2" = 00:00) to game minutes since Day 0 00:00. Undefined if malformed. */
export function parseGameTime(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = /^d(\d+)(?:-(\d{1,2}):(\d{2}))?$/i.exec(s.trim());
  if (!m) return undefined;
  const day = Number(m[1]);
  const h = m[2] === undefined ? 0 : Number(m[2]);
  const min = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59) return undefined;
  return day * MINUTES_PER_DAY + h * 60 + min;
}
