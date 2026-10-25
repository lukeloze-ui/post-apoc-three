import * as THREE from 'three';

/** Everything the scene lights and fog take from the sun's altitude. */
export interface Daylight {
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fog: THREE.Color;
  /** Tone-mapping exposure: raised at dusk and night so the dim sky and ground still read. */
  exposure: number;
  /** 0 in daylight, 1 once the sky is fully dark (stars and moonlight at full strength). */
  night: number;
}

interface Key {
  /** Sun altitude, degrees. */
  alt: number;
  sun: number;
  sunI: number;
  sky: number;
  ground: number;
  hemiI: number;
  fog: number;
  exp: number;
}

// Ascending altitude. Below -6 degrees the sky is dark blue-black but the hemisphere light keeps terrain faintly readable.
const KEYS: Key[] = [
  { alt: -18, sun: 0x000000, sunI: 0, sky: 0x4a62a0, ground: 0x1c2030, hemiI: 3, fog: 0x070a12, exp: 1.1 },
  { alt: -6, sun: 0x000000, sunI: 0, sky: 0x506aa8, ground: 0x242838, hemiI: 3, fog: 0x141c32, exp: 1.1 },
  { alt: -1, sun: 0xff6a30, sunI: 0.5, sky: 0x6a6a98, ground: 0x4c4446, hemiI: 2.4, fog: 0x8a6a6c, exp: 1 },
  { alt: 2, sun: 0xff9448, sunI: 2.2, sky: 0x9a9cb8, ground: 0x5a5448, hemiI: 2.4, fog: 0xc8a284, exp: 0.8 },
  { alt: 8, sun: 0xffc690, sunI: 3.6, sky: 0xa0b4d8, ground: 0x66624c, hemiI: 2.6, fog: 0xbcbcb8, exp: 0.65 },
  { alt: 25, sun: 0xffe2b8, sunI: 5, sky: 0xa6c4e8, ground: 0x6a6a50, hemiI: 3, fog: 0xb3c3cf, exp: 0.6 },
];

const ca = new THREE.Color();
const cb = new THREE.Color();

function lerpHex(out: THREE.Color, a: number, b: number, f: number): void {
  out.lerpColors(ca.setHex(a), cb.setHex(b), f);
}

/** Light and fog settings for a sun altitude in degrees. Writes into and returns `out` when given. */
export function daylightAt(altitude: number, out: Daylight = newDaylight()): Daylight {
  const first = KEYS[0] as Key;
  const last = KEYS[KEYS.length - 1] as Key;
  let lo = first;
  let hi = first;
  let f = 0;
  if (altitude >= last.alt) {
    lo = hi = last;
  } else if (altitude > first.alt) {
    let i = 1;
    while ((KEYS[i] as Key).alt < altitude) i++;
    lo = KEYS[i - 1] as Key;
    hi = KEYS[i] as Key;
    f = (altitude - lo.alt) / (hi.alt - lo.alt);
  }
  lerpHex(out.sunColor, lo.sun, hi.sun, f);
  lerpHex(out.hemiSky, lo.sky, hi.sky, f);
  lerpHex(out.hemiGround, lo.ground, hi.ground, f);
  lerpHex(out.fog, lo.fog, hi.fog, f);
  out.sunIntensity = lo.sunI + (hi.sunI - lo.sunI) * f;
  out.hemiIntensity = lo.hemiI + (hi.hemiI - lo.hemiI) * f;
  out.exposure = lo.exp + (hi.exp - lo.exp) * f;
  out.night = Math.min(1, Math.max(0, (-altitude - 2) / 10));
  return out;
}

export function newDaylight(): Daylight {
  return {
    sunColor: new THREE.Color(),
    sunIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    fog: new THREE.Color(),
    exposure: 0.6,
    night: 0,
  };
}
