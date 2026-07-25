'use client';

import { useMemo, useState } from 'react';
import { normalize } from '@/lib/normalize';
import type { Candidate } from '@/lib/types';

const MAX_RESULTS = 60;

type Props = {
  candidates: Candidate[] | null;
  loading: boolean;
  guessed: string[];
  busy: boolean;
  onPick: (trackId: string) => void;
  onClose: () => void;
};

/**
 * Full-screen guess overlay.
 *
 * Deliberately empty until the user types: the candidate list is every track
 * from every playlist, so rendering it unfiltered would hand over the answer
 * set. SPEC §1.4.
 */
export default function GuessModal({ candidates, loading, guessed, busy, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const needle = normalize(query);
    if (!needle || !candidates) return [];
    return candidates.filter((c) => c.search.includes(needle)).slice(0, MAX_RESULTS);
  }, [query, candidates]);

  const already = useMemo(() => new Set(guessed), [guessed]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Guess the song">
      <div className="modal__head">
        <input
          className="input grow"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Song or artist…"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="Search for a song or artist"
        />
        <button className="btn btn--quiet" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>

      <div className="modal__results">
        {loading && (
          <p className="empty">
            <span className="spinner" /> Loading the song list…
          </p>
        )}

        {!loading && !query.trim() && (
          <p className="empty">Start typing a title or an artist.</p>
        )}

        {!loading && query.trim() && results.length === 0 && (
          <p className="empty">Nothing in anyone&rsquo;s playlist matches that.</p>
        )}

        {results.map((candidate) => {
          const done = already.has(candidate.id);
          return (
            <button
              className="result"
              key={candidate.id}
              disabled={done || busy}
              onClick={() => onPick(candidate.id)}
            >
              <span className="result__text">
                <span className="result__title">{candidate.title}</span>
                <span className="result__artist">{candidate.artist}</span>
              </span>
              {done && <span className="result__done">guessed</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
