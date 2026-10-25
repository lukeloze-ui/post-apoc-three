import * as THREE from 'three';
import type { Look } from './look';

const SPEED = 40;
const FAST = 8;

/** Temporary dev fly camera (?fly=1): WASD, Shift faster, Q down, E up. The walking controller replaces it. */
export class FlyCamera {
  private readonly down = new Set<string>();
  private readonly dir = new THREE.Vector3();

  constructor(private readonly look: Look) {
    window.addEventListener('keydown', (ev) => this.down.add(ev.code));
    window.addEventListener('keyup', (ev) => this.down.delete(ev.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  update(camera: THREE.Camera, dt: number): void {
    const k = (code: string): number => (this.down.has(code) ? 1 : 0);
    const fwd = k('KeyW') - k('KeyS');
    const right = k('KeyD') - k('KeyA');
    const up = k('KeyE') - k('KeyQ');
    if (fwd === 0 && right === 0 && up === 0) return;
    const yaw = THREE.MathUtils.degToRad(this.look.yaw);
    const pitch = THREE.MathUtils.degToRad(this.look.pitch);
    // Yaw 0 = north = -z, clockwise from above.
    const cp = Math.cos(pitch);
    this.dir.set(
      Math.sin(yaw) * cp * fwd + Math.cos(yaw) * right,
      Math.sin(pitch) * fwd + up,
      -Math.cos(yaw) * cp * fwd + Math.sin(yaw) * right,
    );
    const speed = SPEED * (this.down.has('ShiftLeft') || this.down.has('ShiftRight') ? FAST : 1);
    camera.position.addScaledVector(this.dir.normalize(), speed * dt);
  }
}
