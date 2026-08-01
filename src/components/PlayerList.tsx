'use client';

import { useState } from 'react';
import type { PublicPlayer } from '@/lib/types';

type Props = {
  players: PublicPlayer[];
  /** Omitted where removing isn't on offer — only the host phone gets it. */
  onRemove?: (id: string) => void;
  /** Id of the player whose removal is in flight. */
  removing?: string | null;
};

/**
 * Both tags are verbs about the player, deliberately. "Next song" was the first
 * label here and it read, next to a name, as "this player is up next" — which is
 * a thing the game genuinely does, so it said roughly the opposite of what it
 * meant. The footer under the list carries the full sentence.
 */
const TAG: Record<PublicPlayer['status'], string | null> = {
  in: null,
  joining: 'joins next',
  leaving: 'leaving',
};

/**
 * The roster, on the pre-game screen and in the in-game panel both. Never the
 * playlist's name: the host screen faces the room and a playlist title gives the
 * game away. SPEC §1.5.
 */
export default function PlayerList({ players, onRemove, removing }: Props) {
  /** Removal is one tap then a confirm, on the row itself. */
  const [armed, setArmed] = useState<string | null>(null);

  if (players.length === 0) {
    return <p className="empty">Nobody yet. Read out the code.</p>;
  }

  return (
    <ul className="players">
      {players.map((player) => {
        const tag = TAG[player.status];
        const busy = removing === player.id;

        return (
          <li className={`player${tag ? ' player--waiting' : ''}`} key={player.id}>
            <span className="player__dot" />
            <span className="player__name">{player.name}</span>
            {player.isHost && <span className="player__tag">host</span>}
            {tag && <span className="player__tag">{tag}</span>}
            <span className="player__meta">{player.trackCount} tracks</span>

            {/* The host runs the game from this phone; there is no removing
                them, and the missing button is the honest way to say so. */}
            {onRemove && !player.isHost && player.status !== 'leaving' && (
              <button
                className={`btn btn--quiet player__kick${armed === player.id ? ' player__kick--armed' : ''}`}
                onClick={() => {
                  if (armed === player.id) {
                    setArmed(null);
                    onRemove(player.id);
                  } else {
                    setArmed(player.id);
                  }
                }}
                onBlur={() => setArmed((id) => (id === player.id ? null : id))}
                disabled={busy}
                aria-label={armed === player.id ? `Confirm removing ${player.name}` : `Remove ${player.name}`}
              >
                {busy ? <span className="spinner" /> : armed === player.id ? 'Sure?' : '✕'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
