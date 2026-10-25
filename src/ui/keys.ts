import type { PlayerInput } from '../sim/player';

/** WASD (and arrow keys) as walking input. */
export class WalkKeys {
  private readonly down = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (ev) => this.down.add(ev.code));
    window.addEventListener('keyup', (ev) => this.down.delete(ev.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  read(): PlayerInput {
    const k = (a: string, b: string): number => (this.down.has(a) || this.down.has(b) ? 1 : 0);
    return {
      forward: k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown'),
      right: k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'),
    };
  }
}
