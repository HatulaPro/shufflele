'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';
import type { LobbyMode } from '@/lib/types';

// The "new" tag on Rush retires on its own — see the GitHub issue for cleanup.
const RUSH_NEW_UNTIL = Date.parse('2026-08-26T00:00:00Z');

const MODES: {
  mode: LobbyMode;
  name: string;
  blurb: string;
  points: string[];
}[] = [
  {
    mode: 'classic',
    name: 'Classic',
    blurb: 'One song, the whole room guessing out loud.',
    points: ['More of the track kicks in every round', 'Hints, par, and a big reveal'],
  },
  {
    mode: 'rush',
    name: 'Rush',
    blurb: 'Beat the clock. Guess as many songs as you can.',
    points: ['1 min · 2 min · infinite', '3 lives — misses cost one'],
  },
];

export default function Create() {
  const router = useRouter();
  const [busy, setBusy] = useState<LobbyMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rushIsNew = Date.now() < RUSH_NEW_UNTIL;

  const create = async (mode: LobbyMode) => {
    if (busy) return;
    setBusy(mode);
    setError(null);
    try {
      const { code } = await api<{ code: string }>('/api/lobby', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      router.push(`/host/${code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a lobby.');
      setBusy(null);
    }
  };

  return (
    <main className="shell shell--center">
      <div className="stack">
        <div>
          <h1 className="wordmark">shufflele</h1>
          <p className="tagline">How are we playing tonight?</p>
        </div>

        {error && <p className="notice notice--error">{error}</p>}

        <div className="stack">
          {MODES.map(({ mode, name, blurb, points }) => (
            <button
              key={mode}
              className={`mode-card ${busy && busy !== mode ? 'mode-card--dim' : ''}`}
              onClick={() => create(mode)}
              disabled={busy !== null}
            >
              <span className="mode-card__head">
                <span className="mode-card__name">{name}</span>
                {mode === 'rush' && rushIsNew && <span className="badge-new">New</span>}
              </span>
              <span className="mode-card__blurb">{blurb}</span>
              <span className="mode-card__points">
                {points.map((point) => (
                  <span key={point} className="chip">
                    {point}
                  </span>
                ))}
              </span>
              {busy === mode && (
                <span className="mode-card__busy">
                  <span className="spinner" /> Opening…
                </span>
              )}
            </button>
          ))}
        </div>

        <button className="btn btn--quiet btn--block" onClick={() => router.push('/')}>
          Back
        </button>
      </div>
    </main>
  );
}
