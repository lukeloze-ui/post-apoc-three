// The pack screen: one of the game's few 2D screens. Two columns, one per person, with their items,
// total load and band. Items move between people, drop to the ground, or go in and out of the dry bag.
import { getItem } from '../sim/items';
import { bandEffects, loadBand, loadShare, partyPace, type LoadBand, type Party, type Person } from '../sim/load';
import { addItem, carriedKg, entryKg, type Pack, type PackEntry } from '../sim/pack';

const BAND_COLOUR: Record<LoadBand, string> = { 1: '#7bc96f', 2: '#e0c24a', 3: '#e8903a', 4: '#d9534f' };
const BAND_LABEL: Record<LoadBand, string> = { 1: 'normal pace', 2: 'slower, tires faster', 3: 'much slower, injury risk', 4: 'short hops only' };

const hasDryBag = (pack: Pack, carrier: string): boolean => pack.some((e) => e.itemId === 'dry_bag' && e.carrier === carrier);

/** Takes qty (at most the entry's) off an entry, dropping the entry when empty. Returns how many were taken. */
function take(pack: Pack, e: PackEntry, qty: number): number {
  const n = Math.min(Math.max(0, Math.floor(qty)), e.qty);
  if (n <= 0) return 0;
  e.qty -= n;
  if (e.qty === 0) pack.splice(pack.indexOf(e), 1);
  return n;
}

/** Moves qty of an entry to another person. Sealed items stay sealed only if the new carrier has a dry bag. */
export function moveEntry(pack: Pack, e: PackEntry, to: string, qty = 1): void {
  if (e.carrier === to) return;
  const sealed = e.sealed && hasDryBag(pack, to);
  const n = take(pack, e, qty);
  if (n > 0) addItem(pack, e.itemId, n, to, sealed);
}

/** Removes qty of an entry from the pack. Returns what was removed, for the ground. */
export function dropEntry(pack: Pack, e: PackEntry, qty = 1): { itemId: string; qty: number } | undefined {
  const itemId = e.itemId;
  const n = take(pack, e, qty);
  return n > 0 ? { itemId, qty: n } : undefined;
}

/** Puts qty of an entry in or out of its carrier's dry bag. Needs the carrier to hold a dry bag. */
export function setSealed(pack: Pack, e: PackEntry, sealed: boolean, qty = 1): boolean {
  if (e.sealed === sealed || e.itemId === 'dry_bag') return false;
  if (sealed && !hasDryBag(pack, e.carrier)) return false;
  const n = take(pack, e, qty);
  if (n > 0) addItem(pack, e.itemId, n, e.carrier, sealed);
  return n > 0;
}

export interface PackScreenOptions {
  party: Party;
  /** Called when the player drops qty of an item; the caller puts it on the ground. */
  onDrop(itemId: string, qty: number): void;
  /** Called after any change to the pack. */
  onChange?(): void;
}

export interface PackScreen {
  readonly visible: boolean;
  setVisible(v: boolean): void;
  toggle(): void;
  refresh(): void;
}

const fmtKg = (kg: number): string => `${kg.toFixed(1)} kg`;

export function createPackScreen(opts: PackScreenOptions): PackScreen {
  const { party } = opts;
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:30;display:none;overflow:auto;background:rgba(18,16,12,0.94);color:#f2ead8;font:14px/1.4 monospace';
  document.body.appendChild(root);
  let visible = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  };

  const act = (fn: () => void): void => {
    fn();
    opts.onChange?.();
    render();
  };

  const button = (label: string, title: string, onClick: (all: boolean) => void, enabled = true): HTMLButtonElement => {
    const b = el(
      'button',
      `margin-left:4px;padding:0 6px;font:12px monospace;color:${enabled ? '#f2ead8' : '#7a7466'};background:#3a352b;border:1px solid #6b6454;cursor:${enabled ? 'pointer' : 'default'}`,
      label,
    );
    b.title = title;
    b.disabled = !enabled;
    b.addEventListener('click', (ev) => onClick(ev.shiftKey));
    return b;
  };

  const column = (p: Person, other: Person): HTMLElement => {
    const kg = carriedKg(party.pack, p.id);
    const share = loadShare(kg, p.bodyKg);
    const band = loadBand(share);
    const col = el('div', 'flex:1 1 420px;min-width:360px;padding:12px;border:1px solid #5a5446;background:rgba(0,0,0,0.25)');
    col.appendChild(el('div', 'font-size:18px;font-weight:bold', `${p.name} (${p.bodyKg} kg)`));
    const load = el('div', 'margin:4px 0 10px');
    load.appendChild(el('span', '', `${fmtKg(kg)}  ${(share * 100).toFixed(0)}% of body weight  `));
    load.appendChild(el('span', `padding:1px 6px;color:#14110c;background:${BAND_COLOUR[band]}`, `band ${band}`));
    load.appendChild(el('span', 'margin-left:6px;color:#b8b09c', BAND_LABEL[band]));
    col.appendChild(load);

    const rows = party.pack.filter((e) => e.carrier === p.id);
    if (rows.length === 0) col.appendChild(el('div', 'color:#8a8370', 'Carrying nothing.'));
    const bagged = hasDryBag(party.pack, p.id);
    for (const e of rows) {
      const def = getItem(e.itemId);
      const row = el('div', 'display:flex;align-items:center;padding:2px 0;border-top:1px solid #36312700');
      row.appendChild(el('span', 'flex:1', `${def.name}${e.sealed ? ' [dry bag]' : ''}`));
      row.appendChild(el('span', 'width:3.5em;text-align:right', `x${e.qty}`));
      row.appendChild(el('span', 'width:5.5em;text-align:right;color:#b8b09c', fmtKg(entryKg(e))));
      const more = e.qty > 1 ? ' (shift: all)' : '';
      const n = (all: boolean): number => (all ? e.qty : 1);
      row.appendChild(button(`give ${other.name}`, `Hand to ${other.name}${more}`, (all) => act(() => moveEntry(party.pack, e, other.id, n(all)))));
      if (e.itemId !== 'dry_bag') {
        row.appendChild(
          button(
            e.sealed ? 'unseal' : 'seal',
            bagged || e.sealed ? `${e.sealed ? 'Take out of' : 'Put in'} the dry bag${more}` : 'Needs a dry bag',
            (all) => act(() => void setSealed(party.pack, e, !e.sealed, n(all))),
            bagged || e.sealed,
          ),
        );
      }
      row.appendChild(
        button('drop', `Leave on the ground${more}`, (all) =>
          act(() => {
            const gone = dropEntry(party.pack, e, n(all));
            if (gone) opts.onDrop(gone.itemId, gone.qty);
          }),
        ),
      );
      col.appendChild(row);
    }
    return col;
  };

  function render(): void {
    root.replaceChildren();
    const wrap = el('div', 'max-width:1000px;margin:0 auto;padding:20px');
    wrap.appendChild(el('div', 'font-size:22px;margin-bottom:12px', 'Pack'));
    const cols = el('div', 'display:flex;flex-wrap:wrap;gap:12px');
    const [a, b] = party.people;
    if (a && b) {
      cols.appendChild(column(a, b));
      cols.appendChild(column(b, a));
    }
    wrap.appendChild(cols);
    const pace = partyPace(party.pack, party.people);
    let worst: LoadBand = 1;
    for (const p of party.people) worst = Math.max(worst, loadBand(loadShare(carriedKg(party.pack, p.id), p.bodyKg))) as LoadBand;
    const fx = bandEffects(worst);
    const foot = el('div', 'margin-top:14px');
    foot.appendChild(el('div', 'font-size:16px', `Party pace: ${(pace * 100).toFixed(0)}% of normal (the slower of the two). Fatigue x${fx.fatigueRate}.`));
    foot.appendChild(el('div', 'margin-top:6px;color:#b8b09c', 'Give, seal and drop move one at a time; hold Shift to move the whole stack. Walking and the clock are paused. Tab or Esc closes.'));
    wrap.appendChild(foot);
    root.appendChild(wrap);
  }

  const self: PackScreen = {
    get visible() {
      return visible;
    },
    setVisible(v) {
      visible = v;
      root.style.display = v ? 'block' : 'none';
      if (v) render();
    },
    toggle() {
      self.setVisible(!visible);
    },
    refresh() {
      if (visible) render();
    },
  };

  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Tab') {
      ev.preventDefault();
      if (!ev.repeat) self.toggle();
    } else if (ev.code === 'Escape' && visible) {
      self.setVisible(false);
    }
  });
  return self;
}
