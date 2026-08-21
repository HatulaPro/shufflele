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
        onError: () => void;
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
   * A song asked for before the iframe API finished loading. The first song of
   * a run races the script download, and dropping it would mean the run opens
   * on silence.
   */
  const pendingRef = useRef<string | null>(null);
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
              if (queued) {
                pendingRef.current = null;
                ytRef.current?.unMute();
                ytRef.current?.loadVideoById({ videoId: queued, startSeconds: 0 });
                ytRef.current?.playVideo();
              }
            },
            // A video pulled, region-locked or embed-disabled. Nothing to
            // recover to at this point — the deal is already on screen — so
            // this only surfaces the manual play affordance.
            onError: () => setBlocked(true),
            // 1 is PLAYING. Sound is provably coming out, so retire the manual
            // play chip whatever an earlier error or refusal implied.
            onStateChange: (event) => {
              if (event.data === PLAYING) setBlocked(false);
            },
          },
        });
      })
      .catch(() => {
        // No iframe API: every song plays its preview clip instead.
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
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    pendingRef.current = null;
    liveRef.current = false;
    if (ytReadyRef.current) {
      try {
        ytRef.current?.stopVideo();
      } catch {
        // Torn down mid-run; nothing to stop.
      }
    }
  }, []);

  const play = useCallback(
    (source: RushSource) => {
      stop();
      liveRef.current = true;

      if (source.videoId) {
        if (ytReadyRef.current && ytRef.current) {
          // `unlock` leaves the player muted so its priming play can't leak
          // over the countdown. This is the moment sound is actually wanted.
          ytRef.current.unMute();
          ytRef.current.loadVideoById({ videoId: source.videoId, startSeconds: 0 });
          ytRef.current.playVideo();
        } else {
          // Still loading. `onReady` picks this up.
          pendingRef.current = source.videoId;
        }
        return;
      }

      if (!source.previewUrl) return;
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
    [stop, getAudio],
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

      if (ytReadyRef.current && ytRef.current && source.videoId) {
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
          ytRef.current.loadVideoById({ videoId: source.videoId, startSeconds: 0 });
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
    [getAudio],
  );

  return { blocked, play, stop, unlock };
}
