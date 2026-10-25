// Pre-disaster map features from features.json (OpenStreetMap): lines, polygons and bridges.
// Local frame as in terrain.ts: x metres east, y metres north from the patch's SW corner.

export type Pt = readonly [number, number];

export type RoadClass = 'A' | 'B' | 'minor' | 'track' | 'path';
export type RailState = 'active' | 'abandoned' | 'disused';

export interface RoadFeature {
  id: string;
  cls: RoadClass;
  name?: string;
  ref?: string;
  pts: Pt[];
}

export interface RailFeature {
  id: string;
  state: RailState;
  name?: string;
  pts: Pt[];
}

export interface RiverFeature {
  id: string;
  name?: string;
  kind: 'river' | 'stream';
  /** Drawn downstream. */
  pts: Pt[];
}

export interface WaterFeature {
  id: string;
  name?: string;
  /** Closed: the first point is repeated at the end. */
  ring: Pt[];
}

export interface BridgeFeature {
  id: string;
  /** The bridge is the whole carrier way: refId is the id of a road or rail feature. */
  on: 'road' | 'rail';
  refId: string;
  name?: string;
  x: number;
  y: number;
  len: number;
  crosses?: string;
  crossesName?: string;
  major: boolean;
}

/** The parts of features.json that the world renderer draws. */
export interface Features {
  roads: RoadFeature[];
  rail: RailFeature[];
  rivers: RiverFeature[];
  water: WaterFeature[];
  bridges: BridgeFeature[];
}

/** Fetches features.json (browser). */
export async function fetchFeatures(baseUrl = '/world/', fetchFn: typeof fetch = fetch): Promise<Features> {
  const res = await fetchFn(baseUrl + 'features.json');
  if (!res.ok) throw new Error(`fetch ${baseUrl}features.json: ${res.status}`);
  return (await res.json()) as Features;
}
