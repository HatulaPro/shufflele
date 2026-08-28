'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import GuessModal from '@/components/GuessModal';
import Ladder from '@/components/Ladder';
import LobbyPanel from '@/components/LobbyPanel';
import PlayerBar from '@/components/PlayerBar';
import { SILENCE_FLOOR_DB, useStemPlayer } from '@/hooks/useStemPlayer';
import { MOCK, api } from '@/lib/client';
import type { Candidate, PublicRound } from '@/lib/types';

type Props = {
  code: string;
  n: number;
  starting: boolean;
  startError: string | null;
  onNext: () => void;
  /** Back to the lobby, leaving this song behind. See `activeRound` in lib/types.ts. */
  onLeave: () => void;
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
  onNext,
  onLeave,
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
  const [lobbyOpen, setLobbyOpen] = useState(false);
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
        // A wrong guess burns a row and unlocks the next stem, so the mix the
        // player is holding is stale. Stop it and rewind rather than letting the
        // old row keep running under the new one.
        if (payload.trackId && next.state !== 'won') player.stop();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That guess did not go through.');
      } finally {
        setBusy(false);
      }
    },
    [code, n, player.stop],
  );

  /**
   * Walking out mid-song is the one exit worth a question, because the song
   * does not come back: the lobby keeps its place in the count and the next
   * start draws a new one. Off the result screen there is nothing to lose and
   * the same trip is a plain button.
   *
   * Ending the whole game is no longer one of the answers here — that lives in
   * the lobby now, which is where this button goes.
   */
  const leavePrompt = leaving && (
    <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label="Leave song">
      <div className="card stack">
        <h2 className="h1">Leave this song?</h2>
        <p className="muted">It won&rsquo;t come back — the next one is a fresh pick.</p>
        <button className="btn btn--ghost btn--block" onClick={onLeave}>
          Yeah, back to the lobby
        </button>
        <button className="btn btn--quiet btn--block" onClick={() => setLeaving(false)}>
          Keep playing
        </button>
      </div>
    </div>
  );

  const askToLeave = () => setLeaving(true);

  /**
   * The door, without leaving the song. Small and in the same corner on every
   * screen of a round — someone arriving at the party mid-game is a thing that
   * happens, and it shouldn't mean waiting for the song to end.
   */
  const lobbyButton = (
    <button className="btn btn--ghost btn--mini" onClick={() => setLobbyOpen(true)}>
      Lobby
    </button>
  );

  const lobbyPanel = lobbyOpen && <LobbyPanel code={code} onClose={() => setLobbyOpen(false)} />;

  /**
   * The chips that ran above the ladder while guessing. Kept in one place so the
   * result screen shows the same three stats in the same shape — the numbers the
   * player was reasoning from shouldn't change costume once the song is revealed.
   * Header metadata is deliberately non-identifying. SPEC §1.2.
   */
  const metaBar = round &&
    (round.releaseYear || round.par || round.playCount) && (
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
    );

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
          <div className="row-tight">
            {lobbyButton}
            <span className="chip">Song {n}</span>
          </div>
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
          Leave song
        </button>

        {leavePrompt}
        {lobbyPanel}
      </main>
    );
  }

  // --- separation failed -------------------------------------------------

  if (round.state === 'failed') {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <div className="row-between">
            <span className="tiny">Song {n}</span>
            {lobbyButton}
          </div>
          <h1 className="h1">That one didn&rsquo;t work out</h1>
          <p className="notice notice--error">{round.error ?? 'The separation failed.'}</p>
          {startError && <p className="notice notice--error">{startError}</p>}
          <button className="btn btn--primary btn--block" onClick={onNext} disabled={starting}>
            {starting ? 'Picking…' : 'Try another song'}
          </button>
          <button className="btn btn--quiet btn--block" onClick={onLeave}>
            Back to lobby
          </button>
        </div>

        {leavePrompt}
        {lobbyPanel}
      </main>
    );
  }

  // --- result ------------------------------------------------------------

  if (round.reveal) {
    const won = round.state === 'won';
    const burned = round.rows.filter((row) => row.guess).length;

    return (
      <main className="shell">
        <div className="row-between">
          <span className="tiny">Song {n}</span>
          {lobbyButton}
        </div>

        <div className={`verdict ${won ? 'verdict--win' : 'verdict--lose'}`}>
          <p className="verdict__word">{won ? 'Got it' : 'Nope'}</p>
          {won && (
            <p className="muted">
              {burned} {burned === 1 ? 'row' : 'rows'} used
            </p>
          )}
        </div>

        {/* Par lives on the chip below rather than beside the row count: printing
            it twice a line apart reads as a stutter. */}
        {metaBar}

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
                {/* The year is on the chip row above; repeating it here just
                    crowds the credit line. */}
              </p>
            </div>
          </div>

          {/* A mock track has no Spotify id to embed — the player would render
              its "content unavailable" panel, which reads as a broken app
              rather than as a deliberately fake song. */}
          {MOCK ? (
            <div className="embed embed--mock">Mock song — no Spotify player</div>
          ) : (
            <iframe
              className="embed"
              src={`https://open.spotify.com/embed/track/${round.reveal.spotifyId}`}
              title="Spotify player"
              allow="encrypted-media; clipboard-write"
              loading="lazy"
            />
          )}
        </div>

        <Ladder rows={round.rows} />

        {startError && <p className="notice notice--error">{startError}</p>}

        <div className="stack stack--tight" style={{ marginTop: 'auto' }}>
          <button className="btn btn--primary btn--block" onClick={onNext} disabled={starting}>
            {starting ? 'Picking…' : 'Next song'}
          </button>
          <button className="btn btn--quiet btn--block" onClick={onLeave}>
            Back to lobby
          </button>
        </div>

        {leavePrompt}
        {lobbyPanel}
      </main>
    );
  }

  // --- guessing ----------------------------------------------------------

  return (
    <main className="shell">
      <div className="row-between">
        {/* "Leave", not "Lobby": the button on the right opens the roster
            without touching the song, and this one walks out of it. */}
        <button className="btn btn--quiet" onClick={askToLeave}>
          Leave
        </button>
        <div className="row-tight">
          {lobbyButton}
          <span className="tiny">
            Row {round.currentRow} of {round.totalRows}
          </span>
        </div>
      </div>

      {metaBar}

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
      {lobbyPanel}
    </main>
  );
}
