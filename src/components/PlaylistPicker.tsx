'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { OwnedPlaylist } from '@/lib/types';

type Props = {
  code: string;
  /** Bumped after each add so the lobby poll picks up the new pool. */
  onAdded: () => void;
};

/**
 * The host picks from their own Spotify playlists. Only playlists this account
 * owns are listed — Spotify refuses to serve the contents of anyone else's.
 */
export default function PlaylistPicker({ code, onAdded }: Props) {
  const [playlists, setPlaylists] = useState<OwnedPlaylist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlaylists(await api<OwnedPlaylist[]>(`/api/lobby/${code}/playlists`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your playlists.');
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (playlist: OwnedPlaylist) => {
    if (adding) return;
    setAdding(playlist.id);
    setError(null);
    try {
      await api(`/api/lobby/${code}/playlists`, {
        method: 'POST',
        body: JSON.stringify({ playlistId: playlist.id }),
      });
      setPlaylists((current) =>
        (current ?? []).map((p) => (p.id === playlist.id ? { ...p, added: true } : p)),
      );
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that playlist.');
    } finally {
      setAdding(null);
    }
  };

  if (error && !playlists) {
    return (
      <div className="stack stack--tight">
        <p className="notice notice--error">{error}</p>
        <button className="btn btn--ghost btn--block" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (!playlists) {
    return (
      <p className="muted">
        <span className="spinner" /> Reading your playlists…
      </p>
    );
  }

  if (playlists.length === 0) {
    return <p className="empty">This Spotify account doesn&rsquo;t own any playlists yet.</p>;
  }

  return (
    <div className="stack stack--tight">
      {error && <p className="notice notice--error">{error}</p>}
      <ul className="players">
        {playlists.map((playlist) => (
          <li className="player" key={playlist.id}>
            <span className="player__name">
              {playlist.name}
              <br />
              <span className="tiny">{playlist.trackCount} tracks</span>
            </span>
            <button
              className="btn btn--ghost"
              onClick={() => void add(playlist)}
              disabled={playlist.added || adding !== null}
            >
              {playlist.added ? 'Added' : adding === playlist.id ? 'Adding…' : 'Add'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
