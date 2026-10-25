// Weather: a fixed, hand-written schedule by game time (GameClock.gameDays). Pure; no three, no DOM.

export type Weather = 'clear' | 'haze' | 'rain' | 'heavyRain';

/** How far the scope can make out district damage in each weather, metres (SX 04: about 8 km when clear). */
export const VISIBILITY_M: Record<Weather, number> = { clear: 8000, haze: 5000, rain: 2500, heavyRain: 1000 };

export interface WeatherSpell {
  /** Starts at this game day (days since d0-00:00) and lasts until the next spell. */
  fromDay: number;
  weather: Weather;
}

const at = (day: number, hh: number): number => day + hh / 24;

/**
 * The schedule, in order. A clear evening on day 0, haze through day 1, showers on day 2 with a heavy spell
 * in the afternoon, then clearing. The last spell holds for ever.
 */
export const SCHEDULE: readonly WeatherSpell[] = [
  { fromDay: 0, weather: 'clear' },
  { fromDay: at(1, 4), weather: 'haze' },
  { fromDay: at(2, 3), weather: 'rain' },
  { fromDay: at(2, 6), weather: 'haze' },
  { fromDay: at(2, 10), weather: 'rain' },
  { fromDay: at(2, 14), weather: 'heavyRain' },
  { fromDay: at(2, 16), weather: 'rain' },
  { fromDay: at(2, 20), weather: 'haze' },
  { fromDay: at(3, 7), weather: 'clear' },
  { fromDay: at(4, 12), weather: 'haze' },
  { fromDay: at(5, 9), weather: 'rain' },
  { fromDay: at(5, 18), weather: 'clear' },
];

/** The weather at a game day. */
export function weatherAt(gameDays: number, schedule: readonly WeatherSpell[] = SCHEDULE): Weather {
  let w: Weather = schedule[0]?.weather ?? 'clear';
  for (const s of schedule) {
    if (s.fromDay > gameDays) break;
    w = s.weather;
  }
  return w;
}
