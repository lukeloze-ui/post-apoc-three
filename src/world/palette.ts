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
