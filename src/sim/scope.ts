// The scope: binoculars (hold right mouse or B) and the rifle sight (R toggles). Pure state; no three, no DOM.
import type { Pack } from './pack';

export type ScopeKind = 'binoculars' | 'rifle';

/** The normal field of view, degrees (vertical). */
export const NORMAL_FOV_DEG = 70;
/** Field of view through each optic: about 8x for the binoculars. */
export const SCOPE_FOV_DEG: Record<ScopeKind, number> = { binoculars: 6, rifle: 4 };
/** Seconds to bring the optic up, and to lower it. */
export const RAISE_SEC = 0.35;
/** Walking pace multiplier while an optic is up. */
export const SCOPED_PACE = 0.5;
/** Rifles that carry a sight (items.ts: the SA80 A3 is the one with the sight fitted). */
const SIGHTED_RIFLES = ['rifle_sa80a3', 'rifle_l403a1'];

export const hasBinoculars = (pack: Pack): boolean => pack.some((e) => e.itemId === 'binoculars' && e.qty > 0);
export const hasSightedRifle = (pack: Pack): boolean => pack.some((e) => SIGHTED_RIFLES.includes(e.itemId) && e.qty > 0);

/** Mouse sensitivity scale for a field of view: the turn per pixel shrinks with the zoom. */
export function sensitivityScale(fovDeg: number): number {
  return Math.tan((fovDeg * Math.PI) / 360) / Math.tan((NORMAL_FOV_DEG * Math.PI) / 360);
}

export class Scope {
  /** 0 = down, 1 = fully raised. */
  raise = 0;
  private holdBinoculars = false;
  private rifleOn = false;

  constructor(private readonly pack: Pack) {}

  /** Right mouse or B held or let go. */
  setBinoculars(down: boolean): void {
    this.holdBinoculars = down;
  }

  /** R pressed: toggle the rifle scope. */
  toggleRifle(): void {
    this.rifleOn = !this.rifleOn;
  }

  /** Which optic is wanted and carried; binoculars win while held. */
  get kind(): ScopeKind | null {
    if (this.holdBinoculars && hasBinoculars(this.pack)) return 'binoculars';
    if (this.rifleOn && hasSightedRifle(this.pack)) return 'rifle';
    return null;
  }

  private shown: ScopeKind = 'binoculars';

  update(dt: number): void {
    const k = this.kind;
    if (k) this.shown = k;
    const step = dt / RAISE_SEC;
    this.raise = Math.min(1, Math.max(0, this.raise + (k ? step : -step)));
  }

  /** True once the optic is up far enough to see through: this is what the reveal reads. */
  get scoped(): boolean {
    return this.kind !== null && this.raise >= 1;
  }

  /** The optic on screen (also while it is being raised or lowered), or null. */
  get visibleKind(): ScopeKind | null {
    return this.raise > 0 ? this.shown : null;
  }

  get fov(): number {
    const target = SCOPE_FOV_DEG[this.shown];
    return NORMAL_FOV_DEG + (target - NORMAL_FOV_DEG) * this.raise;
  }

  get pace(): number {
    return 1 + (SCOPED_PACE - 1) * this.raise;
  }
}
