'use client';

import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  const goCreate = () => router.push('/create');

  return (
    <main className="shell shell--center">
      <div className="stack">
        <div>
          <h1 className="wordmark">shufflele</h1>
          <p className="tagline">
            Guess songs pulled from your friends&rsquo; playlists. 
          </p>
        </div>

        <div className="stack stack--tight">
          <button className="btn btn--primary btn--block" onClick={goCreate}>
            Create lobby
          </button>
          <button className="btn btn--ghost btn--block" onClick={() => router.push('/join')}>
            Join with a code
          </button>
        </div>
      </div>
    </main>
  );
}
