'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Rush's playback, over whichever source the deal produced.
 *
 * Rush wants the song from its first bar, and a preview clip cannot do that —
 * it is a pre-cut excerpt from the middle of the recording (see lib/ytmusic.ts).
 * So a deal carries a YouTube art-track id where one was found, and this hook
 * plays it in a hidden iframe from `startSeconds: 0`. Where it didn't, the same
 * hook plays the preview through a plain `<audio>` element, exactly as Rush
 * always has, and the run carries on without comment.
 *
 * Two backends, one at a time: `play` always silences the other, so a fallback
 * song can never end up layered over an iframe that is still running.
 *
 * A deal carrying a video id is not a promise that the video will play. The
 * server resolves art tracks by identity — title, artist, album, runtime — and
 * cannot see whether one is embeddable, region-locked for this listener, or
 * still up (lib/ytmusic.ts). Every one of those only fails here, in the
 * browser, with the deal already on screen. So the video id is a preference
 * rather than a commitment: whenever it turns out not to be playable, the
 * preview clip in the same source goes on air in its place. Silence is never
 * an outcome while the deal has anything left to play.
 */

export type RushSource = {
  /** Preferred. Played from t=0. */
  videoId: string | null;
  /** Fallback, played from wherever the excerpt happens to start. */
  previewUrl: string | null;
};

export type RushPlayer = {
  /**
   * Autoplay was refused and nothing is audible until the player asks for it.
   * Drives the manual play chip on the bar.
   */
  blocked: boolean;
  /** Puts a song on air, stopping whatever was playing. */
  play: (source: RushSource) => void;
  stop: () => void;
  /**
   * Buys playback permission inside a user gesture, for a song that won't start
   * until several timeouts later. Must be called synchronously from the tap.
   */
  unlock: (source: RushSource) => void;
};

// --- the iframe API --------------------------------------------------------

/**
 * Minimal shape of the bits of the IFrame API used here. The real typings are a
 * separate `@types` package, and this is a hidden player with four methods on
 * it — not worth a dependency.
 */
type YtPlayer = {
  loadVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  mute: () => void;
  unMute: () => void;
  destroy: () => void;
};

type YtNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      height: string;
      width: string;
      playerVars: Record<string, number>;
      events: {
        onReady: () => void;
        onError: (event: { data: number }) => void;
        onStateChange: (event: { data: number }) => void;
      };
    },
  ) => YtPlayer;
};

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API = 'https://www.youtube.com/iframe_api';

/** `YT.PlayerState.PLAYING`, without reaching into the namespace for it. */
const PLAYING = 1;

/**
 * The `onError` codes that mean *this video will never play here*: an id the
 * API won't accept (2), removed or private (100), and embedding disallowed
 * (101 and its alias 150). None of them can come out differently on a retry,
 * so they retire the video id and hand the song to its preview clip.
 *
 * That leaves 5 — an HTML5 playback failure — as the only code worth trying
 * again, and the only one that still just offers the manual play chip.
 */
const FATAL_ERRORS = new Set([2, 100, 101, 150]);

/**
 * How long a song waits on a player that hasn't reported ready before it gives
 * up and plays its preview instead. Long enough to cover a script still in
 * flight on a slow connection, short enough that a run doesn't open on a wall
 * of silence. Only ever spent when the API is unusually slow — the player is
 * built on mount, whole beats before the first "Go!".
 */
const READY_GRACE_MS = 2500;

/**
 * Video ids YouTube has refused for good (see FATAL_ERRORS). Module-level for
 * the same reason `apiPromise` is: a video that is region-locked or
 * embed-disabled stays that way for as long as this tab is open, and a pool
 * repeats hard — the same few hundred tracks all night, repeats inside a
 * single run, and another run every time the player comes back to Rush. Per
 * mount, leaving the game and returning would re-learn each one at the cost of
 * a silent swap.
 */
const deadVideos = new Set<string>();

/** Module-level so several mounts share one script tag and one load. */
let apiPromise: Promise<YtNamespace> | null = null;

function loadIframeApi(): Promise<YtNamespace> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YtNamespace>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    // The API calls exactly one global when it finishes, so anything already
    // waiting on it has to be chained rather than replaced.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('iframe api loaded without a player'));
    };

    const script = document.createElement('script');
    script.src = IFRAME_API;
    script.async = true;
    script.onerror = () => reject(new Error('iframe api failed to load'));
    document.head.appendChild(script);
  }).catch((err) => {
    // Cleared so a later mount can retry — a blocked network on first load
    // shouldn't condemn the tab to preview clips forever.
    apiPromise = null;
    throw err;
  });

  return apiPromise;
}

/**
 * The element the player is built on.
 *
 * Hidden, because the player's own chrome — title, thumbnail, channel — names
 * the song, and naming the song is the entire game. It stays a real 200×200
 * box that is laid out and painted rather than `display: none` or a 1px stub:
 * browsers treat an unrendered player as a background tab and throttle or
 * refuse its playback, which is the one thing this must not do.
 *
 * The API *replaces* this node with the iframe rather than nesting inside it,
 * carrying the inline style across — so these rules end up on the iframe
 * itself, and there is no wrapper left to clean up afterwards. `destroy()`
 * takes the iframe with it.
 */
function makeHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    width: '200px',
    height: '200px',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '-1',
  } satisfies Partial<CSSStyleDeclaration>);
  return host;
}

export function useRushPlayer(): RushPlayer {
  const [blocked, setBlocked] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ytRef = useRef<YtPlayer | null>(null);
  const ytReadyRef = useRef(false);
  /**
   * The iframe API never arrived, so there is no video backend at all and every
   * song plays its preview. Deliberately per-mount, unlike `deadVideos`:
   * `loadIframeApi` clears `apiPromise` on failure precisely so a later mount
   * can try the script again, and this is the flag that lets it. Within a
   * mount it stays latched — a run has no clock to spend on a second attempt.
   */
  const ytFailedRef = useRef(false);
  /**
   * A song asked for before the iframe API finished loading. The first song of
   * a run races the script download, and dropping it would mean the run opens
   * on silence. Held as the whole source, not just the id, because the fallback
   * paths need the preview that came with it.
   */
  const pendingRef = useRef<RushSource | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whatever is currently meant to be on air, for `onError` to recover from. */
  const currentRef = useRef<RushSource | null>(null);
  /**
   * The video id last handed to the player, cleared whenever it is stopped or
   * abandoned for a clip.
   *
   * `onError` names no video, so the song it belongs to has to be inferred —
   * and retiring the wrong id is worse than the failure being reported, since
   * a retirement outlives the song. Requiring the id on air to be the one the
   * player was actually given rules out every error that lands after we have
   * moved on: after a `stop`, after a swap down to the preview, or on a song
   * dealt without a video at all.
   */
  const loadedVideoRef = useRef<string | null>(null);
  /**
   * True once the run is meant to be audible. The priming `play()` in `unlock`
   * is async, and on a slow connection it can resolve *after* "Go!" has already
   * put the song on air — pausing then would kill the run in silence.
   */
  const liveRef = useRef(false);

  // One audio element for the whole run; each fallback song swaps the src.
  const getAudio = useCallback(() => {
    if (!audioRef.current) audioRef.current = new Audio();
    return audioRef.current;
  }, []);

  /** Every load goes through here, so `loadedVideoRef` cannot drift from it. */
  const loadVideo = useCallback((videoId: string) => {
    loadedVideoRef.current = videoId;
    ytRef.current?.loadVideoById({ videoId, startSeconds: 0 });
  }, []);

  const clearPending = useCallback(() => {
    if (pendingTimer.current) {
      clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
    pendingRef.current = null;
  }, []);

  /** The video id worth trying for this source, or null to go straight to the clip. */
  const usableVideo = useCallback((source: RushSource): string | null => {
    if (!source.videoId) return null;
    if (ytFailedRef.current) return null;
    if (deadVideos.has(source.videoId)) return null;
    return source.videoId;
  }, []);

  const playPreview = useCallback(
    (source: RushSource) => {
      // One backend at a time, by construction rather than by assumption: this
      // is reached from `onError` too, where the video is only *probably* not
      // making a sound.
      loadedVideoRef.current = null;
      if (ytReadyRef.current) {
        try {
          ytRef.current?.stopVideo();
        } catch {
          // Torn down mid-run; nothing to stop.
        }
      }

      if (!source.previewUrl) {
        // Nothing left to play. The chip is the only affordance there is, and a
        // transient failure can still recover behind it.
        setBlocked(true);
        return;
      }
      const audio = getAudio();
      if (audio.src !== source.previewUrl) audio.src = source.previewUrl;
      audio.currentTime = 0;
      // Autoplay policies can still refuse after all our taps — a reload
      // mid-run, mostly. The play button on the bar is the escape hatch.
      audio
        .play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    },
    [getAudio],
  );

  // Build the hidden player once, on mount, so the first deal doesn't pay for
  // the script download with the clock running.
  useEffect(() => {
    let alive = true;

    const host = makeHost();
    document.body.appendChild(host);

    loadIframeApi()
      .then((YT) => {
        if (!alive) return;
        ytRef.current = new YT.Player(host, {
          height: '200',
          width: '200',
          playerVars: {
            controls: 0,
            disablekb: 1,
            // Without this iOS takes the video fullscreen the moment it plays.
            playsinline: 1,
            modestbranding: 1,
            rel: 0,
            fs: 0,
          },
          events: {
            onReady: () => {
              ytReadyRef.current = true;
              const queued = pendingRef.current;
              clearPending();
              // The grace timer may already have handed this song to its clip,
              // and the run may have moved on entirely; either way `liveRef`
              // and the queue agree on whether this is still wanted.
              if (!queued || !liveRef.current) return;
              const videoId = usableVideo(queued);
              if (!videoId) {
                playPreview(queued);
                return;
              }
              ytRef.current?.unMute();
              loadVideo(videoId);
              ytRef.current?.playVideo();
            },
            // A video pulled, region-locked or embed-disabled. The deal is
            // already on screen, so there is no re-dealing it — but the clip
            // that came with it is right here, and a fatal code means the
            // video will not play on a retry either. Retire it and swap.
            onError: (event) => {
              const source = currentRef.current;
              const videoId = loadedVideoRef.current;
              // An error for a load the run has already moved past: nothing to
              // swap and nothing to retire. See `loadedVideoRef`.
              if (!source || !videoId || source.videoId !== videoId) return;

              if (!FATAL_ERRORS.has(event.data)) {
                // Worth another go, so the id keeps its place and the chip is
                // the way to spend it.
                setBlocked(true);
                return;
              }

              // Dead for this listener, whatever else the deal carries.
              // Retiring is about the video, not about having somewhere to go:
              // `playPreview` puts the chip up on its own when the deal has no
              // clip either.
              deadVideos.add(videoId);
              // Before "Go!" this is `unlock`'s muted priming failing, and
              // `play` routes to the clip on its own once the id is retired.
              // Mid-song it has to be swapped now.
              if (liveRef.current) playPreview(source);
              else loadedVideoRef.current = null;
            },
            // 1 is PLAYING. Sound is provably coming out, so retire the manual
            // play chip whatever an earlier error or refusal implied.
            onStateChange: (event) => {
              if (event.data === PLAYING) setBlocked(false);
            },
          },
        });
      })
      .catch(() => {
        // No iframe API: every song plays its preview clip instead. A song
        // queued against a player that is never coming would otherwise wait
        // out the whole run in silence, so it is redirected here.
        ytFailedRef.current = true;
        const queued = pendingRef.current;
        clearPending();
        if (queued && liveRef.current) playPreview(queued);
      });

    return () => {
      alive = false;
      ytReadyRef.current = false;
      try {
        ytRef.current?.destroy();
      } catch {
        // Already torn down with the host node.
      }
      ytRef.current = null;
      // A no-op once the API has swapped this node out for the iframe, which
      // `destroy` above already removed. It only bites when the script never
      // loaded and the bare div is still sitting there.
      host.remove();
    };
    // All four are `useCallback`s over stable deps, so this runs exactly once —
    // which it must: it builds and destroys the iframe player, and a re-run
    // would tear the player down mid-run.
  }, [clearPending, loadVideo, playPreview, usableVideo]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    clearPending();
    currentRef.current = null;
    loadedVideoRef.current = null;
    liveRef.current = false;
    if (ytReadyRef.current) {
      try {
        ytRef.current?.stopVideo();
      } catch {
        // Torn down mid-run; nothing to stop.
      }
    }
  }, [clearPending]);

  const play = useCallback(
    (source: RushSource) => {
      stop();
      liveRef.current = true;
      currentRef.current = source;

      const videoId = usableVideo(source);
      if (!videoId) {
        playPreview(source);
        return;
      }

      if (ytReadyRef.current && ytRef.current) {
        // `unlock` leaves the player muted so its priming play can't leak
        // over the countdown. This is the moment sound is actually wanted.
        ytRef.current.unMute();
        loadVideo(videoId);
        ytRef.current.playVideo();
        return;
      }

      // Still loading. `onReady` picks this up — and if it doesn't, the song
      // falls back to its clip rather than waiting out the run.
      pendingRef.current = source;
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        const queued = pendingRef.current;
        pendingRef.current = null;
        if (!queued || !liveRef.current) return;
        playPreview(queued);
      }, READY_GRACE_MS);
    },
    [stop, usableVideo, playPreview, loadVideo],
  );

  /**
   * iOS grants playback only to a `play()` that happens inside a user gesture,
   * and by the time the ready-set-go beats finish we are three timeouts away
   * from one. Both backends are primed here and silenced again immediately, so
   * nothing is audible before "Go!".
   */
  const unlock = useCallback(
    (source: RushSource) => {
      setBlocked(false);
      liveRef.current = false;
      // Priming failures land in `onError`, which needs to know which song it
      // is retiring.
      currentRef.current = source;

      const videoId = usableVideo(source);
      if (ytReadyRef.current && ytRef.current && videoId) {
        try {
          // The song has to be loaded before it can be played: calling
          // `playVideo` on an empty player is an error, and that error used to
          // light the manual-play chip on every single run.
          //
          // Left muted on purpose. `pauseVideo` can arrive while the player is
          // still buffering and simply be ignored, and a stray unmuted bar
          // during the countdown gives the answer away before the clock even
          // starts. `play` unmutes at "Go!".
          ytRef.current.mute();
          loadVideo(videoId);
          ytRef.current.playVideo();
          ytRef.current.pauseVideo();
        } catch {
          // Not ready yet — the countdown is usually long enough that it will
          // be by "Go!", and a refused autoplay only costs the play chip.
        }
      }

      if (source.previewUrl) {
        const audio = getAudio();
        audio.src = source.previewUrl;
        audio
          .play()
          .then(() => {
            if (!liveRef.current) {
              audio.pause();
              audio.currentTime = 0;
            }
            setBlocked(false);
          })
          .catch(() => setBlocked(true));
      }
    },
    [getAudio, usableVideo, loadVideo],
  );

  return { blocked, play, stop, unlock };
}
