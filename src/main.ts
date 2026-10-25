import { parseUrlParams } from './urlParams';
import { createScene } from './render/scene';
import { Look } from './render/look';
import { FlyCamera } from './render/fly';
import { buildTerrainMesh } from './render/terrainMesh';
import { fetchTerrain, heightAt, START } from './world/terrain';
import { fetchFlood } from './world/flood';
import { fetchLakes } from './world/lakes';
import { DEFAULT_GAME_DAY, createOverheadView } from './ui/debug/overheadView';
import { osgbToLocal } from './world/geo';

declare global {
  interface Window {
    __ready?: boolean;
    __game?: unknown;
  }
}

const EYE_HEIGHT = 1.65;

async function main(): Promise<void> {
  const params = parseUrlParams(window.location.search);
  const terrain = await fetchTerrain();
  const [flood, lakes] = await Promise.all([fetchFlood('/world/', terrain), fetchLakes('/world/', terrain)]);

  const gs = createScene(document.body);
  gs.scene.add(buildTerrainMesh(terrain));

  const start =
    params.e !== undefined && params.n !== undefined ? osgbToLocal(params.e, params.n) : { x: START.x, y: START.y };
  const look = new Look(gs.renderer.domElement, params.yaw ?? START.yaw, params.pitch ?? 0);
  // World frame: x east, z = -north, y up.
  gs.camera.position.set(start.x, heightAt(terrain, start.x, start.y) + EYE_HEIGHT, -start.y);
  const fly = params.fly ? new FlyCamera(look) : null;

  // Dev tool: only in dev builds or with ?view=debug.
  const debugView =
    import.meta.env.DEV || params.view === 'debug'
      ? createOverheadView({ terrain, flood, lakes, gameDay: DEFAULT_GAME_DAY }, () => ({
          x: gs.camera.position.x,
          y: -gs.camera.position.z,
          yaw: look.yaw,
        }))
      : null;
  if (debugView) {
    if (params.view === 'debug') debugView.setVisible(true);
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'F2') return;
      ev.preventDefault();
      debugView.toggle();
    });
  }

  window.__game = { params, terrain, look, ...gs };

  gs.run(
    (dt) => {
      fly?.update(gs.camera, dt);
      look.apply(gs.camera);
      if (debugView?.visible) debugView.redraw();
    },
    () => {
      window.__ready = true;
    },
  );
}

void main();
