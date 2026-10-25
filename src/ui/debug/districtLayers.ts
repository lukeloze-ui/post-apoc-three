// Debug layers for the hidden district damage (districts.json): bridges, road segments, craters, strike zones, fires,
// gas hollows and animal counts. Hovering a record shows it in the overhead view's readout.
import {
  ANIMAL_KINDS,
  BIRD_KINDS,
  type DistrictTile,
  type Districts,
  type RoadSegment,
  type Spot,
} from '../../world/districts';
import { TILE_M } from '../../world/terrain';
import { registerDebugLayer, type DebugViewport } from './overheadView';

/** How close the cursor must be to a mark to hover it, pixels. */
const HOVER_PX = 6;

/** One line of key=value pairs, leaving out bulky lists (points, cells). */
function describe(kind: string, rec: object): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'pts' || k === 'cells') continue;
    parts.push(`${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
  }
  return `${kind}: ${parts.join(' ')}`;
}

/** Distance from (x, y) to segment a-b, metres. */
function distToSeg(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

/** Radius drawn for a spot: its true size, but never less than minPx. */
const drawR = (view: DebugViewport, s: Spot, minPx: number): number => Math.max(minPx, s.r * view.scale);

/** Topmost spot (last drawn) under the cursor, allowing for its drawn size. */
function spotAt<T extends Spot>(view: DebugViewport, spots: readonly T[], x: number, y: number, minPx: number): T | undefined {
  for (let k = spots.length - 1; k >= 0; k--) {
    const s = spots[k] as T;
    if (Math.hypot(x - s.x, y - s.y) * view.scale <= drawR(view, s, minPx) + HOVER_PX / 2) return s;
  }
  return undefined;
}

function circle(ctx: CanvasRenderingContext2D, view: DebugViewport, x: number, y: number, rPx: number): void {
  const { px, py } = view.toPx(x, y);
  ctx.beginPath();
  ctx.arc(px, py, rPx, 0, Math.PI * 2);
}

function star(ctx: CanvasRenderingContext2D, px: number, py: number, r: number): void {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI) / 5 - Math.PI / 2;
    const rr = k % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(px + rr * Math.cos(a), py + rr * Math.sin(a));
  }
  ctx.closePath();
}

const walkingCount = (t: DistrictTile): number =>
  ANIMAL_KINDS.reduce((n, k) => n + (BIRD_KINDS.includes(k) ? 0 : (t.animals[k] ?? 0)), 0);
const animalCount = (t: DistrictTile): number => ANIMAL_KINDS.reduce((n, k) => n + (t.animals[k] ?? 0), 0);

/** Registers every district layer. Call once, after the overhead view's base layers. */
export function registerDistrictLayers(d: Districts): void {
  const craters = d.tiles.flatMap((t) => t.craters);
  const zones = d.tiles.flatMap((t) => t.strikeZones);
  const fires = d.tiles.flatMap((t) => t.fires);
  const gas = d.tiles.flatMap((t) => t.gasHollows);
  const survivorOf = new Map<string, string>();
  for (const s of d.survivors) for (const id of s.bridgeIds) survivorOf.set(id, s.name);
  const maxAnimals = Math.max(1, ...d.tiles.map(animalCount));

  registerDebugLayer({
    id: 'd-animals',
    label: 'Animals (heatmap, walkers + birds)',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.font = '11px monospace';
      ctx.textBaseline = 'bottom';
      for (const t of d.tiles) {
        const n = animalCount(t);
        if (n === 0) continue;
        const a = view.toPx(t.i * TILE_M, (t.j + 1) * TILE_M);
        const w = TILE_M * view.scale;
        // Square-root scale so a few animals still show.
        ctx.fillStyle = `rgba(200,60,255,${(0.05 + 0.3 * Math.sqrt(n / maxAnimals)).toFixed(3)})`;
        ctx.fillRect(a.px, a.py, w, w);
        ctx.fillStyle = '#f6d8ff';
        ctx.fillText(`${walkingCount(t)}+${n - walkingCount(t)}b`, a.px + 4, a.py + w - 3);
      }
      ctx.restore();
    },
    hover(_view, x, y) {
      const t = d.tiles.find((t) => x >= t.i * TILE_M && x < (t.i + 1) * TILE_M && y >= t.j * TILE_M && y < (t.j + 1) * TILE_M);
      if (!t) return undefined;
      return `tile ${t.id}: hw=${t.hw} pocked=${t.pocked} animals=${JSON.stringify(t.animals)}`;
    },
  });

  registerDebugLayer({
    id: 'd-gas',
    label: 'Gas hollows (days 1-5)',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.fillStyle = 'rgba(190,255,40,0.55)';
      const cell = view.data.terrain.meta.cellM;
      for (const g of gas) {
        for (const [cx, cy] of g.cells) {
          const a = view.toPx(cx * cell, (cy + 1) * cell);
          ctx.fillRect(a.px, a.py, cell * view.scale, cell * view.scale);
        }
      }
      ctx.restore();
    },
    hover(view, x, y) {
      const cell = view.data.terrain.meta.cellM;
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const g = gas.find((h) => h.cells.some(([i, j]) => i === cx && j === cy));
      return g && describe('gas hollow', { ...g, cellCount: g.cells.length });
    },
  });

  const segHit = (view: DebugViewport, x: number, y: number): RoadSegment | undefined => {
    const tol = HOVER_PX / view.scale;
    let best: RoadSegment | undefined;
    let bestD = tol;
    for (const s of d.roadSegments) {
      for (let k = 1; k < s.pts.length; k++) {
        const dd = distToSeg(x, y, s.pts[k - 1] as [number, number], s.pts[k] as [number, number]);
        // Prefer blocked segments on a tie, as they are drawn on top.
        if (dd < bestD || (dd === bestD && s.blocked)) {
          bestD = dd;
          best = s;
        }
      }
    }
    return best;
  };

  registerDebugLayer({
    id: 'd-roads',
    label: 'Road segments (blocked red + cause)',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.lineCap = 'round';
      for (const blocked of [false, true]) {
        ctx.strokeStyle = blocked ? '#ff2a2a' : 'rgba(255,255,255,0.75)';
        ctx.lineWidth = blocked ? 2.5 : 1.2;
        ctx.beginPath();
        for (const s of d.roadSegments) {
          if (s.blocked !== blocked) continue;
          s.pts.forEach(([x, y], k) => {
            const p = view.toPx(x, y);
            if (k === 0) ctx.moveTo(p.px, p.py);
            else ctx.lineTo(p.px, p.py);
          });
        }
        ctx.stroke();
      }
      // Cause labels on segments long enough on screen to carry one.
      {
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#ffb0b0';
        for (const s of d.roadSegments) {
          if (!s.blocked || !s.cause || s.length * view.scale < 60) continue;
          const [x, y] = s.pts[Math.floor(s.pts.length / 2)] as [number, number];
          const p = view.toPx(x, y);
          ctx.strokeText(s.cause, p.px, p.py);
          ctx.fillText(s.cause, p.px, p.py);
        }
      }
      ctx.restore();
    },
    hover(view, x, y) {
      const s = segHit(view, x, y);
      return s && describe('road segment', s);
    },
  });

  registerDebugLayer({
    id: 'd-zones',
    label: 'Strike zones (burning / glassy)',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.lineWidth = 2;
      for (const z of zones) {
        circle(ctx, view, z.x, z.y, drawR(view, z, 6));
        ctx.fillStyle = z.kind === 'burning' ? 'rgba(255,90,0,0.45)' : 'rgba(120,230,255,0.45)';
        ctx.strokeStyle = z.kind === 'burning' ? '#ff5a00' : '#78e6ff';
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
    hover(view, x, y) {
      const z = spotAt(view, zones, x, y, 6);
      return z && describe('strike zone', z);
    },
  });

  registerDebugLayer({
    id: 'd-craters',
    label: 'Craters (by size; blue = water)',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.lineWidth = 1;
      for (const c of craters) {
        // Small craters dark, the largest bright; size on screen is the true size, at least 1.5 px.
        const f = Math.min(1, Math.max(0, (c.r * 2 - 15) / 35));
        circle(ctx, view, c.x, c.y, drawR(view, c, 1.5 + 2 * f));
        ctx.fillStyle = c.water ? 'rgba(60,140,255,0.9)' : `rgba(${Math.round(60 + 195 * f)},${Math.round(40 + 120 * f)},20,0.9)`;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
    hover(view, x, y) {
      const c = spotAt(view, craters, x, y, 2);
      return c && describe('crater', { ...c, diameter: Math.round(c.r * 20) / 10 });
    },
  });

  registerDebugLayer({
    id: 'd-fires',
    label: 'Fires',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.fillStyle = '#ffd400';
      ctx.strokeStyle = '#c00';
      ctx.lineWidth = 1.5;
      for (const f of fires) {
        circle(ctx, view, f.x, f.y, drawR(view, f, 3));
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
    hover(view, x, y) {
      const f = spotAt(view, fires, x, y, 3);
      return f && describe('fire', f);
    },
  });

  registerDebugLayer({
    id: 'd-bridges',
    label: 'Bridges (green stands, red fell, star survivor)',
    defaultOn: true,
    draw(ctx, view) {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#000';
      // Survivors last, so their stars sit on top.
      const order = [...d.bridges.filter((b) => !survivorOf.has(b.id)), ...d.bridges.filter((b) => survivorOf.has(b.id))];
      for (const b of order) {
        const { px, py } = view.toPx(b.x, b.y);
        ctx.fillStyle = b.standing ? '#2dff5a' : '#ff2a2a';
        if (survivorOf.has(b.id)) star(ctx, px, py, 11);
        else {
          ctx.beginPath();
          ctx.arc(px, py, b.major ? 5 : 3.5, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
    hover(view, x, y) {
      let best: (typeof d.bridges)[number] | undefined;
      let bestD = (HOVER_PX + 3) / view.scale;
      for (const b of d.bridges) {
        const dd = Math.hypot(x - b.x, y - b.y);
        if (dd < bestD) {
          bestD = dd;
          best = b;
        }
      }
      if (!best) return undefined;
      const name = survivorOf.get(best.id);
      return describe(name ? `bridge (survivor: ${name})` : 'bridge', best);
    },
  });
}
