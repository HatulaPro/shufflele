'use client';

import { useState } from 'react';
import JoinForm, { type JoinResult } from '@/components/JoinForm';

/**
 * The guest's entire experience: one form, then a thank-you screen. Nothing
 * else is ever rendered on a guest phone. SPEC §1.1.
 */
export default function GuestJoin({ code }: { code: string }) {
  const [done, setDone] = useState<JoinResult | null>(null);

  if (done) {
    return (
      <main className="shell shell--center">
        <div className="thanks">
          <div className="thanks__mark">✓</div>
          <div>
            <h1 className="h1">Thanks</h1>
            <p className="tagline">
              {done.trackCount} {done.trackCount === 1 ? 'track' : 'tracks'} added to the pool.
              {/* Arriving mid-game is allowed; the song already playing just
                  isn't changed by it. */}
              {done.pending && ' You’re in from the next song.'}
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div>
        <h1 className="wordmark wordmark--sm">shufflele</h1>
        <p className="tagline">
          Lobby <strong>{code}</strong>{' '}
          — add one playlist and you&rsquo;re done.
        </p>
      </div>

      <div className="card">
        <JoinForm code={code} onJoined={setDone} />
      </div>
    </main>
  );
}
