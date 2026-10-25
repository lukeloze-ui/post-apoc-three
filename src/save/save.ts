// The save game: one versioned JSON blob in localStorage, split into named sections that each system registers.
// Autosaves a moment after something changes, and every 30 s of real time. No three, no DOM beyond the Storage interface.
import { GameClock } from '../sim/time';
import { getItem } from '../sim/items';
import type { Pack } from '../sim/pack';

export const SAVE_KEY = 'hwm-save-v1';
/** Bump when the shape of the file changes, and add a migration from the old number. */
export const SAVE_VERSION = 1;
export const AUTOSAVE_INTERVAL_MS = 30_000;
export const AUTOSAVE_DEBOUNCE_MS = 1_000;

/** The part of localStorage the save uses, so tests can pass a fake. */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SaveFile {
  version: number;
  /** Real time of the save, ms since the Unix epoch. */
  savedAt: number;
  sections: Record<string, unknown>;
}

/** Upgrades a save from version N (the key) to N + 1. */
export type Migration = (file: SaveFile) => SaveFile;

/** Migrations by the version they upgrade from. Empty while the file is still at version 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

/** Brings a parsed file up to SAVE_VERSION; undefined if it is not a save, is from the future, or a step is missing. */
export function migrateSave(raw: unknown, migrations: Readonly<Record<number, Migration>> = MIGRATIONS, target = SAVE_VERSION): SaveFile | undefined {
  const f = raw as Partial<SaveFile> | null;
  if (!f || typeof f !== 'object' || typeof f.version !== 'number' || !Number.isInteger(f.version) || f.version < 1) return undefined;
  if (!f.sections || typeof f.sections !== 'object') return undefined;
  let file: SaveFile = { version: f.version, savedAt: typeof f.savedAt === 'number' ? f.savedAt : 0, sections: f.sections };
  if (file.version > target) return undefined;
  while (file.version < target) {
    const step = migrations[file.version];
    if (!step) return undefined;
    const from = file.version;
    file = step(file);
    if (file.version !== from + 1) file = { ...file, version: from + 1 };
  }
  return file;
}

interface Section {
  serialize: () => unknown;
  load: (data: unknown) => void;
}

export interface SaveGameOptions {
  storage?: SaveStorage;
  /** ?fresh=1: do not read the existing save. Saving still goes ahead and replaces it. */
  fresh?: boolean;
  migrations?: Readonly<Record<number, Migration>>;
  now?: () => number;
}

export class SaveGame {
  private readonly storage: SaveStorage | undefined;
  private readonly sections = new Map<string, Section>();
  private readonly migrations: Readonly<Record<number, Migration>>;
  private readonly now: () => number;
  private loaded: SaveFile | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SaveGameOptions = {}) {
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    this.migrations = opts.migrations ?? MIGRATIONS;
    this.now = opts.now ?? Date.now;
    if (!opts.fresh) this.loaded = this.read();
  }

  /** Whether an existing save was read (false with fresh, no save, or a save that could not be used). */
  get hasSave(): boolean {
    return this.loaded !== undefined;
  }

  /** The loaded data for a section, before anything has registered, so setup can use it (the start position, say). */
  peek(name: string): unknown {
    return this.loaded?.sections[name];
  }

  /** Adds a section. If a save was loaded and holds this section, `load` runs straight away. */
  registerSection(name: string, serialize: () => unknown, load: (data: unknown) => void): void {
    this.sections.set(name, { serialize, load });
    const data = this.loaded?.sections[name];
    if (data !== undefined) {
      try {
        load(data);
      } catch (err) {
        console.warn(`save: section "${name}" did not load`, err);
      }
    }
  }

  /** The whole file as it would be written now. */
  snapshot(): SaveFile {
    const sections: Record<string, unknown> = {};
    for (const [name, s] of this.sections) sections[name] = s.serialize();
    return { version: SAVE_VERSION, savedAt: this.now(), sections };
  }

  save(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(this.snapshot()));
      return true;
    } catch (err) {
      console.warn('save: could not write', err);
      return false;
    }
  }

  /** Something changed: save shortly, folding a burst of changes into one write. */
  markDirty(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Starts the 30 s real-time autosave. */
  start(): void {
    if (this.interval === undefined) this.interval = setInterval(() => this.save(), AUTOSAVE_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.interval = this.debounce = undefined;
  }

  private read(): SaveFile | undefined {
    if (!this.storage) return undefined;
    try {
      const text = this.storage.getItem(SAVE_KEY);
      if (text === null) return undefined;
      return migrateSave(JSON.parse(text), this.migrations);
    } catch {
      return undefined;
    }
  }
}

// ---- the core sections -----------------------------------------------------------------------

export interface PlayerSave {
  x: number;
  y: number;
  yaw: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parsePlayerSave(data: unknown): PlayerSave | undefined {
  const p = data as Partial<PlayerSave> | null | undefined;
  return p && isNum(p.x) && isNum(p.y) && isNum(p.yaw) ? { x: p.x, y: p.y, yaw: p.yaw } : undefined;
}

export function parseClockSave(data: unknown): number | undefined {
  const c = data as { minutes?: unknown } | null | undefined;
  return c && isNum(c.minutes) ? c.minutes : undefined;
}

/** Saved pack entries that are well formed and name a real item. */
export function parsePackSave(data: unknown): Pack | undefined {
  if (!Array.isArray(data)) return undefined;
  const out: Pack = [];
  for (const e of data as Array<Record<string, unknown>>) {
    if (!e || typeof e.itemId !== 'string' || !isNum(e.qty) || typeof e.carrier !== 'string') continue;
    try {
      getItem(e.itemId);
    } catch {
      continue;
    }
    out.push({ itemId: e.itemId, qty: e.qty, carrier: e.carrier, sealed: e.sealed === true });
  }
  return out;
}

export interface CoreSources {
  /** Position and facing. Yaw in degrees, 0 north, clockwise. */
  player: { x: number; y: number; yaw: number };
  clock: GameClock;
  /** Loaded in place, so everything holding this array sees the saved pack. */
  pack: Pack;
  /** Sections the caller has already set from the URL (?e=&n=, ?t=): the save must not overwrite them. */
  overridden?: { player?: boolean; clock?: boolean };
}

/** Registers the player, clock and pack sections. */
export function registerCoreSections(save: SaveGame, src: CoreSources): void {
  save.registerSection(
    'player',
    () => ({ x: src.player.x, y: src.player.y, yaw: src.player.yaw }),
    (data) => {
      const p = parsePlayerSave(data);
      if (!p || src.overridden?.player) return;
      src.player.x = p.x;
      src.player.y = p.y;
      src.player.yaw = p.yaw;
    },
  );
  save.registerSection(
    'clock',
    () => ({ minutes: src.clock.minutes }),
    (data) => {
      const m = parseClockSave(data);
      if (m !== undefined && !src.overridden?.clock) src.clock.minutes = m;
    },
  );
  save.registerSection(
    'pack',
    () => src.pack.map((e) => ({ ...e })),
    (data) => {
      const pack = parsePackSave(data);
      if (pack) src.pack.splice(0, src.pack.length, ...pack);
    },
  );
}
