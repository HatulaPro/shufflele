'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import JoinForm from '@/components/JoinForm';
import Round from '@/components/Round';
import { api } from '@/lib/client';
import type { PublicLobby } from '@/lib/types';

export default function HostGame({ code }: { code: string }) {
  const [lobby, setLobby] = useState<PublicLobby | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roundNumber, setRoundNumber] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [hostJoined, setHostJoined] = useState(false);
  const [origin, setOrigin] = useState('');

  useEffect(() => setOrigin(window.location.origin), []);

  // Poll only while we're sitting in the lobby. Once a round is running the
  // round component does its own polling. SPEC §2: the host polls, nothing
  // is pushed.
  useEffect(() => {
    if (roundNumber !== null) return;
    let alive = true;

    const load = async () => {
      try {
        const next = await api<PublicLobby>(`/api/lobby/${code}`);
        if (!alive) return;
        setLobby(next);
        setLoadError(null);
        // Resume an in-flight round after a refresh.
        if (next.currentRound > 0) setRoundNumber(next.currentRound);
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
  }, [code, roundNumber]);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { n } = await api<{ n: number }>(`/api/lobby/${code}/start`, { method: 'POST' });
      setRoundNumber(n);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the round.');
    } finally {
      setStarting(false);
    }
  }, [code]);

  if (roundNumber !== null) {
    return (
      <Round
        key={roundNumber}
        code={code}
        n={roundNumber}
        starting={starting}
        startError={startError}
        onNext={start}
        onLobby={() => {
          setStartError(null);
          setRoundNumber(null);
        }}
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
        {lobby.players.length === 0 ? (
          <p className="empty">Nobody yet. Read out the code.</p>
        ) : (
          <ul className="players">
            {lobby.players.map((player) => (
              <li className="player" key={player.id}>
                <span className="player__dot" />
                <span className="player__name">{player.name}</span>
                <span className="player__meta">
                  {player.playlistName}
                  <br />
                  {player.trackCount} tracks
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!hostJoined && (
        <section className="card">
          <h2 className="h2" style={{ marginBottom: 10 }}>
            Add your own playlist
          </h2>
          <JoinForm code={code} submitLabel="Add mine" onJoined={() => setHostJoined(true)} />
        </section>
      )}

      {startError && <p className="notice notice--error">{startError}</p>}

      <div className="stack stack--tight" style={{ marginTop: 'auto' }}>
        <button
          className="btn btn--primary btn--block"
          onClick={start}
          disabled={!lobby.canStart || starting}
        >
          {starting ? 'Picking a song…' : 'Start game'}
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
