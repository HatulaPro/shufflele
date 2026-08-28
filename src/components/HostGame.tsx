'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import JoinForm from '@/components/JoinForm';
import PlayerList from '@/components/PlayerList';
import Round from '@/components/Round';
import RushGame from '@/components/RushGame';
import { api } from '@/lib/client';
import { MIN_RUSH_POOL } from '@/lib/types';
import type { LobbyMode, PublicLobby } from '@/lib/types';

const TIME_CONTROL_KEY = 'shufflele:rush-time-control';

const MODE_LABEL: Record<LobbyMode, string> = { classic: 'Classic', rush: 'Rush' };

export default function HostGame({ code }: { code: string }) {
  const router = useRouter();
  const [lobby, setLobby] = useState<PublicLobby | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roundNumber, setRoundNumber] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** Set the moment this phone's own playlist goes in, before the next poll. */
  const [justJoined, setJustJoined] = useState(false);
  const [closing, setClosing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Kept apart from `loadError`, which swaps out the whole screen. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** Which mode the toggle is mid-flight to, so both halves can go quiet. */
  const [switching, setSwitching] = useState<LobbyMode | null>(null);
  const [origin, setOrigin] = useState('');
  /** Rush mode: seconds on the clock, 0 = infinite. A default beats making everyone read three options.
      The last pick sticks around on this phone — hosts tend to run the same clock every night. */
  const [timeControl, setTimeControl] = useState<0 | 60 | 120>(() => {
    if (typeof window === 'undefined') return 60;
    const saved = Number(window.localStorage.getItem(TIME_CONTROL_KEY));
    return saved === 0 || saved === 60 || saved === 120 ? saved : 60;
  });

  const pickTimeControl = (value: 0 | 60 | 120) => {
    setTimeControl(value);
    window.localStorage.setItem(TIME_CONTROL_KEY, String(value));
  };
  /** Set once a Rush game exists — covers both starting one and resuming after a refresh. */
  const [rushActive, setRushActive] = useState(false);
  /**
   * Auto-resume fires at most once per mount. After that this phone's own
   * navigation is the authority: a host who just walked back to the lobby must
   * not be dragged into the song again by the poll that follows — including
   * when the request that cleared the flag server-side didn't land.
   */
  const resumed = useRef(false);

  useEffect(() => setOrigin(window.location.origin), []);

  // Poll only while we're sitting in the lobby. Once a round is running the
  // round component does its own polling. SPEC §2: the host polls, nothing
  // is pushed.
  useEffect(() => {
    if (roundNumber !== null || rushActive) return;
    let alive = true;

    const load = async () => {
      try {
        const next = await api<PublicLobby>(`/api/lobby/${code}`);
        if (!alive) return;
        setLobby(next);
        setLoadError(null);
        // Resume whatever screen this lobby had open, after a refresh. Both
        // modes answer the same question — "is one of my screens open?" — off
        // their own flag; `currentRound` cannot be that flag, because it stays
        // set for the rest of the lobby's life once a song has played.
        if (!resumed.current) {
          if (next.mode === 'classic' && next.activeRound !== null) {
            resumed.current = true;
            setRoundNumber(next.activeRound);
          } else if (next.mode === 'rush' && next.rushActive) {
            resumed.current = true;
            setRushActive(true);
          }
        }
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : 'Lost the lobby.');
      }
    };

    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [code, roundNumber, rushActive]);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      if (lobby?.mode === 'rush') {
        await api(`/api/lobby/${code}/rush/start`, {
          method: 'POST',
          body: JSON.stringify({ timeControl }),
        });
        resumed.current = true;
        setRushActive(true);
      } else {
        const { n } = await api<{ n: number }>(`/api/lobby/${code}/start`, { method: 'POST' });
        setRoundNumber(n);
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the round.');
    } finally {
      setStarting(false);
    }
  }, [code, lobby?.mode, timeControl]);

  /**
   * Moving the room to the other mode. The lobby is the same lobby afterwards —
   * same code, same players, same pooled music — so nobody re-joins and nobody
   * pastes a playlist again, which is the whole point of the toggle.
   *
   * Only reachable from this screen, which is also why it needs no "are you
   * sure": a run or a song in progress has its own screen, and getting back
   * here means the host already left it.
   */
  const changeMode = useCallback(
    async (mode: LobbyMode) => {
      if (switching || lobby?.mode === mode) return;
      setSwitching(mode);
      setStartError(null);
      try {
        setLobby(
          await api<PublicLobby>(`/api/lobby/${code}`, {
            method: 'PATCH',
            body: JSON.stringify({ mode }),
          }),
        );
      } catch (err) {
        setStartError(err instanceof Error ? err.message : 'Could not switch modes.');
      } finally {
        setSwitching(null);
      }
    },
    [code, lobby?.mode, switching],
  );

  /**
   * Nothing has started yet, so a removal here is immediate: the player and
   * their tracks are gone by the time the response lands. Mid-game the same
   * route defers to the next song — see lib/lobby.ts.
   */
  const removePlayer = useCallback(
    async (id: string) => {
      setRemoving(id);
      setRemoveError(null);
      try {
        setLobby(await api<PublicLobby>(`/api/lobby/${code}/players/${id}`, { method: 'DELETE' }));
      } catch (err) {
        setRemoveError(err instanceof Error ? err.message : 'Could not remove that player.');
      } finally {
        setRemoving(null);
      }
    },
    [code],
  );

  /**
   * Out of the song and back to this screen. The round is spent either way, so
   * the request is best-effort — `resumed` is what actually keeps the poll from
   * putting the song back on screen a moment later.
   */
  const leaveRound = useCallback(
    async (n: number) => {
      resumed.current = true;
      setRoundNumber(null);
      try {
        await api(`/api/lobby/${code}/round/${n}`, { method: 'DELETE' });
      } catch {
        // The flag is cleared on the next start anyway; the only cost is a
        // refresh landing back on a song this phone has already walked out of.
      }
    },
    [code],
  );

  /**
   * Ending the game closes the lobby outright — the code is freed and this
   * phone lands back on the home screen, where a new one can be created or a
   * code typed in. The navigation happens either way: once the host has said
   * they're done, a failed DELETE shouldn't strand them here.
   */
  const close = useCallback(async () => {
    setClosing(true);
    try {
      await api(`/api/lobby/${code}`, { method: 'DELETE' });
    } catch {
      // The lobby expires on its own. Nothing useful to say here.
    }
    router.replace('/');
  }, [code, router]);

  if (lobby?.mode === 'rush' && rushActive) {
    return <RushGame code={code} onBack={() => setRushActive(false)} />;
  }

  if (roundNumber !== null) {
    return (
      <Round
        key={roundNumber}
        code={code}
        n={roundNumber}
        starting={starting}
        startError={startError}
        onNext={start}
        onLeave={() => leaveRound(roundNumber)}
      />
    );
  }

  if (loadError) {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <p className="notice notice--error">{loadError}</p>
          <Link className="btn btn--ghost btn--block" href="/" style={{ textAlign: 'center' }}>
            Start over
          </Link>
        </div>
      </main>
    );
  }

  if (!lobby) {
    return (
      <main className="shell shell--center">
        <p className="muted">
          <span className="spinner" /> Opening the lobby…
        </p>
      </main>
    );
  }

  if (!lobby.isHost) {
    return (
      <main className="shell shell--center">
        <div className="stack">
          <h1 className="wordmark wordmark--sm">shufflele</h1>
          <p className="notice">
            This phone isn&rsquo;t the host of lobby {lobby.code} — the host screen only opens on
            the phone that created it.
          </p>
          <Link
            className="btn btn--primary btn--block"
            href={`/join/${lobby.code}`}
            style={{ textAlign: 'center' }}
          >
            Join instead
          </Link>
        </div>
      </main>
    );
  }

  /**
   * Rush deals a board of {MIN_RUSH_POOL} rows and wants a distinct song behind
   * every one of them, so a thin pool greys the option out rather than letting
   * the host find out by tapping start.
   *
   * Measured against the pooled track count, which is an over-estimate — the
   * real gate counts distinct songs, minus whatever Rush has since found
   * unplayable. Reading it exactly would mean pulling the whole tracklist down
   * every two seconds for a button's disabled attribute, which is a megabyte a
   * poll to catch a lobby whose playlists are near-identical *and* tiny. The
   * start route still checks properly, and says what's missing.
   */
  const rushReady = lobby.trackCount >= MIN_RUSH_POOL;
  const played = lobby.currentRound > 0;
  const startLabel = starting
    ? lobby.mode === 'rush'
      ? 'Dealing…'
      : 'Picking a song…'
    : lobby.mode === 'rush'
      ? 'Start rush'
      : played
        ? 'Next song'
        : 'Start game';

  return (
    <main className="shell">
      <div className="row-between">
        <h1 className="wordmark wordmark--sm">shufflele</h1>
        <span className="chip">{lobby.trackCount} tracks pooled</span>
      </div>

      <div className="code-plate">
        <span className="eyebrow">Lobby code</span>
        <p className="code-plate__code">{lobby.code}</p>
        <p className="tiny" style={{ marginTop: 8 }}>
          Everyone else opens {origin ? origin.replace(/^https?:\/\//, '') : 'this site'} → Join
        </p>
      </div>

      <section className="card card--flush">
        <div className="row-between" style={{ padding: '13px 14px 11px' }}>
          <h2 className="h2">Players</h2>
          <span className="tiny">{lobby.players.length} in</span>
        </div>
        <PlayerList players={lobby.players} onRemove={removePlayer} removing={removing} />
      </section>

      {removeError && <p className="notice notice--error">{removeError}</p>}

      {/* The lobby remembers which player is the host's, so a refresh mid-setup
          no longer offers to add a second one. `justJoined` covers the couple of
          seconds before the poll catches up. */}
      {!justJoined && !lobby.players.some((p) => p.isHost) && (
        <section className="card">
          <h2 className="h2" style={{ marginBottom: 10 }}>
            Add your own playlist
          </h2>
          <JoinForm code={code} submitLabel="Add mine" onJoined={() => setJustJoined(true)} />
        </section>
      )}

      {startError && <p className="notice notice--error">{startError}</p>}

      <div className="stack stack--tight" style={{ marginTop: 'auto' }}>
        <div className="field">
          <span className="label">Mode</span>
          <div className="seg seg--two" role="radiogroup" aria-label="Game mode">
            {(['classic', 'rush'] as const).map((mode) => (
              <button
                key={mode}
                role="radio"
                aria-checked={lobby.mode === mode}
                className={`seg__btn ${lobby.mode === mode ? 'seg__btn--on' : ''}`}
                onClick={() => changeMode(mode)}
                disabled={switching !== null || starting || (mode === 'rush' && !rushReady)}
              >
                {switching === mode ? <span className="spinner" /> : MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          {!rushReady && (
            <p className="tiny">
              Rush needs {MIN_RUSH_POOL} songs in the pool to fill a board. Add another playlist.
            </p>
          )}
        </div>

        {lobby.mode === 'rush' && (
          <div className="field">
            <span className="label">Time control</span>
            <div className="seg" role="radiogroup" aria-label="Time control">
              {(
                [
                  [60, '1 min'],
                  [120, '2 min'],
                  [0, '∞'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={timeControl === value}
                  aria-label={value === 0 ? 'No clock' : undefined}
                  className={`seg__btn ${value === 0 ? 'seg__btn--inf' : ''} ${
                    timeControl === value ? 'seg__btn--on' : ''
                  }`}
                  onClick={() => pickTimeControl(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          className="btn btn--primary btn--block"
          onClick={start}
          disabled={!lobby.canStart || starting || switching !== null}
        >
          {startLabel}
        </button>
        {!lobby.canStart && (
          <p className="tiny" style={{ textAlign: 'center' }}>
            Waiting for at least one playlist.
          </p>
        )}
        {/* The one place the lobby can actually be closed. Every screen inside a
            game now comes back here instead of ending it, so the door out of the
            whole thing belongs on the screen those doors lead to. */}
        <button className="btn btn--quiet btn--block" onClick={close} disabled={closing}>
          {closing ? 'Ending…' : 'End game'}
        </button>
      </div>
    </main>
  );
}
