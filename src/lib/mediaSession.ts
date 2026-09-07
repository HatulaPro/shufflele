/**
 * Keeping the song's name out of the browser's media notification.
 *
 * Rush hides everything that names the song — hooks/useRushPlayer.ts builds its
 * YouTube player inside an invisible host precisely so the player's own chrome
 * (title, thumbnail, channel) never reaches the screen. The one place the name
 * still got out is not on the page at all: when audio plays, the browser puts a
 * media notification in the OS shell — a chip in the Android status bar, a tile
 * in the lock screen, the macOS Now Playing menu — and fills it from the Media
 * Session API. YouTube Music art tracks are titled with the bare song name, so
 * that chip read "Help" while the player was still guessing at it.
 *
 * The clip fallback never leaked: its `<audio>` lives in this page's own frame,
 * where the browser has nothing better to show than the document title. Only
 * the video backend does, and its metadata is written by the YouTube embed, in
 * a cross-origin frame nothing here can reach into.
 *
 * What this page *can* do is describe itself. A media session belongs to the
 * tab, and the browser picks whose description to show — so writing neutral
 * metadata here, and rewriting it for as long as a song is on air, is a claim
 * on that slot rather than a guarantee of it. Where the claim wins the chip
 * says "shufflele rush" and nothing else; where the embed keeps it, the chip is
 * no worse than it was. Best effort, in other words, which is why the run also
 * never depends on it.
 */

/** What the notification says instead of the song. */
const TITLE = 'shufflele rush';
const ARTIST = 'guess the song';

/**
 * How often the claim is renewed while a song plays.
 *
 * The embed rewrites its own metadata whenever it loads a video and around
 * state changes, and each of those can take the slot back — a claim made once,
 * at the moment the song goes on air, would be overwritten a beat later by the
 * load it was made for. Rewriting a metadata object once a second costs
 * nothing next to that.
 */
const RENEW_MS = 1000;

let renewTimer: ReturnType<typeof setInterval> | null = null;

function usable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'mediaSession' in navigator &&
    typeof MediaMetadata !== 'undefined'
  );
}

function claim(): void {
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: TITLE,
      artist: ARTIST,
      album: '',
      // Empty on purpose: the expanded notification shows artwork, and the
      // cover art gives the song away every bit as plainly as its title.
      artwork: [],
    });
  } catch {
    // A browser with the API but not the constructor, or a session the tab
    // isn't allowed to touch. Nothing here is worth failing a run over.
  }
}

/** Claim the notification for this page, and keep claiming it. */
export function holdMediaSession(): void {
  if (!usable()) return;
  claim();
  if (renewTimer) return;
  renewTimer = setInterval(claim, RENEW_MS);
}

/**
 * Stop renewing, once nothing is playing.
 *
 * The last claim is left standing rather than cleared: a notification can
 * outlive the sound that raised it, and handing the slot back at that point
 * would only let the embed's title into it.
 */
export function releaseMediaSession(): void {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
}
