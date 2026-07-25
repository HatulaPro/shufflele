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
            <h1 className="h1">You&rsquo;re in</h1>
            <p className="tagline">
              Playing as <strong>{done.name}</strong>.
            </p>
          </div>
          <p className="muted">
            That&rsquo;s everything from your phone. Put it away and watch the host&rsquo;s screen
            — guessing happens out loud.
          </p>
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
          — give us a name and you&rsquo;re done.
        </p>
      </div>

      <div className="card">
        <JoinForm code={code} onJoined={setDone} />
      </div>
    </main>
  );
}
