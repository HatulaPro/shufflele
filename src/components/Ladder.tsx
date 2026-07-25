'use client';

import type { GuessLog, PublicRow } from '@/lib/types';

/**
 * The numbered vertical list. Every logged guess is rendered inside the row it
 * burned, coloured by how close it was. SPEC §1.5.
 */
export default function Ladder({ rows }: { rows: PublicRow[] }) {
  return (
    <div className="ladder">
      {rows.map((row) => (
        <div className="lrow" key={row.index} data-state={row.state}>
          <span className="lrow__num">{row.index}</span>
          <div className="lrow__body">
            <div className="lrow__label">
              <span>{row.label}</span>
              {row.state === 'locked' && !row.guess && <span className="lrow__lock">locked</span>}
            </div>
            <div className="lrow__sub">{row.sub}</div>
            {row.guess && <GuessChip guess={row.guess} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function GuessChip({ guess }: { guess: GuessLog }) {
  if (guess.kind === 'skip') {
    return <div className="guess-chip">Skipped</div>;
  }

  return (
    <div className="guess-chip" data-tier={guess.tier ?? 'none'}>
      {guess.artist} — {guess.title}
      {/* Only the playlist tier gets extra text, and it names the player who
          contributed the playlist, not the playlist itself. SPEC §1.5. */}
      {guess.tier === 'playlist' && guess.contributor && (
        <span className="guess-chip__extra">From {guess.contributor}&rsquo;s playlist</span>
      )}
    </div>
  );
}
