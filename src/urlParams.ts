/** Debug URL params shared by every task. Pure parsing; no DOM access. */
import { parseGameTime } from './sim/time';

export type ViewMode = 'fp' | 'debug' | 'map' | 'pack';

export interface UrlParams {
  /** OSGB easting, metres. */
  e?: number;
  /** OSGB northing, metres. */
  n?: number;
  /** Degrees; 0 = north, clockwise. */
  yaw?: number;
  /** Degrees; positive looks up. */
  pitch?: number;
  /** Game time, e.g. d1-07:00, as game minutes since Day 0 00:00. */
  t?: number;
  view: ViewMode;
  /** Dev fly camera. */
  fly: boolean;
  /** Ignore the save game. */
  fresh: boolean;
  /** Dev stats readout: fps, draw calls, triangles. */
  stats: boolean;
  /** Debug view zoom, pixels per metre (with view=debug, e and n). */
  zoom?: number;
}

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

export function parseUrlParams(search: string): UrlParams {
  const q = new URLSearchParams(search);
  const view = q.get('view');
  const out: UrlParams = {
    view: view === 'debug' || view === 'map' || view === 'pack' ? view : 'fp',
    fly: q.get('fly') === '1',
    fresh: q.get('fresh') === '1',
    stats: q.get('stats') === '1',
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
  const zoom = num(q.get('zoom'));
  if (zoom !== undefined && zoom > 0) out.zoom = zoom;
  return out;
}
