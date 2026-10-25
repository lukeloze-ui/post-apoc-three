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

/** How long, real ms, the result of a search stays on screen. */
export const RESULT_SHOW_MS = 7000;

/** Centre-bottom panel: the prompt for what the player is looking at, and the result of the last search under it. */
export function createInteractHud(): { setPrompt(text: string): void; showResult(lines: string[], now: number): void; tick(now: number): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:10;padding:4px 10px;background:rgba(0,0,0,0.4);' +
    'color:#f2ead8;font:14px/1.4 monospace;white-space:pre;text-align:center;pointer-events:none;display:none';
  document.body.appendChild(el);
  let prompt = '';
  let result: string[] = [];
  let until = 0;
  let shown = '';
  const draw = (): void => {
    const text = [...result, ...(prompt ? [prompt] : [])].join('\n');
    if (text === shown) return;
    shown = text;
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  };
  return {
    setPrompt(text: string): void {
      prompt = text;
      draw();
    },
    showResult(lines: string[], now: number): void {
      result = lines;
      until = now + RESULT_SHOW_MS;
      draw();
    },
    tick(now: number): void {
      if (result.length > 0 && now >= until) {
        result = [];
        draw();
      }
    },
  };
}

/** "Day 1  07:00" from the clock's day and hh:mm. */
export function clockLabel(day: number, hh: number, mm: number): string {
  return `Day ${day}  ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
