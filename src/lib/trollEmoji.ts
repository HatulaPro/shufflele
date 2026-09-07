import type { RushOption } from './types';

/**
 * The troll round. Every so often one row on the Rush board loses its number
 * and wears an emoji instead — `7 | Merry Christmas` comes up as
 * `🎅 | Merry Christmas`. It does nothing: the song is not the answer more or
 * less often, the score is unaffected, and the row is still just a row. It is
 * there so that a room playing its fortieth song of the night looks up.
 *
 * Three things keep it a joke rather than a tell:
 *
 * - **Rare.** One board in `TROLL_ODDS` gets one, so it reads as a glitch the
 *   first time somebody sees it. A troll every other round is decoration.
 * - **Silent when it can't land.** No title on the board carries one of the
 *   words below, the round passes with plain numbers — see `pickTroll`.
 * - **Whole words only.** `fire` is Fire, not Fireworks; `star` is Star, not
 *   Starlight. Matching on substrings puts a 🔥 next to "Firework" and the
 *   joke dies on the spot.
 *
 * The vocabulary is drawn from the same title themes the loading-screen quips
 * count (lib/quips.ts) — those words were picked because playlists are full of
 * them, which is exactly what a rare roll needs to have something to hit.
 */
export const TROLL_ODDS = 22;

/** Word (lowercase, whole-word) → the emoji that replaces the row's number. */
export const TROLL_EMOJI: Record<string, string> = {
  // Christmas
  christmas: '🎄',
  santa: '🎅',
  jingle: '🔔',
  sleigh: '🛷',

  // Love
  love: '❤️',
  heart: '💗',
  broken: '💔',
  kiss: '💋',
  honey: '🍯',

  // Sky and weather
  sun: '☀️',
  moon: '🌙',
  star: '⭐',
  stars: '🌟',
  night: '🌃',
  rain: '🌧️',
  storm: '⛈️',
  thunder: '⚡',
  umbrella: '☂️',
  cloud: '☁️',

  // Summer
  summer: '🏖️',
  beach: '🌴',
  ocean: '🌊',
  waves: '🏄',
  hollywood: '🎬',

  fire: '🔥',

  // Money
  money: '💰',
  dollar: '💵',
  diamond: '💎',
  rich: '🪙',

  // Faith
  god: '🙏',
  jesus: '✝️',
  heaven: '🕊️',
  church: '⛪',

  // Drink
  wine: '🍷',
  whiskey: '🥃',
  beer: '🍺',

  // Motion
  car: '🚗',
  train: '🚂',

  // Everything else
  war: '⚔️',
  blood: '🩸',
  fight: '🥊',
  soldier: '🎖️',
  dance: '💃',
  dream: '💭',
  king: '👑',
  smoke: '💨',
};

/** The board row that has been trolled, and what it wears instead of a number. */
export type Troll = { index: number; emoji: string };

/**
 * Title → the emoji its words earn, or null. Case is ignored and anything that
 * isn't a letter is a word break, so `Fire!`, `FIRE` and `Sex on Fire` all hit
 * and `Fireworks` does not. A title carrying several words picks one at random,
 * because "Christmas Night" deserves both jokes across a night of play.
 */
function emojiFor(title: string): string | null {
  const hits = title
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((word) => TROLL_EMOJI[word])
    .filter((emoji): emoji is string => emoji !== undefined);
  if (hits.length === 0) return null;
  return hits[Math.floor(Math.random() * hits.length)]!;
}

/**
 * Roll for a troll on this board. Null — the ordinary case — leaves every row
 * numbered, both on a failed roll and when the roll succeeds but no title on
 * the board has a word to hang an emoji on. Skipping the round outright is the
 * point: forcing a match would mean either a loose one or a recognisable one,
 * and both hand the room information the board isn't supposed to carry.
 *
 * Called once per board rather than per render — see RushGame.
 */
export function pickTroll(options: readonly RushOption[]): Troll | null {
  if (Math.random() * TROLL_ODDS >= 1) return null;

  const candidates: Troll[] = [];
  options.forEach((option, index) => {
    const emoji = emojiFor(option.title);
    if (emoji) candidates.push({ index, emoji });
  });
  if (candidates.length === 0) return null;

  return candidates[Math.floor(Math.random() * candidates.length)]!;
}
