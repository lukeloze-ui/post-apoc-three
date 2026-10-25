/** Eye height above the feet, metres. */
export const EYE_HEIGHT_M = 1.65;

/** Peak vertical bob, metres, and its rate (cycles per real second) at a modelled 5 km/h walk. */
const BOB_AMPLITUDE_M = 0.025;
const BOB_HZ = 2;
const BASE_MS = 5 / 3.6;
/** How quickly the bob fades in and out, per second. */
const FADE_RATE = 6;

/** Light vertical head bob while walking: fades in on the move and out when stopped. */
export class HeadBob {
  private phase = 0;
  private strength = 0;

  /** movedMs: modelled metres per game second actually covered (0 when standing). Returns the eye's vertical offset, metres. */
  update(dt: number, movedMs: number): number {
    const pace = Math.min(1.2, Math.max(0.4, movedMs / BASE_MS));
    const target = movedMs > 0 ? Math.min(1, pace) : 0;
    this.strength += (target - this.strength) * Math.min(1, FADE_RATE * dt);
    if (movedMs > 0) this.phase += 2 * Math.PI * BOB_HZ * pace * dt;
    return BOB_AMPLITUDE_M * this.strength * Math.sin(this.phase);
  }
}
