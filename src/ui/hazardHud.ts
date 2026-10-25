import { gasFade, hazardLines, type HazardEvent } from '../sim/hazards';
import type { Player } from '../sim/player';

/** How long, real ms, a trip or injury message stays up. */
export const EVENT_SHOW_MS = 6000;

/** One line for something that just happened. Names are the person's name from the party. */
export function eventLine(e: HazardEvent, nameOf: (id: string) => string): string {
  switch (e.kind) {
    case 'trip':
      return `${nameOf(e.who)} trips on the rough ground in the dark${e.hurt ? ' and turns an ankle' : ''}.`;
    case 'injury':
      return `${nameOf(e.who)} hurts a ${e.part}${e.cause === 'fall' ? '' : ` (${e.cause})`}.`;
    case 'stuck':
      return `Stuck in soft mud. It takes ${Math.round(e.sec / 60)} minutes to get out.`;
    case 'gas':
      return e.level === 'serious' ? 'The air is thick and sour. You are going to pass out.' : 'The air tastes sour. Your head aches.';
    case 'collapse':
      return `${nameOf(e.who)} collapses.`;
  }
}

/** The gas warning and recent events at the top centre, and a black overlay that fades the screen as the gas takes hold. */
export function createHazardHud(): { update(p: Player, nearGas: boolean, now: number): void } {
  const fade = document.createElement('div');
  fade.style.cssText = 'position:fixed;inset:0;z-index:9;background:#000;opacity:0;pointer-events:none';
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:11;padding:4px 10px;background:rgba(0,0,0,0.5);' +
    'color:#f2ead8;font:14px/1.4 monospace;white-space:pre;text-align:center;pointer-events:none;display:none';
  document.body.append(fade, el);
  let recent: { text: string; until: number }[] = [];
  let shown = '';
  let opacity = '';
  return {
    update(p, nearGas, now): void {
      const names = new Map(p.party.people.map((q) => [q.id, q.name]));
      for (const e of p.takeEvents()) {
        recent.push({ text: eventLine(e, (id) => names.get(id) ?? id), until: now + EVENT_SHOW_MS });
      }
      recent = recent.filter((r) => r.until > now).slice(-3);
      const text = [...hazardLines(p.hazards, nearGas), ...recent.map((r) => r.text)].join('\n');
      if (text !== shown) {
        shown = text;
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
      }
      const o = gasFade(p.hazards).toFixed(2);
      if (o !== opacity) {
        opacity = o;
        fade.style.opacity = o;
      }
    },
  };
}
