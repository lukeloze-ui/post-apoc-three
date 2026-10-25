// WGS84 lat/lon <-> OSGB36 National Grid (EPSG:27700) <-> the patch's local frame.
// Helmert datum shift (about 5 m accuracy) plus the Ordnance Survey transverse Mercator; no dependencies.

/** SW corner of the 10 km patch on the National Grid (SX 52 88). */
export const ORIGIN_E = 252000;
export const ORIGIN_N = 88000;
/** Patch edge length in metres. */
export const PATCH_M = 10000;

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;

interface Ellipsoid {
  a: number;
  b: number;
}
const WGS84: Ellipsoid = { a: 6378137, b: 6356752.314245 };
const AIRY1830: Ellipsoid = { a: 6377563.396, b: 6356256.909 };

// WGS84 -> OSGB36 Helmert parameters: metres, ppm, arc-seconds.
const TX = -446.448;
const TY = 125.157;
const TZ = -542.06;
const SCALE = 1 + 20.4894e-6;
const RX = -0.1502 * ARCSEC;
const RY = -0.247 * ARCSEC;
const RZ = -0.8421 * ARCSEC;

// National Grid projection constants.
const F0 = 0.9996012717;
const LAT0 = 49 * DEG;
const LON0 = -2 * DEG;
const N0 = -100000;
const E0 = 400000;

export interface Osgb {
  e: number;
  n: number;
}

export interface Local {
  x: number;
  y: number;
}

function toCartesian(lat: number, lon: number, el: Ellipsoid): [number, number, number] {
  const e2 = 1 - (el.b * el.b) / (el.a * el.a);
  const nu = el.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [nu * Math.cos(lat) * Math.cos(lon), nu * Math.cos(lat) * Math.sin(lon), nu * (1 - e2) * Math.sin(lat)];
}

function toGeodetic(x: number, y: number, z: number, el: Ellipsoid): [number, number] {
  const e2 = 1 - (el.b * el.b) / (el.a * el.a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let k = 0; k < 10; k++) {
    const nu = el.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

/** Transverse Mercator on the Airy 1830 ellipsoid with the National Grid constants. */
function project(lat: number, lon: number): Osgb {
  const { a, b } = AIRY1830;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const tan = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const eta2 = nu / rho - 1;
  const dLat = lat - LAT0;
  const sLat = lat + LAT0;
  const Ma = (1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * dLat;
  const Mb = (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(dLat) * Math.cos(sLat);
  const Mc = ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
  const Md = (35 / 24) * n ** 3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
  const M = b * F0 * (Ma - Mb + Mc - Md);
  const dLon = lon - LON0;
  const I = M + N0;
  const II = (nu / 2) * sin * cos;
  const III = (nu / 24) * sin * cos ** 3 * (5 - tan ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sin * cos ** 5 * (61 - 58 * tan ** 2 + tan ** 4);
  const IV = nu * cos;
  const V = (nu / 6) * cos ** 3 * (nu / rho - tan ** 2);
  const VI = (nu / 120) * cos ** 5 * (5 - 18 * tan ** 2 + tan ** 4 + 14 * eta2 - 58 * tan ** 2 * eta2);
  return {
    e: E0 + IV * dLon + V * dLon ** 3 + VI * dLon ** 5,
    n: I + II * dLon ** 2 + III * dLon ** 4 + IIIA * dLon ** 6,
  };
}

/** WGS84 degrees to OSGB36 National Grid metres. */
export function wgs84ToOsgb(latDeg: number, lonDeg: number): Osgb {
  const [x, y, z] = toCartesian(latDeg * DEG, lonDeg * DEG, WGS84);
  const x2 = TX + x * SCALE - y * RZ + z * RY;
  const y2 = TY + x * RZ + y * SCALE - z * RX;
  const z2 = TZ - x * RY + y * RX + z * SCALE;
  const [lat, lon] = toGeodetic(x2, y2, z2, AIRY1830);
  return project(lat, lon);
}

/** OSGB metres to the patch's local frame (x east, y north, from the SW corner). */
export function osgbToLocal(e: number, n: number): Local {
  return { x: e - ORIGIN_E, y: n - ORIGIN_N };
}

export function localToOsgb(x: number, y: number): Osgb {
  return { e: x + ORIGIN_E, n: y + ORIGIN_N };
}

export function wgs84ToLocal(latDeg: number, lonDeg: number): Local {
  const { e, n } = wgs84ToOsgb(latDeg, lonDeg);
  return osgbToLocal(e, n);
}

/** Local frame position of a grid reference in square SX as 100 m units, e.g. gridRefSX(580, 901) for SX 580 901. */
export function gridRefSX(e100m: number, n100m: number): Local {
  return osgbToLocal(200000 + e100m * 100, n100m * 100);
}
