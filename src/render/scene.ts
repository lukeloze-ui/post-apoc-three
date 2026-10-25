import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { daylightAt, newDaylight } from './daylight';

/** Linear fog: a hill 8 km away is hazed but clear, the 14 km diagonal is gone. */
const FOG_COLOR = 0xb3c3cf;
const FOG_NEAR = 500;
const FOG_FAR = 13000;

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  /** Point the sky, lights and fog at a sun position (degrees; azimuth clockwise from north). Call whenever the clock moves. */
  setSun(altitude: number, azimuth: number): void;
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

  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms as Record<string, THREE.IUniform>;
  (u.turbidity as THREE.IUniform).value = 6;
  (u.rayleigh as THREE.IUniform).value = 1.5;
  (u.mieCoefficient as THREE.IUniform).value = 0.005;
  (u.mieDirectionalG as THREE.IUniform).value = 0.8;
  // The sky has its own scene and an origin-locked camera, so world coordinates and the far plane never touch it.
  const skyScene = new THREE.Scene();
  // Turn the box off the compass diagonals: a box edge dead centre of the view renders flat triangles.
  sky.rotation.y = 0.3;
  skyScene.add(sky);
  const stars = buildStars();
  skyScene.add(stars);
  const skyCamera = new THREE.PerspectiveCamera(camera.fov, camera.aspect, 1, 100000);

  const sun = new THREE.DirectionalLight(0xffe2b8, 5);
  scene.add(sun);
  // Faint blue moonlight from a fixed side, so night terrain keeps some relief.
  const moon = new THREE.DirectionalLight(0x4a5c98, 0);
  scene.add(moon);
  const hemi = new THREE.HemisphereLight(0xa6c4e8, 0x6a6a50, 3);
  scene.add(hemi);
  const light = newDaylight();
  const sunDir = new THREE.Vector3();

  function setSun(altitude: number, azimuth: number): void {
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(altitude);
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    (u.sunPosition as THREE.IUniform).value.copy(sunDir);
    daylightAt(altitude, light);
    // The sun light never shines from below the horizon: its own direction stays at least 2 degrees up.
    const le = THREE.MathUtils.degToRad(Math.max(altitude, 2));
    sun.position.set(Math.sin(az) * Math.cos(le), Math.sin(le), -Math.cos(az) * Math.cos(le)).multiplyScalar(1000);
    sun.color.copy(light.sunColor);
    sun.intensity = light.sunIntensity;
    const maz = az + Math.PI;
    moon.position.set(Math.sin(maz) * 0.7, 0.7, -Math.cos(maz) * 0.7).multiplyScalar(1000);
    moon.intensity = 1.2 * light.night;
    hemi.color.copy(light.hemiSky);
    hemi.groundColor.copy(light.hemiGround);
    hemi.intensity = light.hemiIntensity;
    (scene.fog as THREE.Fog).color.copy(light.fog);
    renderer.toneMappingExposure = light.exposure;
    (stars.material as THREE.PointsMaterial).opacity = light.night;
    stars.visible = light.night > 0;
  }
  setSun(15, 292.5);

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
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
      last = now;
      onFrame(dt);
      renderer.info.reset();
      skyCamera.quaternion.copy(camera.quaternion);
      if (skyCamera.fov !== camera.fov) {
        skyCamera.fov = camera.fov;
        skyCamera.updateProjectionMatrix();
      }
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

  return { renderer, scene, camera, sun, setSun, run };
}

/** A fixed scatter of faint stars on a big sphere, drawn with the sky; opacity follows the darkness. */
function buildStars(): THREE.Points {
  const count = 700;
  const pos = new Float32Array(count * 3);
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const y = rnd() * 0.96 + 0.04; // upper hemisphere only
    const phi = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(phi) * r * 50000;
    pos[i * 3 + 1] = y * 50000;
    pos[i * 3 + 2] = Math.sin(phi) * r * 50000;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xdde6ff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const stars = new THREE.Points(geo, mat);
  stars.frustumCulled = false;
  return stars;
}
