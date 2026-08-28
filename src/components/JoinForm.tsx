'use client';

import { type FormEvent, useState } from 'react';
import { MOCK, api } from '@/lib/client';

export type JoinResult = {
  playlistName: string;
  trackCount: number;
  /** Joined mid-game: the tracks are in from the next song, not this one. */
  pending: boolean;
};

type Props = {
  code: string;
  onJoined: (result: JoinResult) => void;
  /** Label for the submit button — the host's inline copy differs. */
  submitLabel?: string;
  defaultName?: string;
};

export default function JoinForm({ code, onJoined, submitLabel = 'Send it in', defaultName = '' }: Props) {
  const [name, setName] = useState(() => defaultName || (typeof window !== 'undefined' ? localStorage.getItem('shufflele:name') ?? '' : ''));
  const [playlistUrl, setPlaylistUrl] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('shufflele:playlistUrl') ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api<JoinResult>(`/api/lobby/${code}/join`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), playlistUrl }),
      });
      localStorage.setItem('shufflele:name', name.trim());
      localStorage.setItem('shufflele:playlistUrl', playlistUrl);
      onJoined(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that playlist.');
      setBusy(false);
    }
  };

  const ready = name.trim().length > 0 && playlistUrl.trim().length > 0;

  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="player-name">
          Your name
        </label>
        <input
          id="player-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 24))}
          placeholder="Sam"
          autoComplete="nickname"
          enterKeyHint="next"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="playlist-url">
          {MOCK ? 'Playlist' : 'Public Spotify playlist link'}
        </label>
        <input
          id="playlist-url"
          className="input"
          value={playlistUrl}
          onChange={(e) => setPlaylistUrl(e.target.value)}
          placeholder={MOCK ? 'anything — try "rock"' : 'https://open.spotify.com/playlist/…'}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <p className="tiny">
          {MOCK ? (
            <>
              Mock mode: nothing is read from Spotify. Any word makes its own playlist out
              of the fake catalogue, and the same word always makes the same one.
            </>
          ) : (
            <>
              It has to be public. In Spotify: playlist → <strong>⋯</strong> → Edit details
              → Public.
            </>
          )}
        </p>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      <button className="btn btn--primary btn--block" type="submit" disabled={!ready || busy}>
        {busy ? (
          <>
            <span className="spinner" /> Reading your playlist…
          </>
        ) : (
          submitLabel
        )}
      </button>
    </form>
  );
}
