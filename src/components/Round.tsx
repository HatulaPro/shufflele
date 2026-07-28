'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import GuessModal from '@/components/GuessModal';
import Ladder from '@/components/Ladder';
import PlayerBar from '@/components/PlayerBar';
import { SILENCE_FLOOR_DB, useStemPlayer } from '@/hooks/useStemPlayer';
import { api } from '@/lib/client';
import type { Candidate, PublicRound } from '@/lib/types';

type Props = {
  code: string;
  n: number;
  starting: boolean;
  startError: string | null;
  closing: boolean;
  onNext: () => void;
  onClose: () => void;
};

/**
 * How long each loading line stays on screen. Long enough to read twice and
 * still land — six seconds churned through the whole set before the stems were
 * ready, which is what made them feel repetitive. SPEC §1.2.
 */
const QUIP_SECONDS = 11;
/** Shown until the real lines arrive, and if the fetch fails outright. */
const FALLBACK_QUIP = 'Digging through everyone’s questionable taste…';

/**
 * "1.4B" / "153M" / "5.4M" / "312K". Rounded hard on purpose — the exact figure
 * is noise on a chip, and a precise number invites reading it as a leaderboard.
 *
 * The decimal only survives below 10, where it's the difference between 1.4B
 * and 2.1B. Past that it's both meaningless and expensive: three chips at
 * "153.1M plays" width wrap to a second line on a 375px phone.
 */
function compactPlays(views: number): string {
  if (views < 1e3) return String(views);
  // Boundaries sit where the rounding lands, not on the round number: 999.9M
  // views has to read as "1B", never "1000M".
  const [value, unit] =
    views >= 999.5e6 ? [views / 1e9, 'B'] : views >= 999.5e3 ? [views / 1e6, 'M'] : [views / 1e3, 'K'];
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)}${unit}`;
}

export default function Round({
  code,
  n,
  starting,
  startError,
  closing,
  onNext,
  onClose,
}: Props) {
  const [round, setRound] = useState<PublicRound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [quips, setQuips] = useState<string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const ladderPosted = useRef(false);

  const player = useStemPlayer(round?.stems ?? [], round?.activeStems ?? []);

  const over = round?.state === 'won' || round?.state === 'lost';
  useEffect(() => {
    if (over && player.playing) player.toggle();
  }, [over, player.playing, player.toggle]);

  // Host polls every 2s while the separation is in flight, then stops.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const next = await api<PublicRound>(`/api/lobby/${code}/round/${n}`);
        if (!alive) return;
        setRound(next);
        setError(null);
        if (next.state === 'preparing') timer = setTimeout(load, 2000);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Lost contact with the round.');
        timer = setTimeout(load, 3000);
      }
    };

    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [code, n]);

  const waiting = !round || round.state === 'preparing' || round.state === 'ready';

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  // Loading-screen lines. One fetch per round, and a failure is silent — this is
  // decoration, and the fallback line covers it.
  useEffect(() => {
    // `waiting` starts true, so this fires on mount; the guard only bites on a
    // round resumed mid-play, which never shows the loading screen.
    if (!waiting || quips.length > 0) return;
    let alive = true;
    api<{ quips: string[] }>(`/api/lobby/${code}/quips`)
      .then((body) => {
        if (alive) setQuips(body.quips);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, n, waiting, quips.length]);

  // Silence check. The browser has the decoded buffers, so it measures RMS and
  // reports the dead stems; the server drops their rows before the guess screen
  // renders. SPEC §3.3.
  useEffect(() => {
    if (!round || round.state !== 'ready' || ladderPosted.current) return;
    if (!player.decoded && !player.error) return;

    ladderPosted.current = true;
    const silent = round.stems
      .filter((s) => {
        const level = player.levels[s.stem];
        return level === undefined || level < SILENCE_FLOOR_DB;
      })
      .map((s) => s.stem);

    void api<PublicRound>(`/api/lobby/${code}/round/${n}/ladder`, {
      method: 'POST',
      body: JSON.stringify({ silent }),
    })
      .then(setRound)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not open the round.'),
      );
  }, [round, player.decoded, player.error, player.levels, code, n]);

  const openModal = useCallback(async () => {
    setModalOpen(true);
    if (candidates || candidatesLoading) return;

    setCandidatesLoading(true);
    try {
      const body = await api<{ candidates: Candidate[] }>(`/api/lobby/${code}/candidates`);
      setCandidates(body.candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the song list.');
    } finally {
      setCandidatesLoading(false);
    }
  }, [candidates, candidatesLoading, code]);

  const send = useCallback(
    async (payload: { trackId?: string; skip?: boolean }) => {
      setBusy(true);
      try {
        const next = await api<PublicRound>(`/api/lobby/${code}/round/${n}/guess`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setRound(next);
        setModalOpen(false);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That guess did not go through.');
      } finally {
        setBusy(false);
      }
    },
    [code, n],
  );

  /**
   * Leaving a song is nearly always "give me a different one", so the exit asks
   * that first. The other way out ends the game: the lobby is closed and the
   * phone goes back to the home screen.
   */
  const leavePrompt = leaving && (
    <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label="Leave song">
      <div className="card stack">
        <h2 className="h1">That's it?</h2>
        <p className="muted">GGs I guess</p>
        <button className="btn btn--ghost btn--block" onClick={onClose} disabled={closing}>
          {closing ? 'Ending…' : 'Yeah, end the game'}
        </button>
        <button className="btn btn--quiet btn--block" onClick={() => setLeaving(false)}>
          Keep playing
        </button>
      </div>
    </div>
  );

  const askToLeave = () => setLeaving(true);

  // --- loading -----------------------------------------------------------

  if (waiting) {
    const progress = Math.round(Math.min(0.94, 1 - Math.exp(-elapsed / 20)) * 100);
    // Derived from the elapsed counter rather than a second timer, so the line
    // and the bar can never drift apart.
    const slot = Math.floor(elapsed / QUIP_SECONDS);
    const quip = quips.length > 0 ? quips[slot % quips.length]! : FALLBACK_QUIP;

    return (
      <main className="shell">
        <div className="row-between">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <span className="chip">Song {n}</span>
        </div>

        <div className="card stack">
          {/* Keyed so every new line replays the fade instead of swapping flat. */}
          <p className="quip" key={quip}>
            {quip}
          </p>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${progress}%` }} />
          </div>
          <p className="tiny" style={{ textAlign: 'center' }}>
            This usually takes a minute.
          </p>
        </div>

        {error && <p className="notice notice--error">{error}</p>}

        <button
          className="btn btn--quiet btn--block"
          onClick={askToLeave}
          style={{ marginTop: 'auto' }}
        >
          End game
        </button>

        {leavePrompt}
      </main>
    );
  }

  // --- separation failed -------------------------------------------------

  if (round.state === 'failed') {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <h1 className="h1">That one didn&rsquo;t work out</h1>
          <p className="notice notice--error">{round.error ?? 'The separation failed.'}</p>
          {startError && <p className="notice notice--error">{startError}</p>}
          <button className="btn btn--primary btn--block" onClick={onNext} disabled={starting}>
            {starting ? 'Picking…' : 'Try another song'}
          </button>
          <button className="btn btn--quiet btn--block" onClick={askToLeave}>
            End game
          </button>
        </div>

        {leavePrompt}
      </main>
    );
  }

  // --- result ------------------------------------------------------------

  if (round.reveal) {
    const won = round.state === 'won';
    const burned = round.rows.filter((row) => row.guess).length;

    return (
      <main className="shell">
        <div className={`verdict ${won ? 'verdict--win' : 'verdict--lose'}`}>
          <p className="verdict__word">{won ? 'Got it' : 'Nope'}</p>
          {won && (
            <p className="muted">
              {burned} {burned === 1 ? 'row' : 'rows'} used
              {round.par ? ` — par ${round.par}` : ''}
            </p>
          )}
        </div>

        <div className="card stack">
          <div className="reveal">
            {round.reveal.albumArt && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="reveal__art" src={round.reveal.albumArt} alt="" />
            )}
            <div className="grow">
              <div className="reveal__title">{round.reveal.title}</div>
              <div className="reveal__artist">{round.reveal.artist}</div>
              <p className="tiny" style={{ marginTop: 6 }}>
                From {round.reveal.contributor}&rsquo;s playlist
                {round.reveal.releaseYear ? ` · ${round.reveal.releaseYear}` : ''}
              </p>
            </div>
          </div>

          <iframe
            className="embed"
            src={`https://open.spotify.com/embed/track/${round.reveal.spotifyId}`}
            title="Spotify player"
            allow="encrypted-media; clipboard-write"
            loading="lazy"
          />
        </div>

        <Ladder rows={round.rows} />

        {startError && <p className="notice notice--error">{startError}</p>}

        <div className="stack stack--tight" style={{ marginTop: 'auto' }}>
          <button className="btn btn--primary btn--block" onClick={onNext} disabled={starting}>
            {starting ? 'Picking…' : 'Next song'}
          </button>
          <button className="btn btn--quiet btn--block" onClick={askToLeave}>
            End game
          </button>
        </div>

        {leavePrompt}
      </main>
    );
  }

  // --- guessing ----------------------------------------------------------

  return (
    <main className="shell">
      <div className="row-between">
        <button className="btn btn--quiet" onClick={askToLeave}>
          End game
        </button>
        <span className="tiny">
          Row {round.currentRow} of {round.totalRows}
        </span>
      </div>

      {/* Header metadata is deliberately non-identifying. SPEC §1.2. */}
      {(round.releaseYear || round.par || round.playCount) && (
        <div className="meta-bar">
          {round.releaseYear && <span className="chip">Released {round.releaseYear}</span>}
          {round.playCount && (
            <span className="chip" title={`${round.playCount.toLocaleString()} YouTube views`}>
              {compactPlays(round.playCount)} plays
            </span>
          )}
          {round.par && (
            <span className="chip chip--accent">
              {round.difficulty} · par {round.par}
            </span>
          )}
        </div>
      )}

      <Ladder rows={round.rows} />

      <PlayerBar player={player} />

      {error && <p className="notice notice--error">{error}</p>}

      <div className="btn-pair" style={{ marginTop: 'auto' }}>
        <button className="btn btn--ghost" onClick={() => send({ skip: true })} disabled={busy}>
          Skip
        </button>
        <button className="btn btn--primary" onClick={openModal} disabled={busy}>
          Guess
        </button>
      </div>

      {modalOpen && (
        <GuessModal
          candidates={candidates}
          loading={candidatesLoading}
          guessed={round.guessedTrackIds}
          busy={busy}
          onPick={(trackId) => send({ trackId })}
          onClose={() => setModalOpen(false)}
        />
      )}

      {leavePrompt}
    </main>
  );
}
