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

## OpenStreetMap (features and landcover)

`import/osm.ts` runs after the Terrain 50 step (it reads the real heights) and overwrites `features.json` and `landcover.bin`. If Overpass cannot be reached it warns and the synthetic features and landcover stay.

1. The WGS84 bbox is the patch's four corners (inverse of `src/world/geo.ts`) plus 0.003 degrees. It POSTs one Overpass query to <https://overpass-api.de/api/interpreter> (falling back to overpass.kumi.systems):
   `way[highway]`, `way[railway]`, `way[disused:railway]`, `way[abandoned:railway]`, `way[waterway=river|stream|riverbank|dam]`, `nwr[natural=wood|scrub|heath|wetland|water|bare_rock|scree|grassland|fell|moor|peak|rock]`, `nwr[landuse]`, `nwr[building]`, `nwr[amenity=pub|bar|restaurant|cafe|school|college|kindergarten|place_of_worship|hotel]`, `nwr[shop]`, `nwr[military]`, `way[barrier=hedge|hedge_bank|wall|fence]`, `way[bridge]`, `node[place]`, `node[railway=station|halt]`, all with `out geom qt;`. See `buildQuery`.
2. The raw response is saved as `raw/osm/overpass.json` (gitignored, untrusted: validated field by field, only read as data). If that file exists it is reused, so re-runs are offline and byte-identical. Delete it to refresh from OSM.
3. Points are projected to local metres. Lines are clipped to the patch and simplified with Douglas-Peucker at 2 m; polygons are clipped (Sutherland-Hodgman) and simplified at 2 m, buildings at 0.4 m and dropped if any vertex is outside. Multipolygon relations use their stitched outer rings; holes are ignored. Coordinates are rounded to 0.1 m. Feature ids are OSM ids (`w123`, `r45`).
4. Tag mapping: highway trunk/primary to `A`, secondary to `B`, tertiary/unclassified/residential/service/living_street to `minor`, track to `track`, path/footway/bridleway/cycleway/steps/pedestrian to `path`. Railways are `active`, `disused` or `abandoned`. `barrier=hedge|hedge_bank` is `hedgebank`, `wall` is `wall`, `fence` is `fence`. Building type comes from `building=*`, `amenity`, `shop`, and a camp-sized `landuse=military` zone (under 2 km2, so the Dartmoor firing ranges do not turn every moor building military); plain `building=yes` under 250 m2 is a `house`, otherwise `other`.
5. Bridges are any `highway` or `railway` way with `bridge` set (not `no`), one entry per way: midpoint, length, `refId` of the road or rail feature, and `crosses` (id of the river or stream it intersects, or ends within 15 m of) with `crossesName`. `major` is set for A/B roads and rail over a `river`, and for anything named like a viaduct. The Meldon Viaduct appears twice, as the rail line and as the Granite Way path on top of it.
6. `landcover.bin` starts as moor grass above 300 m and field below, then paints polygons in this order: farmland/meadow/grass to field, grassland/fell to moor grass, heath to heather, scrub (heather above 300 m, wood below), wetland to bog, wood/forest to wood, bare rock/scree to rock, quarry, residential/industrial/commercial to built-up, water. A cell with three or more buildings is built-up unless it is water. Cells are tested at their centre; rivers (lines) are not painted as water.
7. The POI list starts with the target railway (from `START`), then tors/peaks, stations, quarries, the camp and dams. `features.json` must stay under about 1.5 MB (`features.test.ts` checks it); the licence line (ODbL) is in its `attribution` field.
