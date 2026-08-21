'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRushPlayer } from '@/hooks/useRushPlayer';
import { api } from '@/lib/client';
import type { PublicRush, RushSongRef } from '@/lib/types';

type Props = {
  code: string;
  closing: boolean;
  onClose: () => void;
  /** Finish screen only: back to the lobby without tearing it down. */
  onBack: () => void;
};

type Phase = 'loading' | 'ready' | 'countdown' | 'playing' | 'over';

const COUNT_STEPS = ['3', '2', '1', 'Go!'] as const;
/** How long each ready-set-go beat stays up. Long enough to read, short enough to feel quick. */
const COUNT_MS = 650;

function bestKey(timeControl: PublicRush['timeControl']): string {
  return `shufflele:rush-best-${timeControl ?? 'inf'}`;
}

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The beat-the-clock mode's whole run: arm it, play songs from t=0, click the
 * one that's on. The server judges every click and deals the next song in the
 * same response, so there is no polling here at all — the only thing this
 * component watches is its own clock.
 */
export default function RushGame({ code, closing, onClose, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rush, setRush] = useState<PublicRush | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<'correct' | 'wrong' | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [countStep, setCountStep] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [newBest, setNewBest] = useState(false);
  /**
   * Both sources a deal can carry: the YouTube art track, played from the top,
   * and the preview clip it falls back to. See hooks/useRushPlayer.ts.
   */
  const {
    blocked: audioBlocked,
    play: playSong,
    stop: stopSong,
    unlock,
  } = useRushPlayer();

  // Fetch wherever the run stands. A finished game lands straight on the
  // finish screen — a refresh there must not lose the summary.
  useEffect(() => {
    let alive = true;
    api<PublicRush>(`/api/lobby/${code}/rush`)
      .then((next) => {
        if (!alive) return;
        setRush(next);
        setPhase(next.over ? 'over' : 'ready');
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load the game.'),
      );
    return () => {
      alive = false;
      stopSong();
    };
  }, [code, stopSong]);

  // High score lives in localStorage, per time control — this phone's best,
  // which is the only scoreboard a solo sprint needs.
  useEffect(() => {
    if (phase !== 'over' || !rush || best !== null) return;
    const key = bestKey(rush.timeControl);
    const prev = Number(window.localStorage.getItem(key) ?? 0);
    if (rush.score > prev) {
      window.localStorage.setItem(key, String(rush.score));
      setNewBest(true);
    }
    setBest(Math.max(prev, rush.score));
  }, [phase, rush, best]);

  // The clock. Derived from the server's deadline, so a refresh doesn't buy
  // extra time.
  useEffect(() => {
    if (phase !== 'playing' || rush?.endsAt == null) return;
    let alive = true;

    const tick = async () => {
      const left = rush.endsAt! - Date.now();
      if (!alive) return;
      if (left <= 0) {
        try {
          const next = await api<PublicRush>(`/api/lobby/${code}/rush/finish`, { method: 'POST' });
          if (!alive) return;
          stopSong();
          setRush(next);
          setPhase('over');
        } catch {
          if (alive) setPhase('over');
        }
        return;
      }
      setRemaining(left);
    };

    void tick();
    const timer = setInterval(tick, 250);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, rush?.endsAt, code, stopSong]);

  const videoId = rush?.videoId ?? null;
  const previewUrl = rush?.previewUrl ?? null;

  /**
   * Song on, clock on. The server stamps the deadline here rather than at deal
   * time, so the ready screen and the countdown come out of nobody's 30
   * seconds; the response carries the `endsAt` the clock below runs off.
   */
  const startPlaying = useCallback(async () => {
    setPhase('playing');
    playSong({ videoId, previewUrl });
    try {
      const next = await api<PublicRush>(`/api/lobby/${code}/rush/begin`, { method: 'POST' });
      setRush(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the clock.');
    }
    // Depends on the two source fields rather than on `rush` itself: the
    // countdown effect below re-runs whenever this identity changes, and
    // `setRush` above would otherwise hand it a new object and start the song
    // over on a loop. `begin` returns the same song, so both stay put.
  }, [videoId, previewUrl, playSong, code]);

  // Ready-set-go. Runs off a single chain of timeouts so the beats can't drift.
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countStep >= COUNT_STEPS.length) {
      void startPlaying();
      return;
    }
    const timer = setTimeout(() => setCountStep((step) => step + 1), COUNT_MS);
    return () => clearTimeout(timer);
  }, [phase, countStep, startPlaying]);

  const beginRun = () => {
    // Buy playback permission inside the tap itself — by the time the countdown
    // ends we are three timeouts away from a user gesture, and both backends
    // need one. Nothing is audible until "Go!".
    unlock({ videoId, previewUrl });
    setCountStep(0);
    setPhase('countdown');
  };

  const guess = useCallback(
    async (trackId: string) => {
      if (busy || !rush || phase !== 'playing') return;
      setBusy(true);
      setError(null);
      try {
        const next = await api<PublicRush>(`/api/lobby/${code}/rush/guess`, {
          method: 'POST',
          body: JSON.stringify({ trackId }),
        });
        const hit = next.score > rush.score;
        setFlash(hit ? 'correct' : 'wrong');
        setTimeout(() => setFlash(null), 550);

        if (next.over) {
          stopSong();
          setRush(next);
          setPhase('over');
        } else {
          setRush(next);
          playSong(next);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That guess did not go through.');
      } finally {
        setBusy(false);
      }
    },
    [busy, rush, phase, code, playSong, stopSong],
  );

  /** Restart with the same time control — the start route resets everything. */
  const playAgain = async () => {
    if (!rush) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api<PublicRush>(`/api/lobby/${code}/rush/start`, {
        method: 'POST',
        body: JSON.stringify({ timeControl: rush.timeControl === null ? 0 : rush.timeControl }),
      });
      setBest(null);
      setNewBest(false);
      // The blocked flag clears itself on the next run's unlock, and the chip
      // it drives only renders while playing — nothing to reset here.
      setRush(next);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a new run.');
    } finally {
      setBusy(false);
    }
  };

  if (error && phase === 'loading') {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <p className="notice notice--error">{error}</p>
        </div>
      </main>
    );
  }

  if (phase === 'loading' || !rush) {
    return (
      <main className="shell shell--center">
        <p className="muted">
          <span className="spinner" /> Warming up…
        </p>
      </main>
    );
  }

  // --- finish ------------------------------------------------------------

  if (phase === 'over') {
    return (
      <FinishScreen
        rush={rush}
        best={best}
        newBest={newBest}
        busy={busy}
        error={error}
        closing={closing}
        onPlayAgain={playAgain}
        onClose={onClose}
        onBack={onBack}
      />
    );
  }

  // --- ready / countdown ---------------------------------------------------

  if (phase !== 'playing') {
    return (
      <main className="shell shell--center">
        <div className="rush-arm stack">
          <h1 className="wordmark wordmark--sm">shufflele rush</h1>
          <p className="muted">
            Songs play from the top. Click the one that&rsquo;s playing — misses cost a heart.
          </p>
          <span className="chip chip--accent">
            {rush.timeControl === null ? 'Endless clock' : `${rush.timeControl} seconds`} ·{' '}
            {rush.maxLives} hearts
          </span>

          {phase === 'countdown' ? (
            /* Keyed so every beat replays the pop. */
            <p className="rush-count" key={countStep}>
              {COUNT_STEPS[Math.min(countStep, COUNT_STEPS.length - 1)]}
            </p>
          ) : (
            <button
              className="btn btn--primary btn--block"
              onClick={beginRun}
              disabled={closing}
            >
              Ready?
            </button>
          )}

          {error && <p className="notice notice--error">{error}</p>}
          <button className="btn btn--quiet btn--block" onClick={onClose} disabled={closing}>
            End game
          </button>
        </div>
      </main>
    );
  }

  // --- playing -------------------------------------------------------------

  const infinite = rush.timeControl === null;

  return (
    <main className="shell">
      <div className="row-between">
        <h1 className="wordmark wordmark--sm">shufflele rush</h1>
        <div className="row-tight">
          {audioBlocked && (
            <button
              className="chip chip--accent"
              onClick={() => playSong({ videoId, previewUrl })}
            >
              ▶ Play
            </button>
          )}
          <span className={`chip ${infinite ? '' : 'chip--accent'} rush-clock`}>
            {infinite
              ? '∞'
              : formatClock(
                  remaining ??
                    (rush.endsAt !== null
                      ? rush.endsAt - Date.now()
                      : (rush.timeControl ?? 0) * 1000),
                )}
          </span>
          <span className="chip">{rush.score}</span>
          <span className="hearts" aria-label={`${rush.lives} of ${rush.maxLives} hearts left`}>
            {Array.from({ length: rush.maxLives }, (_, i) => (
              <span key={i} className={`heart ${i < rush.lives ? '' : 'heart--lost'}`}>
                ♥
              </span>
            ))}
          </span>
        </div>
      </div>

      {flash && (
        <div key={`${flash}-${rush.score}-${rush.lives}`} className={`rush-flash rush-flash--${flash}`}>
          {flash === 'correct' ? '+1' : '−1 heart'}
        </div>
      )}

      {error && <p className="notice notice--error">{error}</p>}

      <div className="rush-board">
        {rush.options.map((option) => (
          <button
            key={option.spotifyId}
            className="track-row"
            onClick={() => guess(option.spotifyId)}
            disabled={busy}
          >
            {option.albumArt && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="track-row__art" src={option.albumArt} alt="" />
            )}
            <span className="track-row__text">
              <span className="track-row__title">{option.title}</span>
              <span className="track-row__artist">{option.artist}</span>
            </span>
          </button>
        ))}
      </div>

      <p className="tiny rush-hint">Playing from the top — tap fast.</p>
    </main>
  );
}

// --- finish screen ---------------------------------------------------------

function SongList({ songs, tone }: { songs: RushSongRef[]; tone: 'good' | 'bad' }) {
  return (
    <details className={`rush-list rush-list--${tone}`}>
      <summary>
        {tone === 'good' ? 'Nailed it' : 'Missed'} · {songs.length}
      </summary>
      <div className="rush-list__body">
        {songs.map((song, i) => (
          <div key={`${song.title}-${i}`} className="track-row track-row--static">
            {song.albumArt && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="track-row__art" src={song.albumArt} alt="" />
            )}
            <span className="track-row__text">
              <span className="track-row__title">{song.title}</span>
              <span className="track-row__artist">{song.artist}</span>
              <span className="tiny">from {song.contributor}&rsquo;s playlist</span>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function FinishScreen({
  rush,
  best,
  newBest,
  busy,
  error,
  closing,
  onPlayAgain,
  onClose,
  onBack,
}: {
  rush: PublicRush;
  best: number | null;
  newBest: boolean;
  busy: boolean;
  error: string | null;
  closing: boolean;
  onPlayAgain: () => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const summary = rush.summary ?? { correct: [], wrong: [] };

  return (
    <main className="shell">
      <div className="row-between">
        <h1 className="wordmark wordmark--sm">shufflele rush</h1>
        <span className="chip">
          {rush.timeControl === null ? '∞' : `${rush.timeControl}s`} run
        </span>
      </div>

      <div className="verdict verdict--win">
        <p className="verdict__word">{rush.score}</p>
        <p className="muted">
          {rush.score === 1 ? 'song' : 'songs'} guessed
        </p>
      </div>

      {best !== null && (
        <p className={`rush-best ${newBest ? 'rush-best--new' : ''}`}>
          {newBest ? 'New personal best!' : `Personal best: ${best}`}
        </p>
      )}

      {error && <p className="notice notice--error">{error}</p>}

      <div className="stack stack--tight">
        {(summary.correct.length > 0 || summary.wrong.length > 0) && (
          <>
            <SongList songs={summary.correct} tone="good" />
            <SongList songs={summary.wrong} tone="bad" />
          </>
        )}
        {summary.correct.length === 0 && summary.wrong.length === 0 && (
          <p className="empty">Not a single song — the clock was ruthless.</p>
        )}
      </div>

      <div className="stack stack--tight" style={{ marginTop: 'auto' }}>
        <button className="btn btn--primary btn--block" onClick={onPlayAgain} disabled={busy}>
          {busy ? 'Dealing…' : 'Play again'}
        </button>
        <button className="btn btn--ghost btn--block" onClick={onBack} disabled={closing}>
          Back to lobby
        </button>
        <button className="btn btn--quiet btn--block" onClick={onClose} disabled={closing}>
          {closing ? 'Ending…' : 'End game'}
        </button>
      </div>
    </main>
  );
}