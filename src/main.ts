import { parseUrlParams } from './urlParams';
import { createScene } from './render/scene';
import { Look } from './render/look';
import { FlyCamera } from './render/fly';
import { TerrainChunks } from './render/terrainChunks';
import { buildTerrainApron } from './render/terrainApron';
import { createBandColorFn, createDamageColorFn } from './render/terrainColor';
import { DistrictDamage } from './render/damage';
import { BlockerDamage } from './render/blockers';
import { GroundDetail } from './render/groundDetail';
import { renderLevelAt, setGroundLoaded, showsDamage } from './render/tileReveal';
import { buildLakeWater } from './render/lakeWater';
import { Linework } from './render/linework';
import { WoodsAndBuildings } from './render/woodsAndBuildings';
import { fetchFeatures } from './world/features';
import { GameClock, TIME_SCALE } from './sim/time';
import { sunPosition } from './sim/sun';
import { formatHours, legLabel } from './sim/naismith';
import { LegTracker } from './sim/legTracker';
import { fetchTerrain, heightAt, START } from './world/terrain';
import { createCraterModifier, createSurface, createTileCraters } from './world/surface';
import { fetchFlood } from './world/flood';
import { fetchLakes } from './world/lakes';
import { createOverheadView } from './ui/debug/overheadView';
import { registerDistrictLayers } from './ui/debug/districtLayers';
import { registerGroundLayer } from './ui/debug/groundLayers';
import { registerRouteLayers } from './ui/debug/routeLayer';
import { GroundCache, type GroundTile } from './world/ground';
import { findTarget, perform, promptText, type Target } from './sim/groundInteract';
import { GroundStreaming, tilesAround } from './world/groundStreaming';
import { tileId, tileOf } from './world/terrain';
import { fetchDistricts } from './world/districts';
import { osgbToLocal } from './world/geo';
import { createStatsReadout } from './ui/debug/stats';
import { clockLabel, createHud, createInteractHud } from './ui/hud';
import { NORMAL_FOV_DEG, RAISE_SEC, Scope, sensitivityScale } from './sim/scope';
import { createScopeOverlay } from './ui/scopeOverlay';
import { createPlayerHud } from './ui/playerHud';
import { createHazardHud } from './ui/hazardHud';
import { DeadBirds } from './render/deadBirds';
import { GAS_CUE_REACH_M } from './sim/hazards';
import { WalkKeys } from './ui/keys';
import { createPlayer } from './sim/player';
import { WalkLog } from './sim/walkLog';
import { createWalkWorld } from './sim/walkWorld';
import { buildDamageIndex, createDebrisIndex, gasNearby } from './world/conditions';
import { buildRoadIndex } from './world/roadIndex';
import { EYE_HEIGHT_M, HeadBob } from './render/headBob';
import { createPaperMap } from './ui/paperMap/paperMap';
import { prepareMapData } from './ui/paperMap/mapData';
import { Marks, type Leg } from './ui/paperMap/marks';
import { createPackScreen } from './ui/packScreen';
import { addToGround, applyDeltas, emptyGroundDeltas, registerGroundSection } from './save/groundDeltas';
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
  // The hidden district damage: craters carve the ground everyone walks on; the renderer shows the rest by tile.
  const districts = await fetchDistricts('/world/', features);
  const craters = districts.tiles.flatMap((t) => t.craters);
  const strikeZones = districts.tiles.flatMap((t) => t.strikeZones);

  // ?fresh=1 skips loading. The URL's position, facing and time win over the save.
  const save = new SaveGame({ fresh: params.fresh });
  const saved = parsePlayerSave(save.peek('player'));
  const clock = new GameClock(params.t ?? parseClockSave(save.peek('clock')));
  const hud = createHud();
  const gs = createScene(document.body);
  let sunAltitude = 0;
  const updateSky = (): void => {
    const sun = sunPosition(clock.utcMs);
    sunAltitude = sun.altitude;
    gs.setSun(sun.altitude, sun.azimuth);
    hud.update(clockLabel(clock.day, clock.hh, clock.mm));
  };
  updateSky();
  const craterMod = createCraterModifier(craters);
  const tileCraters = createTileCraters();
  const surface = createSurface(terrain, craterMod ? [craterMod, tileCraters] : [tileCraters]);
  const plainSurface = createSurface(terrain);

  const start =
    params.e !== undefined && params.n !== undefined
      ? osgbToLocal(params.e, params.n)
      : saved
        ? { x: saved.x, y: saved.y }
        : { x: START.x, y: START.y };
  const bandColorFn = createBandColorFn(terrain, flood);
  const colorFn = createDamageColorFn(bandColorFn, craters, strikeZones, districts.tiles.flatMap((t) => t.landslips), districts.tiles.flatMap((t) => t.siltFlats));
  const chunks = new TerrainChunks(surface, {
    colorFn,
    surfaceFor: (x0, y0) => (showsDamage(renderLevelAt(x0 + 1, y0 + 1)) ? surface : plainSurface),
  });
  chunks.buildAll(start.x, start.y);
  const linework = new Linework(surface, features, flood, { districts, plainSurface });
  const damage = new DistrictDamage(surface, features, districts);
  const blockers = new BlockerDamage(surface, features, districts);
  const deadBirds = new DeadBirds(surface, districts);
  const woodsAndBuildings = new WoodsAndBuildings(surface, features, flood);
  woodsAndBuildings.buildAll(start.x, start.y);
  gs.scene.add(
    chunks.group,
    buildTerrainApron(surface, bandColorFn),
    buildLakeWater(lakes, clock.gameDays),
    linework.group,
    woodsAndBuildings.group,
    damage.group,
    blockers.group,
    deadBirds.group,
  );

  // Ground detail: the 3x3 tiles round the player (and any the scope asks for), on top of the saved changes.
  const groundCache = new GroundCache();
  const groundDeltas = emptyGroundDeltas();
  registerGroundSection(save, groundDeltas);
  const groundStreaming = new GroundStreaming();
  const groundDetail = new GroundDetail(surface);
  const debris = createDebrisIndex();
  gs.scene.add(groundDetail.group);
  const groundFailed = new Set<string>();
  /** The loaded tiles as they are in the files; the player's changes are in groundDeltas. */
  const baseTiles = new Map<string, GroundTile>();
  let groundBusy = false;
  const tileKey = (x: number, y: number): string => {
    const t = tileOf(x, y);
    return `${t.i},${t.j}`;
  };
  let groundAt = tileKey(start.x, start.y);
  const syncGround = async (x: number, y: number): Promise<void> => {
    groundBusy = true;
    try {
      const want = groundStreaming.wanted(x, y, performance.now());
      const have = new Set(groundDetail.loaded);
      const fetched = await Promise.all(
        want
          .filter((t) => !have.has(t) && !groundFailed.has(t))
          .map(async (t) => {
            try {
              return await groundCache.get(t);
            } catch (err) {
              groundFailed.add(t);
              console.warn(`ground ${t} did not load`, err);
              return undefined;
            }
          }),
      );
      // The small craters go in first, so the debris sits on the carved ground; then the near chunks rebuild.
      for (const tile of fetched) {
        if (!tile) continue;
        baseTiles.set(tile.tile, tile);
        const loaded = applyDeltas(tile, groundDeltas);
        const spots = loaded.objects.filter((o) => o.kind === 'crater').map((o) => ({ x: o.x, y: o.y, r: o.size / 2 }));
        const changed = tileCraters.setTile(loaded.tile, spots);
        groundDetail.setTile(loaded);
        debris.setTile(loaded.tile, loaded.objects);
        if (changed) chunks.invalidate(changed);
      }
      const keep = new Set(want);
      for (const id of groundDetail.loaded) {
        if (keep.has(id)) continue;
        groundDetail.unloadTile(id);
        debris.removeTile(id);
        baseTiles.delete(id);
        const changed = tileCraters.removeTile(id);
        if (changed) chunks.invalidate(changed);
      }
      setGroundLoaded(groundDetail.loaded);
    } finally {
      groundBusy = false;
    }
  };
  await syncGround(start.x, start.y);
  const look = new Look(gs.renderer.domElement, params.yaw ?? saved?.yaw ?? START.yaw, params.pitch ?? 0);
  const damageIndex = buildDamageIndex(districts, features.woods, terrain.meta.cellM);
  const walkWorld = createWalkWorld({
    surface,
    roads: buildRoadIndex(features.roads),
    lakes,
    gameDays: () => clock.gameDays,
    damage: damageIndex,
    debris,
    sunAltitude: () => sunAltitude,
  });
  const player = createPlayer(start.x, start.y, look.yaw, walkWorld);
  const walkLog = new WalkLog();
  const keys = new WalkKeys();
  const bob = new HeadBob();
  const playerHud = params.fly ? null : createPlayerHud();
  const hazardHud = params.fly ? null : createHazardHud();
  // The scope: hold right mouse or B for the binoculars, R toggles a sighted rifle. The reveal reads scope.scoped.
  const scope = new Scope(player.party.pack);
  const scopeOverlay = createScopeOverlay();
  let rightDown = false;
  let bDown = false;
  const syncBinoculars = (): void => scope.setBinoculars(rightDown || bDown);
  window.addEventListener('contextmenu', (ev) => ev.preventDefault());
  window.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) {
      rightDown = true;
      syncBinoculars();
    }
  });
  window.addEventListener('mouseup', (ev) => {
    if (ev.button === 2) {
      rightDown = false;
      syncBinoculars();
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyB') bDown = true;
    else if (ev.code === 'KeyR' && !ev.repeat) scope.toggleRifle();
    else return;
    syncBinoculars();
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code !== 'KeyB') return;
    bDown = false;
    syncBinoculars();
  });
  window.addEventListener('blur', () => {
    rightDown = false;
    bDown = false;
    syncBinoculars();
  });
  if (params.scope) {
    rightDown = true;
    syncBinoculars();
    scope.update(RAISE_SEC);
  }
  // E searches, digs or forces what the player is looking at; the changes go into groundDeltas, then the tile is redrawn.
  const interactHud = createInteractHud();
  let target: Target | undefined;
  let pressedE = false;
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyE' && !ev.repeat) pressedE = true;
  });
  const interact = (): void => {
    if (!target || player.resting) return;
    const done = perform(target, groundDeltas, player.party, player.walk);
    clock.advance(done.minutes * 60);
    interactHud.showResult(done.lines, performance.now());
    const base = baseTiles.get(target.tile.tile);
    if (base) groundDetail.setTile(applyDeltas(base, groundDeltas));
    save.markDirty();
  };
  // World frame: x east, z = -north, y up.
  gs.camera.position.set(start.x, player.z + EYE_HEIGHT_M, -start.y);
  // The dev fly camera replaces walking with ?fly=1.
  const fly = params.fly ? new FlyCamera(look) : null;

  // Dev tool: only in dev builds or with ?view=debug. The hidden district damage is shown only here.
  const wantDebug = import.meta.env.DEV || params.view === 'debug';
  if (wantDebug) {
    registerDistrictLayers(districts, features);
    registerRouteLayers(districts, features);
  }
  const groundLayer = wantDebug ? registerGroundLayer(groundCache) : null;
  const debugView = wantDebug
    ? createOverheadView({ terrain, flood, lakes, gameDay: clock.gameDays }, () => ({
        x: gs.camera.position.x,
        y: -gs.camera.position.z,
        yaw: look.yaw,
      }))
    : null;
  if (debugView) {
    if (params.view === 'debug') {
      debugView.setVisible(true);
      // Opened on a place: centre there and load its ground debris before the first frame (for screenshots).
      if (params.e !== undefined && params.n !== undefined) {
        debugView.lookAt(start.x, start.y, params.zoom ?? 1);
        await groundLayer?.load(tilesAround(start.x, start.y));
      }
    }
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

  // The pack screen (Tab) pauses walking and the clock like the map. A dropped item becomes an added object
  // in the player's ground tile, kind `drop:<itemId>` with the quantity in `extra`, so it can be picked up later.
  const packScreen = createPackScreen({
    party: player.party,
    onDrop: (itemId, qty) => {
      const t = tileOf(player.x, player.y);
      const id = tileId(t.i, t.j);
      addToGround(groundDeltas, id, { kind: `drop:${itemId}`, x: player.x, y: player.y, rot: 0, size: 0.5, extra: qty });
      const base = baseTiles.get(id);
      if (base) groundDetail.setTile(applyDeltas(base, groundDeltas));
      save.markDirty();
    },
    onChange: () => save.markDirty(),
  });
  if (params.view === 'pack') packScreen.setVisible(true);

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
        extra: [chunks.pending > 0 ? `${chunks.pending} chunks queued` : '', `${groundDetail.batchCount} ground batches`].filter(Boolean).join(', '),
      }))
    : null;

  window.__game = { params, clock, player, walkLog, terrain, surface, chunks, linework, woodsAndBuildings, damage, groundDetail, districts, look, scope, ...gs };

  gs.run(
    (dt) => {
      if (paperMap.visible || packScreen.visible) {
        pressedE = false;
        scope.update(-1);
        scopeOverlay.update(null, 0);
        gs.camera.fov = NORMAL_FOV_DEG;
        gs.camera.updateProjectionMatrix();
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
        hazardHud?.update(player, gasNearby(damageIndex, player.x, player.y, clock.gameDays, GAS_CUE_REACH_M), performance.now());
        if (pressedE) interact();
        pressedE = false;
        target = findTarget([...baseTiles.values()], groundDeltas, player.party, player.x, player.y, look.yaw);
        interactHud.setPrompt(target ? promptText(target) : '');
        interactHud.tick(performance.now());
      }
      updateSky();
      scope.update(dt);
      player.extraPace = scope.pace;
      look.sensitivityScale = sensitivityScale(scope.fov);
      if (gs.camera.fov !== scope.fov) {
        gs.camera.fov = scope.fov;
        gs.camera.updateProjectionMatrix();
      }
      scopeOverlay.update(scope.visibleKind, scope.raise);
      look.apply(gs.camera);
      chunks.update(gs.camera.position.x, -gs.camera.position.z);
      linework.update(gs.camera.position.x, -gs.camera.position.z);
      woodsAndBuildings.update(gs.camera.position.x, -gs.camera.position.z);
      blockers.update(gs.camera);
      damage.update(gs.camera, clock.gameDays, sunAltitude, performance.now() / 1000);
      deadBirds.update(clock.gameDays);
      const hereKey = tileKey(gs.camera.position.x, -gs.camera.position.z);
      if (!groundBusy && hereKey !== groundAt) {
        groundAt = hereKey;
        void syncGround(gs.camera.position.x, -gs.camera.position.z);
      }
      groundDetail.update(gs.camera);
      stats?.update(dt);
      if (debugView?.visible) debugView.redraw();
    },
    () => {
      window.__ready = true;
    },
  );
}

void main();
