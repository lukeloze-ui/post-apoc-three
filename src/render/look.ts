import * as THREE from 'three';

const MAX_PITCH_DEG = 89;
/** Degrees of turn per pixel of mouse movement. */
const SENSITIVITY = 0.12;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Mouse look with its own yaw/pitch (degrees). Yaw 0 = north, clockwise; pitch positive looks up. */
export class Look {
  yaw: number;
  pitch: number;

  constructor(dom: HTMLElement, yaw = 0, pitch = 0) {
    this.yaw = Look.wrapYaw(yaw);
    this.pitch = clamp(pitch, -MAX_PITCH_DEG, MAX_PITCH_DEG);
    dom.addEventListener('click', () => {
      if (document.pointerLockElement !== dom) void dom.requestPointerLock();
    });
    document.addEventListener('mousemove', (ev) => {
      if (document.pointerLockElement !== dom) return;
      this.turn(ev.movementX * SENSITIVITY, -ev.movementY * SENSITIVITY);
    });
  }

  static wrapYaw(deg: number): number {
    return ((deg % 360) + 360) % 360;
  }

  /** Turn right by dYaw degrees and up by dPitch degrees; pitch is clamped. */
  turn(dYaw: number, dPitch: number): void {
    this.yaw = Look.wrapYaw(this.yaw + dYaw);
    this.pitch = clamp(this.pitch + dPitch, -MAX_PITCH_DEG, MAX_PITCH_DEG);
  }

  /** Orient the camera. Three's +y rotation is anticlockwise, so yaw is negated. */
  apply(camera: THREE.Camera): void {
    camera.rotation.order = 'YXZ';
    camera.rotation.y = -THREE.MathUtils.degToRad(this.yaw);
    camera.rotation.x = THREE.MathUtils.degToRad(this.pitch);
    camera.rotation.z = 0;
  }
}
