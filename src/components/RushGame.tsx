'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRushPlayer } from '@/hooks/useRushPlayer';
import { ApiError, api } from '@/lib/client';
import { RUSH_BONUS_MS } from '@/lib/types';
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
/** How long the correct-guess time bonus stays up beside the score. */
const BONUS_MS = 900;
const BONUS_SECONDS = RUSH_BONUS_MS / 1000;

function bestKey(timeControl: PublicRush['timeControl']): string {
  return `shufflele:rush-best-${timeControl ?? 'inf'}`;
}

/** "1 min" / "2 min" for the labels the run wears on the ready and finish screens. */
function formatTimeControl(timeControl: PublicRush['timeControl']): string {
  if (timeControl === null) return 'Endless clock';
  return timeControl === 60 ? '1 minute' : `${timeControl / 60} minutes`;
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
  /**
   * The row that was just tapped, and how it went. The board is frozen on the
   * old options while this is set, so the verdict lands on the row the player
   * actually pressed instead of on whatever replaced it.
   */
  const [flash, setFlash] = useState<{ trackId: string; kind: 'correct' | 'wrong' } | null>(null);
  const [frozen, setFrozen] = useState<PublicRush['options'] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [countStep, setCountStep] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [newBest, setNewBest] = useState(false);
  /** Set on a correct guess so the clock bonus is visible; clears itself. */
  const [bonus, setBonus] = useState(false);
  /**
   * Server clock minus this device's clock. `endsAt` is stamped in server
   * time, so counting down against a raw `Date.now()` is wrong by whatever the
   * device clock is off by — which on a phone with a hand-set clock is not
   * small. Every response carries the server's `now`, so the difference is
   * free to measure and is re-measured on each one.
   *
   * A ref, not state: the clock effect below re-arms on `endsAt`, and making
   * this a dependency would tear the interval down on every response for a
   * value that only ever nudges. Reading `.current` inside the tick picks up
   * the latest either way.
   *
   * The reading is biased by however long the response took to arrive, which
   * makes the measured offset slightly too small and the countdown finish a
   * hair early — the safe direction, and the server is the authority on expiry
   * regardless.
   */
  const clockOffset = useRef(0);
  /** Held so a fast second guess restarts the bump rather than inheriting the first one's timer. */
  const bonusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /** Every server response, in one place, so the clock offset can't drift unmeasured. */
  const applyRush = useCallback((next: PublicRush) => {
    clockOffset.current = next.now - Date.now();
    setRush(next);
  }, []);

  /** Now, in server time. What every deadline comparison here runs off. */
  const serverNow = useCallback(() => Date.now() + clockOffset.current, []);

  /**
   * The run is already over on the server — the clock ran out, or a tap landed
   * after the deadline. That is not a failure to report to the player: pick up
   * the final state and go straight to the summary, clearing any error the
   * losing race left behind.
   */
  const finishFromServer = useCallback(async () => {
    stopSong();
    setError(null);
    try {
      const next = await api<PublicRush>(`/api/lobby/${code}/rush/finish`, { method: 'POST' });
      applyRush(next);
    } catch {
      // Nothing to correct with; the summary shows the last state we hold.
    }
    setPhase('over');
  }, [code, stopSong, applyRush]);

  // Fetch wherever the run stands. A finished game lands straight on the
  // finish screen — a refresh there must not lose the summary.
  useEffect(() => {
    let alive = true;
    api<PublicRush>(`/api/lobby/${code}/rush`)
      .then((next) => {
        if (!alive) return;
        applyRush(next);
        if (next.over) setError(null);
        setPhase(next.over ? 'over' : 'ready');
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load the game.'),
      );
    return () => {
      alive = false;
      stopSong();
      if (bonusTimer.current) clearTimeout(bonusTimer.current);
    };
  }, [code, stopSong, applyRush]);

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

  // The clock. Derived from the server's deadline and read in server time, so
  // neither a refresh nor a skewed device clock buys extra time. Re-arms
  // whenever `endsAt` moves, which a correct guess makes it do.
  useEffect(() => {
    if (phase !== 'playing' || rush?.endsAt == null) return;
    let alive = true;

    const tick = async () => {
      const left = rush.endsAt! - serverNow();
      if (!alive) return;
      if (left <= 0) {
        await finishFromServer();
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
  }, [phase, rush?.endsAt, serverNow, finishFromServer]);

  const videoId = rush?.videoId ?? null;
  const previewUrl = rush?.previewUrl ?? null;

  /**
   * Song on, clock on. The server stamps the deadline here rather than at deal
   * time, so the ready screen and the countdown come out of nobody's
   * clock; the response carries the `endsAt` the clock below runs off.
   */
  const startPlaying = useCallback(async () => {
    setPhase('playing');
    playSong({ videoId, previewUrl });
    try {
      const next = await api<PublicRush>(`/api/lobby/${code}/rush/begin`, { method: 'POST' });
      applyRush(next);
    } catch (err) {
      // No stamped deadline means no clock: the effect below never arms, and
      // the server never expires the run either, so playing on would hand out
      // an unbounded run. The run stops here instead and re-arms
      // from the ready screen. `begin` is idempotent, so if it was only the
      // response that went missing, the retry picks the run up on the deadline
      // it already has — including one that has since run out.
      if (err instanceof ApiError && err.status === 409) {
        // The run ran out before the countdown did — the summary, not an error.
        await finishFromServer();
        return;
      }
      stopSong();
      setCountStep(0);
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Could not start the clock.');
    }
    // Depends on the two source fields rather than on `rush` itself: the
    // countdown effect below re-runs whenever this identity changes, and
    // `setRush` above would otherwise hand it a new object and start the song
    // over on a loop. `begin` returns the same song, so both stay put.
  }, [videoId, previewUrl, playSong, stopSong, code, applyRush, finishFromServer]);

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
    setError(null);
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
        setFlash({ trackId, kind: hit ? 'correct' : 'wrong' });
        setFrozen(rush.options);
        setTimeout(() => {
          setFlash(null);
          setFrozen(null);
        }, 550);

        // Only when there is a clock to have been extended: an endless run
        // scores the same but has no deadline, so a "+2s" there would be a lie.
        if (hit && next.endsAt !== null) {
          if (bonusTimer.current) clearTimeout(bonusTimer.current);
          setBonus(true);
          bonusTimer.current = setTimeout(() => setBonus(false), BONUS_MS);
        }

        if (next.over) {
          stopSong();
          setError(null);
          applyRush(next);
          setPhase('over');
        } else {
          applyRush(next);
          playSong(next);
        }
      } catch (err) {
        // A tap that landed after the deadline: the run really is over, so show
        // the summary rather than blaming the player's last click.
        if (err instanceof ApiError && err.status === 409) {
          await finishFromServer();
          return;
        }
        setError(err instanceof Error ? err.message : 'That guess did not go through.');
      } finally {
        setBusy(false);
      }
    },
    [busy, rush, phase, code, playSong, stopSong, applyRush, finishFromServer],
  );

  /**
   * Back to the lobby, and the run goes with it. The host screen resumes from
   * the lobby's `rushActive` flag, which is only "a rush game exists" — so a
   * spent run left in place means every later refresh landing back on this
   * same summary with no way out. Clearing it server-side is what makes the
   * exit stick; up until this button, a refresh still restores the summary.
   */
  const backToLobby = useCallback(async () => {
    try {
      await api(`/api/lobby/${code}/rush`, { method: 'DELETE' });
    } catch {
      // Best-effort. The run is already over and the screen is leaving either
      // way; the only cost is that a refresh could still land back here.
    }
    onBack();
  }, [code, onBack]);

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
      setBonus(false);
      // The blocked flag clears itself on the next run's unlock, and the chip
      // it drives only renders while playing — nothing to reset here.
      applyRush(next);
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
        onBack={backToLobby}
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
            Songs play from the top. Click the one that&rsquo;s playing — misses cost a life.
          </p>
          <span className="chip chip--accent">
            {formatTimeControl(rush.timeControl)} · {rush.maxLives} lives
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
  const msLeft =
    remaining ??
    (rush.endsAt !== null ? rush.endsAt - serverNow() : (rush.timeControl ?? 0) * 1000);
  /** Last ten seconds get the pulse — the clock is the thing you must not miss. */
  const urgent = !infinite && msLeft <= 10_000;

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
          <span
            className={`rush-clock ${infinite ? 'rush-clock--inf' : ''} ${
              urgent ? 'rush-clock--urgent' : ''
            }`}
            aria-label="Time left"
          >
            {infinite ? '∞' : formatClock(msLeft)}
          </span>
          <span className="rush-score">
            <span className="chip">{rush.score}</span>
            {bonus && (
              <span key={rush.score} className="rush-bonus" aria-hidden>
                +{BONUS_SECONDS}s
              </span>
            )}
          </span>
          <span className="hearts" aria-label={`${rush.lives} of ${rush.maxLives} lives left`}>
            {Array.from({ length: rush.maxLives }, (_, i) => (
              <span key={i} className={`heart ${i < rush.lives ? '' : 'heart--lost'}`}>
                ♥
              </span>
            ))}
          </span>
        </div>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      <div className="rush-board">
        {(frozen ?? rush.options).map((option) => {
          const hit = flash?.trackId === option.spotifyId ? flash.kind : null;
          return (
          <button
            key={option.spotifyId}
            className={`track-row${hit ? ` track-row--${hit}` : ''}`}
            onClick={() => guess(option.spotifyId)}
            disabled={busy}
          >
            {hit ? (
              <span className="track-row__art track-row__verdict" aria-hidden>
                {hit === 'correct' ? '+1' : '−1'}
              </span>
            ) : (
              option.albumArt && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="track-row__art" src={option.albumArt} alt="" />
            ))}
            <span className="track-row__text">
              <span className="track-row__title">{option.title}</span>
              <span className="track-row__artist">{option.artist}</span>
            </span>
          </button>
          );
        })}
      </div>
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
          {rush.timeControl === null ? '∞' : formatTimeControl(rush.timeControl)} run
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
        {summary.correct.length === 0 && summary.wrong.length === 0 ? (
          <p className="empty">Not a single song — the clock was ruthless.</p>
        ) : (
          <>
            {summary.correct.length > 0 ? (
              <SongList songs={summary.correct} tone="good" />
            ) : (
              <p className="empty">Nothing landed this run — every guess missed.</p>
            )}
            {summary.wrong.length > 0 ? (
              <SongList songs={summary.wrong} tone="bad" />
            ) : (
              <p className="empty">A clean run — you didn&rsquo;t miss once.</p>
            )}
          </>
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