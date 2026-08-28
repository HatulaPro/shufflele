import { rng, seedOf } from './mock';

/**
 * Synthesised stand-in audio, so mock mode has something real to play.
 *
 * A silent file, or the same file four times, would take most of the game with
 * it: the ladder only means anything if the drums, the bass and the melody are
 * audibly different from one another, the host's browser rejects any stem
 * quieter than −45 dBFS before the guess screen renders (see useStemPlayer),
 * and the server drops a stem whose file is under 4 KB (lib/separation.ts). So
 * this writes four genuinely different, genuinely loud instrument parts of the
 * same 30-second song, and a mix of the four for the preview.
 *
 * It is a WAV rather than an mp3 on purpose — a WAV is a header and a block of
 * samples, so there is no encoder to add to the project for something only a
 * dev machine will ever hear. `decodeAudioData` and `<audio>` both take it.
 *
 * The song each track gets is derived from its Spotify id, so a track sounds
 * the same on every deal, and two tracks on one Rush board are in different
 * keys at different tempos — which is what makes it possible to tell by ear
 * whether the right song went on air.
 */

export const MOCK_STEMS = ['drums', 'bass', 'other', 'vocals'] as const;
export type MockStem = (typeof MOCK_STEMS)[number];
/** `mix` is every layer at once — what a preview clip stands in for. */
export type MockAudioKind = MockStem | 'mix';

export function isMockAudioKind(value: string): value is MockAudioKind {
  return value === 'mix' || (MOCK_STEMS as readonly string[]).includes(value);
}

/** Matches a real preview clip, which is what the mock is standing in for. */
const DURATION_SECONDS = 30;

/**
 * Low enough to keep a render cheap and a response small, high enough for a
 * hi-hat to still sound like one. Nothing downstream cares about the rate:
 * `decodeAudioData` resamples to the context's own.
 */
const SAMPLE_RATE = 22_050;

const SAMPLES = DURATION_SECONDS * SAMPLE_RATE;

// --- musical parameters ----------------------------------------------------

/** Natural minor and major, as semitone offsets from the root. */
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
} as const;

/** Chord roots, as scale degrees. Four bars, looping. */
const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 4, 5, 3],
  [5, 3, 0, 4],
  [0, 3, 4, 4],
  [0, 6, 3, 4],
] as const;

type Song = {
  /** MIDI note of the tonic, in the bass octave. */
  root: number;
  scale: readonly number[];
  progression: readonly number[];
  /** Seconds per beat. */
  beat: number;
  /** Melody notes, as scale degrees; -1 is a rest. One per beat. */
  melody: number[];
};

function songFor(spotifyId: string): Song {
  const random = rng(seedOf(`song:${spotifyId}`));
  const scale = random() < 0.55 ? SCALES.minor : SCALES.major;
  const progression = PROGRESSIONS[Math.floor(random() * PROGRESSIONS.length)]!;
  const bpm = 84 + Math.floor(random() * 62);

  // Sixteen beats of tune, which is four bars — the same length as the
  // progression, so the two lock together instead of drifting.
  const melody: number[] = [];
  let degree = 0;
  for (let i = 0; i < 16; i++) {
    if (random() < 0.18) {
      melody.push(-1);
      continue;
    }
    // A stepwise walk with the occasional leap reads as a tune; a uniform draw
    // over the scale reads as noise with pitches.
    degree += random() < 0.75 ? (random() < 0.5 ? -1 : 1) : Math.floor(random() * 5) - 2;
    degree = Math.max(-3, Math.min(9, degree));
    melody.push(degree);
  }

  return {
    root: 33 + Math.floor(random() * 12),
    scale,
    progression,
    beat: 60 / bpm,
    melody,
  };
}

/** Scale degree to MIDI note, wrapping into octaves for degrees outside 0–6. */
function noteAt(song: Song, degree: number, octave: number): number {
  const size = song.scale.length;
  const step = ((degree % size) + size) % size;
  const wrap = Math.floor(degree / size);
  return song.root + song.scale[step]! + 12 * (octave + wrap);
}

function hz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// --- oscillators -----------------------------------------------------------

function sine(phase: number): number {
  return Math.sin(2 * Math.PI * phase);
}

/** Bandlimited enough for this purpose, and warmer than a raw square. */
function triangle(phase: number): number {
  const t = phase - Math.floor(phase);
  return 4 * Math.abs(t - 0.5) - 1;
}

function sawtooth(phase: number): number {
  const t = phase - Math.floor(phase);
  return 2 * t - 1;
}

/** Exponential decay, the envelope every part here uses. */
function decay(time: number, tau: number): number {
  return time < 0 ? 0 : Math.exp(-time / tau);
}

// --- the parts -------------------------------------------------------------

/**
 * Each part writes into `out` for the whole 30 seconds. They are deliberately
 * separated by register as well as by rhythm — kick and bass share the bottom
 * but never the same envelope, and the melody sits an octave above the pad —
 * so the ladder's "drums, then + bass, then + melody" actually reveals
 * something each time a row unlocks.
 */
function renderPart(kind: MockStem, song: Song, seed: number): Float32Array {
  const out = new Float32Array(SAMPLES);
  const random = rng(seed);
  const beats = song.beat * SAMPLE_RATE;

  for (let i = 0; i < SAMPLES; i++) {
    const time = i / SAMPLE_RATE;
    const beatIndex = Math.floor(i / beats);
    const beatTime = (i - beatIndex * beats) / SAMPLE_RATE;
    const bar = Math.floor(beatIndex / 4);
    const beatInBar = beatIndex % 4;
    const chordDegree = song.progression[bar % song.progression.length]!;

    let value = 0;

    if (kind === 'drums') {
      // Kick on 1 and 3, with the pitch drop that makes it read as a kick.
      if (beatInBar === 0 || beatInBar === 2) {
        const env = decay(beatTime, 0.09);
        const pitch = 48 + 110 * decay(beatTime, 0.02);
        value += 0.95 * env * sine(pitch * time);
      }
      // Snare on 2 and 4: noise plus a little body.
      if (beatInBar === 1 || beatInBar === 3) {
        const env = decay(beatTime, 0.07);
        value += 0.5 * env * (random() * 2 - 1);
        value += 0.2 * env * sine(190 * time);
      }
      // Hats on every eighth, quieter, and the offbeat quieter still.
      const eighth = beatTime % (song.beat / 2);
      const offbeat = beatTime >= song.beat / 2;
      value += (offbeat ? 0.1 : 0.16) * decay(eighth, 0.014) * (random() * 2 - 1);
    } else if (kind === 'bass') {
      // One note per beat, walking to the fifth on the last beat of the bar so
      // the line moves rather than pulsing on one pitch.
      const degree = beatInBar === 3 ? chordDegree + 4 : chordDegree;
      const frequency = hz(noteAt(song, degree, 0));
      const env = decay(beatTime, 0.22) * (1 - Math.exp(-beatTime * 400));
      value += 0.85 * env * (0.75 * sine(frequency * time) + 0.25 * triangle(frequency * time));
    } else if (kind === 'other') {
      // A triad pad, one chord per bar, plus an eighth-note arpeggio over it.
      const barTime = (beatIndex % 4) * song.beat + beatTime;
      const swell = Math.min(1, barTime * 6) * decay(barTime, 2.2);
      for (const interval of [0, 2, 4]) {
        const frequency = hz(noteAt(song, chordDegree + interval, 2));
        value += 0.16 * swell * triangle(frequency * time);
      }
      const eighthIndex = Math.floor(i / (beats / 2));
      const eighthTime = (i - eighthIndex * (beats / 2)) / SAMPLE_RATE;
      const arpFrequency = hz(noteAt(song, chordDegree + 2 * (eighthIndex % 3), 3));
      value += 0.2 * decay(eighthTime, 0.1) * sawtooth(arpFrequency * time) * 0.6;
    } else {
      // The tune. Never leaves the server in classic mode — the vocals stem is
      // separated and withheld — but it is what makes the mix identifiable, so
      // it is rendered properly rather than left as a placeholder.
      const degree = song.melody[beatIndex % song.melody.length]!;
      if (degree >= 0) {
        const frequency = hz(noteAt(song, degree, 3));
        // A little vibrato, so it doesn't sound like a test tone.
        const vibrato = 1 + 0.006 * sine(5.5 * time);
        const env = Math.min(1, beatTime * 30) * decay(beatTime, 0.45);
        value += 0.55 * env * (0.7 * sine(frequency * vibrato * time) + 0.3 * triangle(frequency * vibrato * time * 2));
      }
    }

    out[i] = value;
  }

  return out;
}

// --- assembly --------------------------------------------------------------

/** Keeps a busy mix inside the rails without the crunch of a hard clip. */
function softClip(value: number): number {
  return Math.tanh(value);
}

function toWav(samples: Float32Array): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);

  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16); // PCM header length
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  bytes.writeUInt16LE(2, 32); // block align
  bytes.writeUInt16LE(16, 34); // bits per sample
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples.length * 2, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    bytes.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return bytes;
}

/**
 * Rendered files are held in memory, because the same one is asked for
 * repeatedly: the browser fetches each stem to decode it and again to play it,
 * the server HEADs it for the byte-size guard, and a Rush board plays the same
 * few songs all evening. The cap is a handful of files rather than a real LRU —
 * this is a dev-only path, and 30 seconds of mono 16-bit is ~1.3 MB.
 */
const CACHE_LIMIT = 16;
const cache = new Map<string, Buffer>();

export function renderMockAudio(spotifyId: string, kind: MockAudioKind): Buffer {
  const key = `${spotifyId}:${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const song = songFor(spotifyId);
  const seed = (part: string) => seedOf(`${part}:${spotifyId}`);

  let samples: Float32Array;
  if (kind === 'mix') {
    samples = new Float32Array(SAMPLES);
    // The mix is the sum of the very same parts, so what the room hears in the
    // preview really is what the ladder takes apart.
    const gains: Record<MockStem, number> = { drums: 0.8, bass: 0.9, other: 0.7, vocals: 0.9 };
    for (const part of MOCK_STEMS) {
      const layer = renderPart(part, song, seed(part));
      for (let i = 0; i < SAMPLES; i++) samples[i] += layer[i]! * gains[part];
    }
    for (let i = 0; i < SAMPLES; i++) samples[i] = softClip(samples[i]! * 0.75);
  } else {
    samples = renderPart(kind, song, seed(kind));
    for (let i = 0; i < SAMPLES; i++) samples[i] = softClip(samples[i]!);
  }

  const wav = toWav(samples);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, wav);
  return wav;
}
