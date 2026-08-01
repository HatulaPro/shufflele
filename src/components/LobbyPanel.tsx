'use client';

import { useCallback, useEffect, useState } from 'react';
import PlayerList from '@/components/PlayerList';
import { api } from '@/lib/client';
import type { PublicLobby } from '@/lib/types';

type Props = { code: string; onClose: () => void };

/**
 * The lobby, reachable from inside a song. Everything the host needs to run the
 * door without stopping the game: who is in, how much music each of them put in,
 * the code to read out to a latecomer, and a way to remove someone.
 *
 * Both kinds of change land on the next song, never this one, and the roster
 * says so per row — see lib/lobby.ts for why.
 */
export default function LobbyPanel({ code, onClose }: Props) {
  const [lobby, setLobby] = useState<PublicLobby | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Polled while open, at the same 2s as the pre-game screen: the host holds
  // this open precisely while waiting for someone's phone to come through.
  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const next = await api<PublicLobby>(`/api/lobby/${code}`);
        if (alive) setLobby(next);
      } catch {
        // Leave the last good roster on screen; the round's own poll is what
        // tells the host something is actually wrong.
      }
    };

    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [code]);

  const remove = useCallback(
    async (id: string) => {
      setRemoving(id);
      setError(null);
      try {
        setLobby(await api<PublicLobby>(`/api/lobby/${code}/players/${id}`, { method: 'DELETE' }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not remove that player.');
      } finally {
        setRemoving(null);
      }
    },
    [code],
  );

  const waiting = lobby?.players.some((p) => p.status !== 'in') ?? false;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Lobby">
      <div className="modal__head">
        <h2 className="h1 grow">Lobby</h2>
        <button className="btn btn--ghost btn--mini" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="stack modal__body">
        <div className="code-plate">
          <span className="eyebrow">Lobby code</span>
          <p className="code-plate__code">{code}</p>
          <p className="tiny" style={{ marginTop: 8 }}>
            Anyone can still join — they add a playlist and it&rsquo;s in from the next song.
          </p>
        </div>

        {error && <p className="notice notice--error">{error}</p>}

        <section className="card card--flush">
          <div className="row-between" style={{ padding: '13px 14px 11px' }}>
            <h3 className="h2">Players</h3>
            <span className="tiny">{lobby ? `${lobby.trackCount} tracks in play` : 'Loading…'}</span>
          </div>
          <PlayerList
            players={lobby?.players ?? []}
            onRemove={lobby?.isHost ? remove : undefined}
            removing={removing}
          />
        </section>

        {waiting && (
          <p className="tiny" style={{ textAlign: 'center' }}>
            Changes take effect on the next song. This one plays out as it is.
          </p>
        )}
      </div>
    </div>
  );
}
