// The settings menu: Esc opens it (when no other screen is up) with a 'Hint marks on map' checkbox and Resume.
// The game pauses while it is open.
export interface MenuOptions {
  hintMarks: boolean;
  onHintMarks: (on: boolean) => void;
  /** Esc only opens the menu when this is true (no map or pack screen up). */
  canOpen: () => boolean;
  onChange?: (open: boolean) => void;
  parent?: HTMLElement;
}

export interface Menu {
  readonly visible: boolean;
  setVisible(v: boolean): void;
  setHintMarks(on: boolean): void;
}

export function createMenu(opts: MenuOptions): Menu {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:70;background:rgba(0,0,0,0.6);display:none;align-items:center;justify-content:center;font:16px sans-serif;color:#eee';
  const box = document.createElement('div');
  box.style.cssText = 'background:#2b2822;border:1px solid #6b6252;padding:20px 28px;min-width:260px';
  const title = document.createElement('div');
  title.textContent = 'Settings';
  title.style.cssText = 'font-size:20px;margin-bottom:14px';
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = opts.hintMarks;
  check.addEventListener('change', () => opts.onHintMarks(check.checked));
  label.append(check, document.createTextNode('Hint marks on map'));
  const resume = document.createElement('button');
  resume.textContent = 'Resume';
  resume.style.cssText = 'margin-top:16px;padding:6px 18px';
  resume.addEventListener('click', () => self.setVisible(false));
  box.append(title, label, resume);
  root.appendChild(box);
  (opts.parent ?? document.body).appendChild(root);

  let visible = false;
  const self: Menu = {
    get visible() {
      return visible;
    },
    setVisible(v) {
      if (v === visible) return;
      visible = v;
      root.style.display = v ? 'flex' : 'none';
      if (v && document.pointerLockElement) document.exitPointerLock();
      opts.onChange?.(v);
    },
    setHintMarks(on) {
      check.checked = on;
    },
  };
  // Capture phase: runs before the map's and pack screen's Esc handlers, so it sees them still open.
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.code !== 'Escape' || ev.repeat) return;
      if (visible) self.setVisible(false);
      else if (opts.canOpen()) self.setVisible(true);
    },
    true,
  );
  return self;
}
