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
import { formatHours, legLabel } from './sim/naismith';
import { LegTracker } from './sim/legTracker';
import { fetchTerrain, heightAt, START } from './world/terrain';
import { createSurface } from './world/surface';
import { fetchFlood } from './world/flood';
import { fetchLakes } from './world/lakes';
import { createOverheadView } from './ui/debug/overheadView';
import { osgbToLocal } from './world/geo';
import { createStatsReadout } from './ui/debug/stats';
import { clockLabel, createHud } from './ui/hud';
import { createPlayerHud } from './ui/playerHud';
import { WalkKeys } from './ui/keys';
import { createPlayer } from './sim/player';
import { WalkLog } from './sim/walkLog';
import { createWalkWorld } from './sim/walkWorld';
import { buildRoadIndex } from './world/roadIndex';
import { EYE_HEIGHT_M, HeadBob } from './render/headBob';
import { createPaperMap } from './ui/paperMap/paperMap';
import { prepareMapData } from './ui/paperMap/mapData';
import { Marks, type Leg } from './ui/paperMap/marks';
import { SaveGame, parseClockSave, parsePlayerSave, registerCoreSections } from './save/save';

declare global {
  interface Window {
    __ready?: boolean;
    __game?: unknown;
  }
}

async function main(): Promise<void> {
  const params = parseUrlParams(window.location.search);
  const terrain = await fetchTerrain();
  const [flood, lakes, features] = await Promise.all([
    fetchFlood('/world/', terrain),
    fetchLakes('/world/', terrain),
    fetchFeatures(),
  ]);

  // ?fresh=1 skips loading. The URL's position, facing and time win over the save.
  const save = new SaveGame({ fresh: params.fresh });
  const saved = parsePlayerSave(save.peek('player'));
  const clock = new GameClock(params.t ?? parseClockSave(save.peek('clock')));
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
    params.e !== undefined && params.n !== undefined
      ? osgbToLocal(params.e, params.n)
      : saved
        ? { x: saved.x, y: saved.y }
        : { x: START.x, y: START.y };
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
  const look = new Look(gs.renderer.domElement, params.yaw ?? saved?.yaw ?? START.yaw, params.pitch ?? 0);
  const walkWorld = createWalkWorld({ surface, roads: buildRoadIndex(features.roads), lakes, gameDays: () => clock.gameDays });
  const player = createPlayer(start.x, start.y, look.yaw, walkWorld);
  const walkLog = new WalkLog();
  const keys = new WalkKeys();
  const bob = new HeadBob();
  const playerHud = params.fly ? null : createPlayerHud();
  // World frame: x east, z = -north, y up.
  gs.camera.position.set(start.x, player.z + EYE_HEIGHT_M, -start.y);
  // The dev fly camera replaces walking with ?fly=1.
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

  // The paper map shows the world as it was: terrain and features only. While it is open the player
  // cannot walk and the clock is paused. It opens centred on the patch, never on the player.
  const explicitView = params.e !== undefined && params.n !== undefined;
  const marks = new Marks();
  const legTracker = new LegTracker();
  const paperMap = createPaperMap(prepareMapData(terrain, features), {
    marks,
    legLabel: (pts) => legLabel(pts, (x, y) => heightAt(terrain, x, y), player.party),
    legReal: (id) => {
      const min = legTracker.realMinutes(id);
      return min === undefined ? undefined : formatHours(min / 60);
    },
    centre: explicitView ? start : undefined,
    scale: explicitView ? 0.25 : undefined,
  });
  if (params.view === 'map') paperMap.setVisible(true);

  // The dev fly camera does not move the player, so it keeps its own hands off the saved position.
  if (!fly) {
    registerCoreSections(save, {
      player,
      clock,
      pack: player.party.pack,
      overridden: { player: explicitView || params.yaw !== undefined, clock: params.t !== undefined },
    });
  }
  save.registerSection('marks', () => marks.serialize(), (d) => marks.load(d));
  marks.subscribe(() => save.markDirty());
  save.registerSection('legTimes', () => legTracker.serialize(), (d) => legTracker.load(d));
  legTracker.subscribe(() => save.markDirty());
  if (!fly) {
    save.start();
    window.addEventListener('pagehide', () => save.save());
  }

  const stats = params.stats
    ? createStatsReadout(() => ({
        calls: gs.renderer.info.render.calls,
        triangles: gs.renderer.info.render.triangles,
        extra: chunks.pending > 0 ? `${chunks.pending} chunks queued` : undefined,
      }))
    : null;

  window.__game = { params, clock, player, walkLog, terrain, surface, chunks, linework, woodsAndBuildings, look, ...gs };

  gs.run(
    (dt) => {
      if (paperMap.visible) {
        look.apply(gs.camera);
        return;
      }
      if (fly) {
        clock.advance(dt * TIME_SCALE);
        fly.update(gs.camera, dt);
      } else {
        // Modelled speed times TIME_SCALE on screen; the clock advances at the same scale, so game time per metre matches.
        player.yaw = look.yaw;
        clock.advance(player.step(dt * TIME_SCALE, keys.read(), walkWorld));
        if (walkLog.record(clock.minutes, player.x, player.y)) {
          legTracker.update(
            walkLog.entries,
            marks.all.filter((m): m is Leg => m.kind === 'leg'),
          );
        }
        gs.camera.position.set(player.x, player.z + EYE_HEIGHT_M + bob.update(dt, player.movedMs), -player.y);
        playerHud?.update(player);
      }
      updateSky();
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
