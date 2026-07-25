import { type Prediction, parseStems } from './replicate';
import { PLAYABLE_STEMS, type PlayableStem, type Round } from './types';

/** Anything smaller than this is a broken render, not a quiet stem. */
const MIN_STEM_BYTES = 4096;

/**
 * Server-side half of the silence check (SPEC §3.3).
 *
 * Byte size alone can't tell a quiet stem from a loud one: the stems come back
 * as constant-bitrate mp3, so a silent render weighs the same as a busy one.
 * It *can* catch an empty or truncated file, which is what this does. Real
 * silence detection is RMS over the decoded buffer, which the host's browser
 * runs before the guess screen renders — see useStemPlayer.
 */
async function dropEmptyStems(round: Round): Promise<void> {
  const checks = PLAYABLE_STEMS.map(async (stem) => {
    const url = round.stems[stem];
    if (!url) return;
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const length = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(length) && length < MIN_STEM_BYTES) delete round.stems[stem];
    } catch {
      // A failed HEAD says nothing about the audio; leave the stem in.
    }
  });

  await Promise.all(checks);
}

/**
 * Folds a completed Replicate prediction into the round. Shared by the webhook
 * and by the direct-poll fallback, so both paths agree on the state machine.
 */
export async function applyPrediction(round: Round, prediction: Prediction): Promise<Round> {
  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    round.state = 'failed';
    round.error = prediction.error
      ? `Separation failed: ${String(prediction.error).slice(0, 200)}`
      : 'Separation failed on Replicate.';
    return round;
  }

  if (prediction.status !== 'succeeded') return round;

  round.stems = parseStems(prediction.output);
  await dropEmptyStems(round);

  const usable = PLAYABLE_STEMS.filter((stem) => Boolean(round.stems[stem]));
  if (usable.length === 0) {
    round.state = 'failed';
    round.error = 'Separation finished but produced no usable audio.';
    return round;
  }

  round.state = 'ready';
  round.error = null;
  return round;
}

export function missingStems(round: Round): PlayableStem[] {
  return PLAYABLE_STEMS.filter((stem) => !round.stems[stem]);
}
