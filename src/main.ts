import { parseUrlParams } from './urlParams';
import { createScene } from './render/scene';
import { Look } from './render/look';
import { FlyCamera } from './render/fly';
import { TerrainChunks } from './render/terrainChunks';
import { buildTerrainApron } from './render/terrainApron';
import { createBandColorFn } from './render/terrainColor';
import { buildLakeWater } from './render/lakeWater';
import { Linework } from './render/linework';
import { WoodsAndBuildings } from './render/woodsAndBuildings';
import { fetchFeatures } from './world/features';
import { GameClock, TIME_SCALE } from './sim/time';
import { sunPosition } from './sim/sun';
import { fetchTerrain, START } from './world/terrain';
import { createSurface, surfaceHeight } from './world/surface';
import { fetchFlood } from './world/flood';
import { fetchLakes } from './world/lakes';
import { createOverheadView } from './ui/debug/overheadView';
import { osgbToLocal } from './world/geo';
import { createStatsReadout } from './ui/debug/stats';
import { clockLabel, createHud } from './ui/hud';

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
  const [flood, lakes, features] = await Promise.all([
    fetchFlood('/world/', terrain),
    fetchLakes('/world/', terrain),
    fetchFeatures(),
  ]);

  const clock = new GameClock(params.t);
  const hud = createHud();
  const gs = createScene(document.body);
  const updateSky = (): void => {
    const sun = sunPosition(clock.utcMs);
    gs.setSun(sun.altitude, sun.azimuth);
    hud.update(clockLabel(clock.day, clock.hh, clock.mm));
  };
  updateSky();
  const surface = createSurface(terrain);

  const start =
    params.e !== undefined && params.n !== undefined ? osgbToLocal(params.e, params.n) : { x: START.x, y: START.y };
  const colorFn = createBandColorFn(terrain, flood);
  const chunks = new TerrainChunks(surface, { colorFn });
  chunks.buildAll(start.x, start.y);
  const linework = new Linework(surface, features, flood);
  const woodsAndBuildings = new WoodsAndBuildings(surface, features, flood);
  woodsAndBuildings.buildAll(start.x, start.y);
  gs.scene.add(
    chunks.group,
    buildTerrainApron(surface, colorFn),
    buildLakeWater(lakes, clock.gameDays),
    linework.group,
    woodsAndBuildings.group,
  );
  const look = new Look(gs.renderer.domElement, params.yaw ?? START.yaw, params.pitch ?? 0);
  // World frame: x east, z = -north, y up.
  gs.camera.position.set(start.x, surfaceHeight(surface, start.x, start.y) + EYE_HEIGHT, -start.y);
  const fly = params.fly ? new FlyCamera(look) : null;

  // Dev tool: only in dev builds or with ?view=debug.
  const debugView =
    import.meta.env.DEV || params.view === 'debug'
      ? createOverheadView({ terrain, flood, lakes, gameDay: clock.gameDays }, () => ({
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

  const stats = params.stats
    ? createStatsReadout(() => ({
        calls: gs.renderer.info.render.calls,
        triangles: gs.renderer.info.render.triangles,
        extra: chunks.pending > 0 ? `${chunks.pending} chunks queued` : undefined,
      }))
    : null;

  window.__game = { params, clock, terrain, surface, chunks, linework, woodsAndBuildings, look, ...gs };

  gs.run(
    (dt) => {
      clock.advance(dt * TIME_SCALE);
      updateSky();
      fly?.update(gs.camera, dt);
      look.apply(gs.camera);
      chunks.update(gs.camera.position.x, -gs.camera.position.z);
      linework.update(gs.camera.position.x, -gs.camera.position.z);
      woodsAndBuildings.update(gs.camera.position.x, -gs.camera.position.z);
      stats?.update(dt);
      if (debugView?.visible) debugView.redraw();
    },
    () => {
      window.__ready = true;
    },
  );
}

void main();
