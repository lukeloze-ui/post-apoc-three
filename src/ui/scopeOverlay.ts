import type { ScopeKind } from '../sim/scope';

/** Full-screen scope view: a black double-circle vignette for the binoculars, a round sight with a reticle for the rifle. */
export function createScopeOverlay(): { update(kind: ScopeKind | null, raise: number): void } {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;display:none';
  document.body.appendChild(el);
  let shown: ScopeKind | null = null;

  const build = (kind: ScopeKind): void => {
    if (kind === 'binoculars') {
      // Each mask layer is opaque outside one lens; intersecting them leaves black only outside both lenses.
      const lens = (cx: number): string => `radial-gradient(circle at ${cx}% 50%, #0000 0 27vmin, #000 27.5vmin)`;
      const mask = `${lens(38)}, ${lens(62)}`;
      el.innerHTML = '';
      const dark = document.createElement('div');
      dark.style.cssText = 'position:absolute;inset:0;background:#000';
      dark.style.setProperty('-webkit-mask-image', mask);
      dark.style.setProperty('mask-image', mask);
      dark.style.setProperty('-webkit-mask-composite', 'source-in');
      dark.style.setProperty('mask-composite', 'intersect');
      el.appendChild(dark);
    } else {
      el.innerHTML =
        '<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, #0000 0 36vmin, #000 36.4vmin)"></div>' +
        '<div style="position:absolute;left:50%;top:50%;width:72vmin;height:1px;margin:0 0 0 -36vmin;background:rgba(0,0,0,0.85)"></div>' +
        '<div style="position:absolute;left:50%;top:50%;height:72vmin;width:1px;margin:-36vmin 0 0 0;background:rgba(0,0,0,0.85)"></div>' +
        '<div style="position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#c22"></div>';
    }
  };

  return {
    update(kind, raise): void {
      if (!kind || raise <= 0) {
        el.style.display = 'none';
        return;
      }
      if (kind !== shown) {
        shown = kind;
        build(kind);
      }
      el.style.display = 'block';
      el.style.opacity = String(Math.min(1, raise * 1.5));
    },
  };
}
