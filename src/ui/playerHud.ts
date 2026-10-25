import type { Player } from '../sim/player';
import { GROUND_LABEL } from '../world/conditions';

/** The HUD text for the player: pace, the ground's condition, and each person's load band and stamina. */
export function playerHudLines(p: Player): string[] {
  const pace = p.resting ? 'resting' : `${(p.paceMs * 3.6).toFixed(1)} km/h`;
  const lines = [`${pace}  on ${p.conditions?.explanation ?? GROUND_LABEL[p.groundType]}`];
  for (const s of p.status()) {
    lines.push(`${s.name}  load ${s.band}  stamina ${Math.round(s.stamina * 100)}%`);
  }
  return lines;
}

/** Bottom-left panel for the walking party. */
export function createPlayerHud(): { update(p: Player): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;bottom:8px;left:8px;z-index:10;padding:4px 8px;background:rgba(0,0,0,0.4);color:#f2ead8;' +
    'font:13px/1.4 monospace;white-space:pre;pointer-events:none';
  document.body.appendChild(el);
  let shown = '';
  return {
    update(p: Player): void {
      const text = playerHudLines(p).join('\n');
      if (text === shown) return;
      shown = text;
      el.textContent = text;
    },
  };
}
