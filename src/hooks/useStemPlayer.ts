'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayableStem } from '@/lib/types';

/** A stem quieter than this is treated as dead and loses its row. SPEC §3.3. */
export const SILENCE_FLOOR_DB = -45;

export type StemSource = { stem: PlayableStem; url: string };

type Nodes = { source: AudioBufferSourceNode; gain: GainNode };

export type StemPlayer = {
  loading: boolean;
  /** Every provided stem has been fetched and decoded. */
  decoded: boolean;
  error: string | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  /** RMS in dBFS per stem, filled in as each one decodes. */
  levels: Partial<Record<PlayableStem, number>>;
  toggle: () => void;
  /** Halts playback and rewinds to the top. */
  stop: () => void;
  seek: (seconds: number) => void;
  nudge: (delta: number) => void;
  setVolume: (value: number) => void;
};

/** RMS over the whole buffer, sampled with a stride so it stays instant. */
function rmsDb(buffer: AudioBuffer): number {
  let sum = 0;
  let count = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    const stride = Math.max(1, Math.floor(data.length / 100_000));
    for (let i = 0; i < data.length; i += stride) {
      sum += data[i] * data[i];
      count++;
    }
  }

  if (count === 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(Math.max(Math.sqrt(sum / count), 1e-9));
}

/** Promise form where available, callback form for older Safari. */
function decode(ctx: AudioContext, raw: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const maybe = ctx.decodeAudioData(raw, resolve, reject);
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

/**
 * Plays a set of stems in lockstep.
 *
 * Multiple <audio> elements drift apart within seconds, so every stem is an
 * AudioBufferSourceNode started at the same AudioContext timestamp. Source
 * nodes are one-shot, so seeking means tearing them all down and recreating
 * them at the new offset. SPEC §3.4.
 */
export function useStemPlayer(sources: StemSource[], active: PlayableStem[]): StemPlayer {
  const sourceKey = sources
    .map((s) => `${s.stem}:${s.url}`)
    .sort()
    .join('|');
  const activeKey = [...active].sort().join(',');

  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const activeRef = useRef(active);
  activeRef.current = active;

  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const buffersRef = useRef(new Map<string, AudioBuffer>());
  const nodesRef = useRef<Nodes[]>([]);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const [decodedUrls, setDecodedUrls] = useState<Set<string>>(() => new Set());
  const [levels, setLevels] = useState<Partial<Record<PlayableStem, number>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);

  const playingRef = useRef(false);
  playingRef.current = playing;
  const durationRef = useRef(0);
  durationRef.current = duration;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const getCtx = useCallback((): AudioContext => {
    if (ctxRef.current) return ctxRef.current;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('This browser cannot play Web Audio.');

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = volumeRef.current;
    master.connect(ctx.destination);
    ctxRef.current = ctx;
    masterRef.current = master;
    return ctx;
  }, []);

  const stopNodes = useCallback(() => {
    for (const node of nodesRef.current) {
      try {
        node.source.stop();
      } catch {
        // already stopped
      }
      node.source.disconnect();
      node.gain.disconnect();
    }
    nodesRef.current = [];
  }, []);

  const livePosition = useCallback((): number => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) return offsetRef.current;
    return offsetRef.current + Math.max(0, ctx.currentTime - startedAtRef.current);
  }, []);

  /** Recreates one node per active stem, all started at the same timestamp. */
  const startAt = useCallback(
    (offset: number): boolean => {
      const ctx = getCtx();
      stopNodes();

      const buffers = sourcesRef.current
        .filter((s) => activeRef.current.includes(s.stem))
        .map((s) => buffersRef.current.get(s.url))
        .filter((b): b is AudioBuffer => Boolean(b));

      if (buffers.length === 0) return false;

      const longest = buffers.reduce((max, b) => Math.max(max, b.duration), 0);
      const from = Math.min(Math.max(0, offset), Math.max(0, longest - 0.05));
      // A small lead means every node is scheduled before the clock reaches it.
      const when = ctx.currentTime + 0.06;

      for (const buffer of buffers) {
        const gain = ctx.createGain();
        gain.connect(masterRef.current as GainNode);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.start(when, from);
        nodesRef.current.push({ source, gain });
      }

      startedAtRef.current = when;
      offsetRef.current = from;
      return true;
    },
    [getCtx, stopNodes],
  );

  // Fetch + decode everything we've been handed. Buffers are cached by URL, so
  // unlocking a row never refetches a stem the silence check already decoded.
  useEffect(() => {
    const list = sourcesRef.current;
    const missing = list.filter((s) => !buffersRef.current.has(s.url));

    if (missing.length === 0) {
      setDecodedUrls((prev) => {
        if (list.every((s) => prev.has(s.url))) return prev;
        const next = new Set(prev);
        for (const s of list) next.add(s.url);
        return next;
      });
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const ctx = getCtx();
        await Promise.all(
          missing.map(async ({ stem, url }) => {
            const res = await fetch(url, { cache: 'force-cache' });
            if (!res.ok) throw new Error(`Could not load the ${stem} stem.`);
            const buffer = await decode(ctx, await res.arrayBuffer());
            if (cancelled) return;

            buffersRef.current.set(url, buffer);
            setLevels((prev) => ({ ...prev, [stem]: rmsDb(buffer) }));
            setDecodedUrls((prev) => new Set(prev).add(url));
            setDuration((prev) => Math.max(prev, buffer.duration));
          }),
        );
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'The audio failed to load.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sourceKey, getCtx]);

  // Position ticker.
  useEffect(() => {
    if (!playing) return;

    const tick = () => {
      const ctx = ctxRef.current;
      if (ctx) {
        const pos = offsetRef.current + Math.max(0, ctx.currentTime - startedAtRef.current);
        const end = durationRef.current;
        if (end && pos >= end) {
          stopNodes();
          offsetRef.current = 0;
          setPosition(end);
          setPlaying(false);
          return;
        }
        setPosition(pos);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, stopNodes]);

  // A newly unlocked stem doesn't restart playback conceptually, but in
  // practice it has to: restart from the same offset with the new node set.
  useEffect(() => {
    if (!playingRef.current) return;

    const wanted = sourcesRef.current.filter(
      (s) => activeRef.current.includes(s.stem) && buffersRef.current.has(s.url),
    ).length;
    if (wanted === nodesRef.current.length) return;

    const pos = livePosition();
    if (!startAt(pos)) setPlaying(false);
  }, [activeKey, decodedUrls, startAt, livePosition]);

  useEffect(() => {
    return () => {
      stopNodes();
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    };
  }, [stopNodes]);

  const toggle = useCallback(() => {
    const ctx = getCtx();
    // iOS only unlocks the context inside a user gesture — this is that gesture.
    if (ctx.state === 'suspended') void ctx.resume();

    if (playingRef.current) {
      const pos = livePosition();
      stopNodes();
      offsetRef.current = pos;
      setPosition(pos);
      setPlaying(false);
      return;
    }

    const end = durationRef.current;
    const from = end && offsetRef.current >= end - 0.05 ? 0 : offsetRef.current;
    if (startAt(from)) {
      setPosition(from);
      setPlaying(true);
    }
  }, [getCtx, livePosition, startAt, stopNodes]);

  const stop = useCallback(() => {
    stopNodes();
    offsetRef.current = 0;
    setPosition(0);
    setPlaying(false);
  }, [stopNodes]);

  const seek = useCallback(
    (seconds: number) => {
      const end = durationRef.current || seconds;
      const target = Math.min(Math.max(0, seconds), end);
      const wasPlaying = playingRef.current;

      stopNodes();
      offsetRef.current = target;
      setPosition(target);

      if (wasPlaying && !startAt(target)) setPlaying(false);
    },
    [startAt, stopNodes],
  );

  const nudge = useCallback(
    (delta: number) => {
      seek(livePosition() + delta);
    },
    [livePosition, seek],
  );

  const setVolume = useCallback((value: number) => {
    const clamped = Math.min(1, Math.max(0, value));
    setVolumeState(clamped);
    if (masterRef.current) masterRef.current.gain.value = clamped;
  }, []);

  return {
    loading,
    decoded: sources.length > 0 && sources.every((s) => decodedUrls.has(s.url)),
    error,
    playing,
    position,
    duration,
    volume,
    levels,
    toggle,
    stop,
    seek,
    nudge,
    setVolume,
  };
}
