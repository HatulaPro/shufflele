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
  onNext: () => void;
  onLobby: () => void;
};

/** A progress narrative, not a spinner. SPEC §1.2. */
const STEPS = ['Finding the track', 'Separating the drums', 'Almost there'];

export default function Round({ code, n, starting, startError, onNext, onLobby }: Props) {
  const [round, setRound] = useState<PublicRound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const ladderPosted = useRef(false);

  const player = useStemPlayer(round?.stems ?? [], round?.activeStems ?? []);

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

  // --- loading -----------------------------------------------------------

  if (waiting) {
    const step = round?.state === 'ready' ? 2 : elapsed < 7 ? 0 : elapsed < 28 ? 1 : 2;
    const progress = Math.round(Math.min(0.94, 1 - Math.exp(-elapsed / 20)) * 100);

    return (
      <main className="shell">
        <div className="row-between">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <span className="chip">Song {n}</span>
        </div>

        <div className="card stack">
          <p className="narrative">{STEPS[step]}…</p>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${progress}%` }} />
          </div>
          <ul className="narrative__steps">
            {STEPS.map((label, index) => (
              <li
                className="narrative__step"
                key={label}
                data-state={index < step ? 'done' : index === step ? 'active' : 'waiting'}
              >
                <span className="narrative__pip">{index < step ? '✓' : ''}</span>
                {label}
              </li>
            ))}
          </ul>
        </div>

        <p className="tiny">
          Splitting a track into stems takes 20–40 seconds, or up to two minutes if the GPU was
          asleep. Nobody needs to look at their phone.
        </p>

        {error && <p className="notice notice--error">{error}</p>}

        <button className="btn btn--quiet btn--block" onClick={onLobby} style={{ marginTop: 'auto' }}>
          Back to lobby
        </button>
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
          <button className="btn btn--quiet btn--block" onClick={onLobby}>
            Back to lobby
          </button>
        </div>
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
          <p className="muted">
            {won
              ? `${burned} ${burned === 1 ? 'row' : 'rows'} used — par ${round.par}`
              : 'Every row burned.'}
          </p>
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
                From &ldquo;{round.reveal.contributor}&rdquo;
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
          <button className="btn btn--quiet btn--block" onClick={onLobby}>
            Back to lobby
          </button>
        </div>
      </main>
    );
  }

  // --- guessing ----------------------------------------------------------

  return (
    <main className="shell">
      <div className="row-between">
        <button className="btn btn--quiet" onClick={onLobby}>
          ‹ Lobby
        </button>
        <span className="tiny">
          Row {round.currentRow} of {round.totalRows}
        </span>
      </div>

      {/* Header metadata is deliberately non-identifying. SPEC §1.2. */}
      <div className="meta-bar">
        {round.releaseYear && <span className="chip">Released {round.releaseYear}</span>}
        <span className="chip chip--accent">
          {round.difficulty} · par {round.par}
        </span>
      </div>

      <Ladder rows={round.rows} />

      {round.clue && <p className="notice notice--clue">{round.clue}</p>}

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
    </main>
  );
}
