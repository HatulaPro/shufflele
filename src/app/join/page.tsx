'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

export default function JoinCodePage() {
  const router = useRouter();
  const [code, setCode] = useState('');

  const valid = /^\d{6}$/.test(code);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) router.push(`/join/${code}`);
  };

  return (
    <main className="shell shell--center">
      <form className="stack" onSubmit={submit}>
        <div>
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <h2 className="h1" style={{ marginTop: 10 }}>
            Enter the code
          </h2>
          <p className="tagline">It&rsquo;s on the host&rsquo;s phone, six digits.</p>
        </div>

        <input
          className="input input--code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="Six digit lobby code"
          autoFocus
        />

        <button className="btn btn--primary btn--block" type="submit" disabled={!valid}>
          Continue
        </button>

        <Link className="btn btn--quiet btn--block" href="/" style={{ textAlign: 'center' }}>
          Back
        </Link>
      </form>
    </main>
  );
}
