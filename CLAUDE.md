# High Water Mark

A first-person survival game set in a flooded Okehampton, Devon, in real OSGB coordinates. Built with TypeScript, Three.js and Vite. Tests use Vitest. Node build scripts run with tsx. Screenshots use playwright-core with the installed Microsoft Edge.

## Reading the spec

`game-spec.txt` is the design. It is long: read only the sections your task names, never the whole file.

## Folder layout

| Path | Contents | Rules |
| --- | --- | --- |
| `src/world/` | World data types, loaders, pure queries | No `three`, no DOM |
| `src/sim/` | Time, walking, survival | No `three`, no DOM |
| `src/ui/` | Paper map, HUD, menus | DOM and Canvas2D |
| `src/render/` | All Three.js code | |
| `src/save/` | The save game | |
| `src/main.ts` | Entry point | |
| `src/urlParams.ts` | Debug URL param parsing | |
| `Tools/worldgen/` | Node build scripts (TypeScript, run with tsx) | May import pure code from `src/world` and `src/sim` |
| `Tools/screenshot.ts` | Screenshot runner | |
| `public/world/` | Committed world data | Vite serves it, the game fetches it, tests read it with fs |

**No-three rule:** nothing under `src/sim` or `src/world` may import `three` or use `window` or `document`. `src/arch.test.ts` enforces this.

Tests sit beside the code as `*.test.ts`. The vitest include covers `src/**` and `Tools/worldgen/**`.

**Capital T:** the folder is `Tools/` (capital T). Windows paths are case-insensitive, but git paths are not. Write `Tools/worldgen` everywhere (package.json, imports, docs). `Tools/features/` and the gitignored `Tools/batch-logs/` belong to the batch runner; leave them alone, along with `claude-batch.ps1`.

## World data and worldgen

World data lives in `public/world/`, committed.

Worldgen has two stages:

- `npm run worldgen:import` reads raw downloads from the gitignored `Tools/worldgen/raw/` and writes the base terrain and features.
- `npm run worldgen` derives everything else from the committed base data. It is deterministic: re-running gives byte-identical output.

**RNG rule:** the only RNG is `mulberry32` (`Tools/worldgen/rng.ts`), and only inside `Tools/worldgen`. Each build step makes its own generator from a fixed per-step seed constant, so changing one step never reshuffles another. Code under `src/` never uses `Math.random` for world content.

**Districts** (`public/world/districts.json`, types, validator and loader in `src/world/districts.ts`, built by `Tools/worldgen/steps/districts.ts`): the hidden 1 km damage layer, loaded but never shown to the player. The header holds `storm` (worst side, centre) and `survivors` (hand-picked bridges), both copied from `Tools/worldgen/decisions.ts`. `bridges[]` are the features.json bridges (`br-…`) plus unrecorded road/rail crossings of rivers and streams (`xb-…`), each with `deckH`, `hwAt`, `depthBelowMark`, `standing` and `reason`. `roadSegments[]` split every road at tile edges and junctions into pieces of at most 250 m, with `tile`, `inWood`, `band`, `blocked` and `cause`. `tiles[100]` (row-major, `j * 10 + i`) hold `craters`, `strikeZones`, `fires`, `gasHollows`, `animals`, `pocked`, `wrackDams`, `landslips` (rings), `siltFlats` (rings, each with `softPatches`) and `fallenWood` (wood ids), the last four made by `Tools/worldgen/steps/blockers.ts`. `validateDistricts` returns a list of errors; the file has one array element per line.

## URL params

Parsed by `src/urlParams.ts`:

- `e`, `n`: OSGB metres (easting, northing).
- `yaw`, `pitch`: degrees. Yaw 0 is north, clockwise.
- `t`: game time, e.g. `d1-07:00`.
- `view`: `fp`, `debug` or `map`. `view=debug` opens the overhead debug view (`src/ui/debug/overheadView.ts`), a dev tool available only when `import.meta.env.DEV` is true or with `?view=debug`. **F2** toggles it. Wheel zooms, drag pans; layers register with `registerDebugLayer`. With `e` and `n` it opens centred there at `zoom` pixels per metre (default 1); the ground debris layer (`groundLayers.ts`) draws from 0.4 px/m in.
- `view=map` opens the paper map (`src/ui/paperMap/`), toggled in play with **M** (Esc closes). It draws only pre-disaster terrain heights and `features.json`, never flood, bands, lakes, districts or ground (`paperMap.test.ts` checks imports), and never marks the player's position. **While the map is open the player cannot walk and the clock is paused** (a design choice: reading the map costs no game time). The `setMarksLayer` slot on the map is for the pencil layer.
- `fly=1`: dev fly camera.
- `fresh=1`: ignore the save.

`main.ts` sets `window.__ready = true` after the first frame has rendered with data loaded, and exposes `window.__game` as a dev handle.

## Commands

- `npm run dev`: Vite dev server.
- `npm run build`: `tsc --noEmit`, then `vite build`.
- `npm test`: `vitest run`.
- `npm run worldgen` and `npm run worldgen:import`: see above.

## Screenshots

```
npm run shot -- '?view=fp&e=260000&n=95000' shots/name.png
```

This starts a Vite dev server on a free port, opens the page in headless Edge (swiftshader, 1280x720), waits up to 60 s for `window.__ready`, saves the PNG and exits. `shots/` is gitignored. To view the result, open the PNG with the Read tool; it displays images.
