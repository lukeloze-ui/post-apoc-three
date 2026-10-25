import * as THREE from 'three';
import { parseUrlParams } from './urlParams';

declare global {
  interface Window {
    __ready?: boolean;
    __game?: unknown;
  }
}

const params = parseUrlParams(window.location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x9fb8c8);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 1.7, 0);
camera.rotation.order = 'YXZ';
// yaw 0 = north (-z), clockwise; three's +y rotation is anticlockwise.
camera.rotation.y = -THREE.MathUtils.degToRad(params.yaw ?? 0);
camera.rotation.x = THREE.MathUtils.degToRad(params.pitch ?? 0);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2000),
  new THREE.MeshLambertMaterial({ color: 0x5c7a45 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(100, 200, 50);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.__game = { params, renderer, scene, camera };

let first = true;
function frame(): void {
  renderer.render(scene, camera);
  if (first) {
    first = false;
    window.__ready = true;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
