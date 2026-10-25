/** Small HUD clock in the top-right corner: day and hh:mm of the game clock. */
export function createHud(): { update(label: string): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:6px;right:8px;z-index:10;padding:3px 8px;background:rgba(0,0,0,0.4);color:#f2ead8;' +
    'font:14px/1.3 monospace;letter-spacing:0.5px;pointer-events:none';
  document.body.appendChild(el);
  let shown = '';
  return {
    update(label: string): void {
      if (label === shown) return;
      shown = label;
      el.textContent = label;
    },
  };
}

/** "Day 1  07:00" from the clock's day and hh:mm. */
export function clockLabel(day: number, hh: number, mm: number): string {
  return `Day ${day}  ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
