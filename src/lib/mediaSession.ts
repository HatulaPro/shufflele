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
 * What this page *can* do is describe itself, and own a player worth
 * describing. A media session belongs to the tab, but the browser routes it to
 * whichever frame is playing — describing this frame while only the embed has
 * a player is a claim the embed keeps winning, which is exactly what shipping
 * the metadata alone turned out to do. So the claim comes in two parts:
 *
 *  - neutral metadata, rewritten for as long as a song is on air, because the
 *    embed rewrites its own around every load; and
 *  - a silent anchor: a looping, inaudible audio element in *this* frame,
 *    started inside the same tap that primes the run and left playing under
 *    the whole thing, so this frame has a player of its own — and the earlier
 *    one — for the browser to route to.
 *
 * Still best effort. Which frame wins is the browser's call and not a
 * documented one, so nothing in a run depends on the outcome: where the claim
 * holds the chip reads "shufflele rush", and where it doesn't the chip is no
 * worse than it was before any of this.
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

/**
 * How long the anchor keeps playing after a song stops.
 *
 * Rush deals its next song by stopping the current one and starting the next
 * in the same breath (`play` opens with `stop`), and tearing the anchor down
 * across that seam would be worse than useless: `play()` resolves a tick or
 * two later, so the anchor would come back *after* the embed had loaded and
 * registered — losing the very ordering it exists to hold. Pausing on a delay
 * that the next song cancels keeps one anchor running for the whole run, and
 * still lets the notification go away once a run really ends.
 */
const RELEASE_MS = 400;

let renewTimer: ReturnType<typeof setInterval> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let anchor: HTMLAudioElement | null = null;
let anchorUrl: string | null = null;

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

/**
 * A second of silence, as a WAV, built rather than shipped.
 *
 * The anchor needs a real audio track — a browser registers a player for the
 * media session off the presence of one, not off how loud it turns out to be,
 * and a `muted` element is skipped outright. Silence is the whole point: this
 * plays under every run and must never be heard. 8kHz, 8-bit, mono, where
 * silence is 0x80, so the file is a header and a kilobyte of nothing.
 */
function silentWavUrl(): string {
  const rate = 8000;
  const samples = rate; // one second, long enough that looping never chatters
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // byte rate: 8-bit mono
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);

  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function startAnchor(): void {
  if (!anchor) {
    anchorUrl = silentWavUrl();
    anchor = new Audio(anchorUrl);
    anchor.loop = true;
    // Not `muted`, on purpose — see `silentWavUrl`. The content is silence, so
    // full volume is still nothing to hear.
    anchor.volume = 1;
  }
  if (!anchor.paused) return;
  // Refused outside a user gesture, which is fine: the run is unaffected and
  // the metadata claim above stands on its own.
  anchor.play().catch(() => {});
}

function stopAnchor(): void {
  if (!anchor) return;
  anchor.pause();
  anchor.currentTime = 0;
}

/**
 * Claim the notification for this page, and keep claiming it.
 *
 * Called from inside the tap that primes a run, so the anchor's `play()` is
 * covered by the gesture, and again as each song goes on air.
 */
export function holdMediaSession(): void {
  if (!usable()) return;
  if (releaseTimer) {
    // A song ending straight into the next one. The anchor is still playing
    // and stays that way; restarting it here is what would break it.
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  claim();
  startAnchor();
  if (renewTimer) return;
  renewTimer = setInterval(claim, RENEW_MS);
}

/**
 * Give the notification up, once nothing is playing.
 *
 * Deferred by `RELEASE_MS` so that the gap between two songs of the same run
 * doesn't cost the anchor — see that constant. The last metadata claim is left
 * standing rather than cleared: a notification can outlive the sound that
 * raised it, and handing the slot back at that point would only let the embed's
 * title into it.
 */
export function releaseMediaSession(): void {
  if (releaseTimer) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    stopAnchor();
  }, RELEASE_MS);
}

/** Teardown: the page is going away, so the anchor goes with it. */
export function endMediaSession(): void {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  stopAnchor();
  anchor = null;
  if (anchorUrl) {
    URL.revokeObjectURL(anchorUrl);
    anchorUrl = null;
  }
}
