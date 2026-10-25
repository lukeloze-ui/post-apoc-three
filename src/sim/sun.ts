// Solar position after the NOAA spreadsheet (Meeus): altitude and azimuth from a UTC instant and lat/lon.

export interface SunPosition {
  /** Degrees above the horizon (geometric, no refraction). */
  altitude: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

/** The site: Okehampton. */
export const SITE_LAT = 50.7;
export const SITE_LON = -4.0;

const RAD = Math.PI / 180;

/** Solar position at utcMs (ms since the Unix epoch), latitude north and longitude east in degrees. */
export function sunPosition(utcMs: number, latDeg: number = SITE_LAT, lonDeg: number = SITE_LON): SunPosition {
  const jd = utcMs / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525; // Julian centuries since J2000
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const mr = m * RAD;
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD));

  const y = Math.tan((obliq * RAD) / 2) ** 2;
  const eqTime =
    4 *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(mr) +
      4 * e * y * Math.sin(mr) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * mr)) /
    RAD; // minutes

  const utcMinutes = (((utcMs / 60000) % 1440) + 1440) % 1440;
  const trueSolarMin = (((utcMinutes + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMin / 4 - 180) * RAD;

  const lat = latDeg * RAD;
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const altitude = 90 - zenith / RAD;

  // Azimuth clockwise from north.
  const sinZ = Math.sin(zenith);
  let azimuth = 180;
  if (sinZ > 1e-6) {
    const cosAz = (Math.sin(lat) * cosZenith - Math.sin(decl)) / (Math.cos(lat) * sinZ);
    const a = Math.acos(Math.min(1, Math.max(-1, cosAz))) / RAD;
    azimuth = hourAngle > 0 ? (a + 180) % 360 : 540 - a;
    azimuth %= 360;
  }
  return { altitude, azimuth };
}
