// The game clock. Until the clock task lands, the day is fixed.

/** Day used until the game clock exists (days since d1-00:00). */
export const DEFAULT_GAME_DAY = 2;

/** Current game day (days since d1-00:00). The one place renderers and views read the day from. */
export function currentGameDay(): number {
  return DEFAULT_GAME_DAY;
}
