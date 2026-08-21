'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import JoinForm from '@/components/JoinForm';
import PlayerList from '@/components/PlayerList';
import Round from '@/components/Round';
import RushGame from '@/components/RushGame';
import { api } from '@/lib/client';
import type { PublicLobby } from '@/lib/types';

export default function HostGame({ code }: { code: string }) {
  const router = useRouter();
  const [lobby, setLobby] = useState<PublicLobby | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roundNumber, setRoundNumber] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** Set the moment this phone's own playlist goes in, before the next poll. */
  const [justJoined, setJustJoined] = useState(false);
  const [closing, setClosing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Kept apart from `loadError`, which swaps out the whole screen. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  /** Rush mode: seconds on the clock, 0 = infinite. A default beats making everyone read three options. */
  const [timeControl, setTimeControl] = useState<0 | 30 | 60>(60);
  /** Set once a Rush game exists — covers both starting one and resuming after a refresh. */
  const [rushActive, setRushActive] = useState(false);
  /** The lobby keeps `currentRound` set after a round ends, so the resume below
      must only ever fire once — otherwise leaving a round bounces straight back
      into it on the next poll. */
  const resumed = useRef(false);

  useEffect(() => setOrigin(window.location.origin), []);

  // Poll only while we're sitting in the lobby. Once a round is running the
  // round component does its own polling. SPEC §2: the host polls, nothing
  // is pushed.
  useEffect(() => {
    if (roundNumber !== null || rushActive) return;
    let alive = true;

    const load = async () => {
      try {
        const next = await api<PublicLobby>(`/api/lobby/${code}`);
        if (!alive) return;
        setLobby(next);
        setLoadError(null);
        // Resume an in-flight round after a refresh.
        if (!resumed.current && next.currentRound > 0) {
          resumed.current = true;
          setRoundNumber(next.currentRound);
        }
        if (!resumed.current && next.mode === 'rush' && next.rushActive) {
          resumed.current = true;
          setRushActive(true);
        }
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : 'Lost the lobby.');
      }
    };

    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [code, roundNumber, rushActive]);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      if (lobby?.mode === 'rush') {
        await api(`/api/lobby/${code}/rush/start`, {
          method: 'POST',
          body: JSON.stringify({ timeControl }),
        });
        resumed.current = true;
        setRushActive(true);
      } else {
        const { n } = await api<{ n: number }>(`/api/lobby/${code}/start`, { method: 'POST' });
        setRoundNumber(n);
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the round.');
    } finally {
      setStarting(false);
    }
  }, [code, lobby?.mode, timeControl]);

  /**
   * Nothing has started yet, so a removal here is immediate: the player and
   * their tracks are gone by the time the response lands. Mid-game the same
   * route defers to the next song — see lib/lobby.ts.
   */
  const removePlayer = useCallback(
    async (id: string) => {
      setRemoving(id);
      setRemoveError(null);
      try {
        setLobby(await api<PublicLobby>(`/api/lobby/${code}/players/${id}`, { method: 'DELETE' }));
      } catch (err) {
        setRemoveError(err instanceof Error ? err.message : 'Could not remove that player.');
      } finally {
        setRemoving(null);
      }
    },
    [code],
  );

  /**
   * Ending the game closes the lobby outright — the code is freed and this
   * phone lands back on the home screen, where a new one can be created or a
   * code typed in. The navigation happens either way: once the host has said
   * they're done, a failed DELETE shouldn't strand them in the round.
   */
  const close = useCallback(async () => {
    setClosing(true);
    try {
      await api(`/api/lobby/${code}`, { method: 'DELETE' });
    } catch {
      // The lobby expires on its own. Nothing useful to say here.
    }
    router.replace('/');
  }, [code, router]);

  if (lobby?.mode === 'rush' && rushActive) {
    return <RushGame code={code} closing={closing} onClose={close} onBack={() => setRushActive(false)} />;
  }

  if (roundNumber !== null) {
    return (
      <Round
        key={roundNumber}
        code={code}
        n={roundNumber}
        starting={starting}
        startError={startError}
        closing={closing}
        onNext={start}
        onClose={close}
      />
    );
  }

  if (loadError) {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <p className="notice notice--error">{loadError}</p>
          <Link className="btn btn--ghost btn--block" href="/" style={{ textAlign: 'center' }}>
            Start over
          </Link>
        </div>
      </main>
    );
  }

  if (!lobby) {
    return (
      <main className="shell shell--center">
        <p className="muted">
          <span className="spinner" /> Opening the lobby…
        </p>
      </main>
    );
  }

  if (!lobby.isHost) {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <p className="notice">
            This phone isn&rsquo;t the host of lobby {lobby.code} — the host screen only opens on
            the phone that created it.
          </p>
          <Link
            className="btn btn--primary btn--block"
            href={`/join/${lobby.code}`}
            style={{ textAlign: 'center' }}
          >
            Join instead
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="row-between">
        <h1 className="wordmark wordmark--sm">shufflele</h1>
        <span className="chip">{lobby.trackCount} tracks pooled</span>
      </div>

      <div className="code-plate">
        <span className="eyebrow">Lobby code</span>
        <p className="code-plate__code">{lobby.code}</p>
        <p className="tiny" style={{ marginTop: 8 }}>
          Everyone else opens {origin ? origin.replace(/^https?:\/\//, '') : 'this site'} → Join
        </p>
      </div>

      <section className="card card--flush">
        <div className="row-between" style={{ padding: '13px 14px 11px' }}>
          <h2 className="h2">Players</h2>
          <span className="tiny">{lobby.players.length} in</span>
        </div>
        <PlayerList players={lobby.players} onRemove={removePlayer} removing={removing} />
      </section>

      {removeError && <p className="notice notice--error">{removeError}</p>}

      {/* The lobby remembers which player is the host's, so a refresh mid-setup
          no longer offers to add a second one. `justJoined` covers the couple of
          seconds before the poll catches up. */}
      {!justJoined && !lobby.players.some((p) => p.isHost) && (
        <section className="card">
          <h2 className="h2" style={{ marginBottom: 10 }}>
            Add your own playlist
          </h2>
          <JoinForm code={code} submitLabel="Add mine" onJoined={() => setJustJoined(true)} />
        </section>
      )}

      {startError && <p className="notice notice--error">{startError}</p>}

      <div className="stack stack--tight" style={{ marginTop: 'auto' }}>
        {lobby.mode === 'rush' && (
          <div className="field">
            <span className="label">Time control</span>
            <div className="seg" role="radiogroup" aria-label="Time control">
              {(
                [
                  [30, '30 sec'],
                  [60, '1 min'],
                  [0, '∞'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={timeControl === value}
                  className={`seg__btn ${timeControl === value ? 'seg__btn--on' : ''}`}
                  onClick={() => setTimeControl(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          className="btn btn--primary btn--block"
          onClick={start}
          disabled={!lobby.canStart || starting}
        >
          {starting
            ? lobby.mode === 'rush'
              ? 'Dealing…'
              : 'Picking a song…'
            : lobby.mode === 'rush'
              ? 'Start rush'
              : 'Start game'}
        </button>
        {!lobby.canStart && (
          <p className="tiny" style={{ textAlign: 'center' }}>
            Waiting for at least one playlist.
          </p>
        )}
      </div>
    </main>
  );
}
