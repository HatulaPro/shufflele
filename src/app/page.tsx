'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createLobby = async () => {
    setBusy(true);
    setError(null);
    try {
      const { code } = await api<{ code: string }>('/api/lobby', { method: 'POST' });
      router.push(`/host/${code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a lobby.');
      setBusy(false);
    }
  };

  return (
    <main className="shell shell--center">
      <div className="stack">
        <div>
          <h1 className="wordmark">shufflele</h1>
          <p className="tagline">
            Guess songs pulled from your friends&rsquo; playlists. 
          </p>
        </div>

        {error && <p className="notice notice--error">{error}</p>}

        <div className="stack stack--tight">
          <button className="btn btn--primary btn--block" onClick={createLobby} disabled={busy}>
            {busy ? 'Creating…' : 'Create lobby'}
          </button>
          <button className="btn btn--ghost btn--block" onClick={() => router.push('/join')}>
            Join with a code
          </button>
        </div>
      </div>
    </main>
  );
}
