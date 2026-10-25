# Worldgen

Two stages (see CLAUDE.md): `npm run worldgen:import` reads raw downloads from the gitignored `Tools/worldgen/raw/`, then `npm run worldgen` derives everything else from the committed data in `public/world/`.

## OS Terrain 50 (heights)

`import/terrain50.ts` downloads, extracts and resamples the heights automatically. It runs after the synthetic step and overwrites `terrain.json` and `terrain.bin`. If it fails it warns and the synthetic heights stay.

To do it by hand (or if the automatic download fails):

1. Open <https://api.os.uk/downloads/v1/products/Terrain50/downloads> (OpenData, no key needed). Pick the entry with format `ASCII Grid and GML (Grid)`, area `GB`, file `terr50_gagg_gb.zip` (about 160 MB), and note its `md5`.
2. Save it as `Tools/worldgen/raw/terrain50/terr50_gagg_gb.zip`. The folder must be new and contain only that zip. Check the MD5 matches the listing.
3. Run `npm run worldgen:import`. It extracts only `data/sx/sx58_*`, `sx59`, `sx68` and `sx69` with `tar.exe` into `raw/terrain50/gb/`, extracts each square's zip into `raw/terrain50/squares/<square>/`, and parses only the `.asc` as text.
4. To redo the import from scratch, delete `raw/terrain50/gb` and `raw/terrain50/squares` (keep or delete the zip).

How the grid maps on: the `.asc` files have `xllcorner` on 10 km multiples and `cellsize` 50, so by the ESRI convention each value sits at a cell centre, 25 m inside the corner. Our posts sit on 50 m multiples, so each post is the bilinear average of the four surrounding values. The output is Int16 decimetres, 201 x 201 posts from the patch SW corner (row 0 = south).

Outputs: `terrain.json` with `source` `OS Terrain 50 (<release date>)` and an `attribution` line (`Contains OS data (c) Crown copyright and database right <year>`), and `terrain.bin`. Commit only these, never anything under `raw/`.

`landcover.bin` and `features.json` are still the synthetic stand-in until the OSM import replaces them.
