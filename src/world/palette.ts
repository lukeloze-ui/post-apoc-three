// Ground and water colours, as sRGB hex numbers. Shared by the terrain renderer and anything else that draws the
// ground (debug view, paper map). Pure data: no three, no DOM.
import { LandCover } from './terrain';

/** Ground above the mark, by landcover code. */
export const LANDCOVER_COLORS: Readonly<Record<number, number>> = {
  [LandCover.MoorGrass]: 0x83844a,
  [LandCover.Heather]: 0x6e5a55,
  [LandCover.Bog]: 0x3f3d2a,
  [LandCover.Rock]: 0x8a8781,
  [LandCover.Field]: 0x5d8a3a,
  [LandCover.Wood]: 0x2f4a25,
  [LandCover.BuiltUp]: 0x7d7b78,
  [LandCover.Water]: 0x3a5560,
  [LandCover.Quarry]: 0x9a948a,
};

/** Fallback for unknown landcover codes. */
export const LANDCOVER_DEFAULT = 0x83844a;

/** Strandline: wet mud, pale dried silt and grey-brown debris, mottled together. */
export const STRAND_MUD = 0x5e5040;
export const STRAND_SILT = 0x8c7f68;
export const STRAND_DEBRIS = 0x6b625a;
/** The wrack line hugging the mark: rotting weed, splinters and rubbish. */
export const WRACK = 0x2a2219;

/** Scour zone: stripped mud-grey ground, bedrock on steep slopes. */
export const SCOUR_MUD = 0x6e6a62;
export const SCOUR_DARK = 0x5a5650;
export const BEDROCK = 0x4c4b4a;

/** Lake surfaces: fresh is clear blue-green, salt is a murkier grey-green. */
export const WATER_FRESH = 0x2c4c5c;
export const WATER_SALT = 0x3d5a58;

/** Road surfaces by class, before mud. */
export const ROAD_COLORS = {
  A: 0x3b3b3d,
  B: 0x424244,
  minor: 0x4d4c49,
  track: 0x6e6048,
  path: 0x7d6f56,
} as const;

/** Railway: grey ballast with a darker bed down the middle. */
export const RAIL_BALLAST = 0x77736d;
export const RAIL_CENTRE = 0x3a3733;

/** Bridge parapets, walls, piers and kerbs. */
export const BRIDGE_STONE = 0x7d7a73;

/** Streams are a little browner than rivers (rivers use WATER_FRESH). */
export const WATER_STREAM = 0x3a5a60;

/** Craters: raw dark earth in the bowl, churned paler spoil on the rim, grey granite boulders thrown out. */
export const CRATER_EARTH = 0x3f3429;
export const CRATER_SPOIL = 0x6f6555;
export const BOULDER_GREYS = [0x8a8680, 0x6f6b65, 0x5c5953, 0x7a6e5e] as const;

/** Strike zones: burnt black ground with grey ash, or fused glassy rock, dark with a cold sheen. */
export const SCORCH = 0x161412;
export const SCORCH_ASH = 0x3d3934;
export const GLASSY = 0x1a1e22;
export const GLASSY_SHEEN = 0x3b4752;

/** Smoke: thick dark smoke over strike zones, paler grey over smaller fires; the night glow at their feet. */
export const SMOKE_STRIKE = 0x3a3632;
export const SMOKE_FIRE = 0x5f5b55;
export const FIRE_GLOW = 0xff6a24;

/** Debris heaps blocking a road, by what blocked it: splintered timber, silt and mud, wrack, earth and stone. */
export const DEBRIS_TIMBER = [0x5a4430, 0x433224, 0x6e5a42] as const;
export const DEBRIS_MUD = [0x5e5040, 0x8c7f68, 0x6b625a] as const;
export const DEBRIS_WRACK = [0x2a2219, 0x4a3e30, 0x6b625a] as const;

/** Blockers: raw landslip scar, wet silt flat with its sheen, and the darker soft patches in it. */
export const LANDSLIP_SCAR = 0x7a5a3c;
export const LANDSLIP_RAW = 0x5e4630;
export const SILT_FLAT = 0x6e6558;
export const SILT_SHEEN = 0x8c8a82;
export const SOFT_PATCH = 0x3e362c;
