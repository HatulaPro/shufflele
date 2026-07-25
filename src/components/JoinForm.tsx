'use client';

import { type FormEvent, useState } from 'react';
import { api } from '@/lib/client';

export type JoinResult = { name: string };

type Props = {
  code: string;
  onJoined: (result: JoinResult) => void;
  submitLabel?: string;
};

/** Guests bring a name and nothing else — the host builds the track pool. */
export default function JoinForm({ code, onJoined, submitLabel = "I'm in" }: Props) {
  const [name, setName] = useState('');
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
        body: JSON.stringify({ name: name.trim() }),
      });
      onJoined(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join.');
      setBusy(false);
    }
  };

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
          enterKeyHint="go"
        />
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      <button className="btn btn--primary btn--block" type="submit" disabled={!name.trim() || busy}>
        {busy ? (
          <>
            <span className="spinner" /> Joining…
          </>
        ) : (
          submitLabel
        )}
      </button>
    </form>
  );
}
