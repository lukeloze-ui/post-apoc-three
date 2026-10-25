/** Numbers for the stats readout, read once per frame. */
export interface StatsSample {
  calls: number;
  triangles: number;
  /** Optional extra line, e.g. the terrain rebuild queue. */
  extra?: string;
}

const WINDOW_S = 0.5;

/** Dev stats readout (?stats=1): fps, draw calls and triangles in the top-left corner. */
export function createStatsReadout(sample: () => StatsSample): { update(dt: number): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:6px;left:6px;z-index:20;padding:4px 7px;background:rgba(0,0,0,0.55);color:#cfe;' +
    'font:12px/1.35 monospace;white-space:pre;pointer-events:none';
  document.body.appendChild(el);
  let frames = 0;
  let time = 0;
  let fps = 0;
  return {
    update(dt: number): void {
      frames++;
      time += dt;
      if (time >= WINDOW_S) {
        fps = frames / time;
        frames = 0;
        time = 0;
      }
      const s = sample();
      el.textContent =
        `${fps.toFixed(0)} fps\n${s.calls} draws\n${(s.triangles / 1000).toFixed(0)}k tris` + (s.extra ? `\n${s.extra}` : '');
    },
  };
}
