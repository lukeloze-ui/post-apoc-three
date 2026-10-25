/** Debug URL params shared by every task. Pure parsing; no DOM access. */

export type ViewMode = 'fp' | 'debug' | 'map';

export interface GameTime {
  /** 1-based day number. */
  day: number;
  /** Hours since midnight, 0..24. */
  hours: number;
}

export interface UrlParams {
  /** OSGB easting, metres. */
  e?: number;
  /** OSGB northing, metres. */
  n?: number;
  /** Degrees; 0 = north, clockwise. */
  yaw?: number;
  /** Degrees; positive looks up. */
  pitch?: number;
  /** Game time, e.g. d1-07:00. */
  t?: GameTime;
  view: ViewMode;
  /** Dev fly camera. */
  fly: boolean;
  /** Ignore the save game. */
  fresh: boolean;
}

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

/** Parse "d1-07:00" (also "d3-18:30", "d2" = 00:00). Returns undefined if malformed. */
export function parseGameTime(s: string | null): GameTime | undefined {
  if (!s) return undefined;
  const m = /^d(\d+)(?:-(\d{1,2}):(\d{2}))?$/i.exec(s.trim());
  if (!m) return undefined;
  const day = Number(m[1]);
  const h = m[2] === undefined ? 0 : Number(m[2]);
  const min = m[3] === undefined ? 0 : Number(m[3]);
  if (day < 1 || h > 23 || min > 59) return undefined;
  return { day, hours: h + min / 60 };
}

export function parseUrlParams(search: string): UrlParams {
  const q = new URLSearchParams(search);
  const view = q.get('view');
  const out: UrlParams = {
    view: view === 'debug' || view === 'map' ? view : 'fp',
    fly: q.get('fly') === '1',
    fresh: q.get('fresh') === '1',
  };
  const e = num(q.get('e'));
  const n = num(q.get('n'));
  const yaw = num(q.get('yaw'));
  const pitch = num(q.get('pitch'));
  const t = parseGameTime(q.get('t'));
  if (e !== undefined) out.e = e;
  if (n !== undefined) out.n = n;
  if (yaw !== undefined) out.yaw = yaw;
  if (pitch !== undefined) out.pitch = pitch;
  if (t !== undefined) out.t = t;
  return out;
}
