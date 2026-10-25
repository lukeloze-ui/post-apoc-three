import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/** Fixed July evening sun for now (the game clock comes later): WNW, 15 degrees up. */
const SUN_AZIMUTH_DEG = 292.5;
const SUN_ELEVATION_DEG = 15;

/** Linear fog: a hill 8 km away is hazed but clear, the 14 km diagonal is gone. */
const FOG_COLOR = 0xb3c3cf;
const FOG_NEAR = 500;
const FOG_FAR = 13000;

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  /**
   * Start the render loop. onFrame runs before each render with dt in seconds (renderer.info still holds the previous
   * frame's totals); onFirstFrame after the first render.
   */
  run(onFrame: (dt: number) => void, onFirstFrame: () => void): void;
}

export function createScene(parent: HTMLElement): GameScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  renderer.autoClear = false;
  // Count both passes (sky and world) per frame; run() resets the counters after onFrame.
  renderer.info.autoReset = false;
  parent.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 20000);
  camera.rotation.order = 'YXZ';

  const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  const el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
  const sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms as Record<string, THREE.IUniform>;
  (u.turbidity as THREE.IUniform).value = 6;
  (u.rayleigh as THREE.IUniform).value = 1.5;
  (u.mieCoefficient as THREE.IUniform).value = 0.005;
  (u.mieDirectionalG as THREE.IUniform).value = 0.8;
  (u.sunPosition as THREE.IUniform).value.copy(sunDir);
  // The sky has its own scene and an origin-locked camera, so world coordinates and the far plane never touch it.
  const skyScene = new THREE.Scene();
  // Turn the box off the compass diagonals: a box edge dead centre of the view renders flat triangles.
  sky.rotation.y = 0.3;
  skyScene.add(sky);
  const skyCamera = new THREE.PerspectiveCamera(camera.fov, camera.aspect, 1, 100000);

  const sun = new THREE.DirectionalLight(0xffe2b8, 5);
  sun.position.copy(sunDir).multiplyScalar(1000);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xa6c4e8, 0x6a6a50, 3));

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    skyCamera.aspect = camera.aspect;
    skyCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function run(onFrame: (dt: number) => void, onFirstFrame: () => void): void {
    let last = performance.now();
    let first = true;
    const frame = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      onFrame(dt);
      renderer.info.reset();
      skyCamera.quaternion.copy(camera.quaternion);
      renderer.clear();
      renderer.render(skyScene, skyCamera);
      renderer.clearDepth();
      renderer.render(scene, camera);
      if (first) {
        first = false;
        onFirstFrame();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  return { renderer, scene, camera, sun, run };
}
