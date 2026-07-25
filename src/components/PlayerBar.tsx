'use client';

import type { CSSProperties } from 'react';
import type { StemPlayer } from '@/hooks/useStemPlayer';
import { formatTime } from '@/lib/client';

/** Playback controls: play/pause, ±5s, volume, scrubber. SPEC §1.2. */
export default function PlayerBar({ player }: { player: StemPlayer }) {
  const { duration, position, playing, volume, loading, error } = player;
  const usable = duration > 0;

  const scrubStyle = {
    '--pct': `${usable ? Math.min(100, (position / duration) * 100) : 0}%`,
  } as CSSProperties;
  const volumeStyle = { '--pct': `${volume * 100}%` } as CSSProperties;

  return (
    <div className="player-bar">
      <input
        className="scrub"
        style={scrubStyle}
        type="range"
        min={0}
        max={usable ? duration : 1}
        step={0.05}
        value={Math.min(position, usable ? duration : 1)}
        onChange={(e) => player.seek(Number(e.target.value))}
        disabled={!usable}
        aria-label="Position"
      />

      <div className="transport">
        <span className="time">{formatTime(position)}</span>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '0 auto' }}>
          <button
            className="iconbtn"
            onClick={() => player.nudge(-5)}
            disabled={!usable}
            aria-label="Back 5 seconds"
          >
            −5
          </button>
          <button
            className="iconbtn iconbtn--play"
            onClick={player.toggle}
            disabled={loading && !usable}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {loading && !usable ? <span className="spinner" /> : playing ? '❚❚' : '▶'}
          </button>
          <button
            className="iconbtn"
            onClick={() => player.nudge(5)}
            disabled={!usable}
            aria-label="Forward 5 seconds"
          >
            +5
          </button>
        </div>

        <span className="time">{formatTime(duration)}</span>
      </div>

      <div className="volume">
        <span className="tiny">Vol</span>
        <input
          style={volumeStyle}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </div>

      {error && <p className="tiny">{error}</p>}
    </div>
  );
}
