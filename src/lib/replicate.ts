import crypto from 'node:crypto';
import { isMockPredictionId, mockEnabled, mockPrediction, mockPredictionId } from './mock';
import type { StemName } from './types';

const DEFAULT_MODEL = 'ryan5453/demucs';

export type PredictionStatus = 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export type Prediction = {
  id: string;
  status: PredictionStatus;
  output?: unknown;
  error?: string | null;
};

function token(): string {
  const t = process.env.REPLICATE_API_TOKEN;
  if (!t) throw new Error('REPLICATE_API_TOKEN is not configured.');
  return t;
}

/** Public origin of this deployment, used to build the webhook callback URL. */
export function baseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

type CachedVersion = { model: string; id: string; at: number };
let cachedVersion: CachedVersion | null = null;
const VERSION_TTL_MS = 60 * 60 * 1000;

/**
 * Resolves the model's current version hash.
 *
 * `POST /v1/models/{owner}/{name}/predictions` would avoid this, but that
 * endpoint exists only for Replicate's *official* models — for a community
 * model like ryan5453/demucs it 404s, which is indistinguishable from a
 * misspelled model name. Community models go through `POST /v1/predictions`
 * with a `version`. Looking the version up at runtime keeps the "no hash to go
 * stale" property; it's memoised per process so it costs one extra request an
 * hour at most.
 */
async function latestVersionId(model: string): Promise<string> {
  if (cachedVersion?.model === model && Date.now() - cachedVersion.at < VERSION_TTL_MS) {
    return cachedVersion.id;
  }

  const res = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { Authorization: `Bearer ${token()}` },
    cache: 'no-store',
  });

  if (res.status === 404) {
    throw new Error(`Replicate has no model called ${model}. Check REPLICATE_DEMUCS_MODEL.`);
  }
  if (!res.ok) {
    throw new Error(`Could not look up ${model} on Replicate (${res.status}).`);
  }

  const body = (await res.json()) as { latest_version?: { id?: string } };
  const id = body.latest_version?.id;
  if (!id) throw new Error(`${model} has no published version on Replicate.`);

  cachedVersion = { model, id, at: Date.now() };
  return id;
}

/**
 * Kicks off a 4-stem separation and returns immediately. Demucs cold starts
 * routinely outrun a Hobby function's 60s ceiling, so the request is never
 * held open — the webhook (or the round route's poll) writes the result.
 * SPEC §3.3.
 */
export async function createSeparation(audioUrl: string, webhookUrl: string): Promise<Prediction> {
  // The mock split is the only one that isn't really a split: the four parts
  // were synthesised separately in the first place (lib/mockaudio.ts), so
  // "separating" them is handing back the URLs they were mixed from. Everything
  // downstream is unchanged — the prediction is created, the round sits in
  // `preparing`, and the round route's poll resolves it a couple of seconds
  // later through `applyPrediction` exactly as a real one resolves.
  if (mockEnabled()) {
    return { id: mockPredictionId(audioUrl), status: 'starting' };
  }

  const model = process.env.REPLICATE_DEMUCS_MODEL || DEFAULT_MODEL;

  // Replicate refuses a non-HTTPS callback with a 422 that kills the whole
  // prediction, not just the callback — so on http origins (localhost, mainly)
  // the webhook is omitted entirely and the round route's poll delivers the
  // result instead. That fallback is always on, so nothing else changes.
  const useWebhook = webhookUrl.startsWith('https://');
  if (!useWebhook) {
    console.warn(
      `[replicate] ${webhookUrl.split('://')[0]}:// callback URL — running without a webhook and relying on polling. Set NEXT_PUBLIC_BASE_URL to an https origin in production.`,
    );
  }

  const version = await latestVersionId(model);

  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version,
      input: {
        // The preview mp3 is already a public URL, so nothing is downloaded
        // into or uploaded out of the function. SPEC §3.3.
        audio: audioUrl,
        // htdemucs, not htdemucs_6s — the 6-stem guitar/piano outputs are
        // frequently near-silent and produce dead rounds. SPEC §3.3.
        // The field is `model`; `model_name` is silently ignored, which leaves
        // the choice to the wrapper's default instead of ours.
        model: 'htdemucs',
        output_format: 'mp3',
        mp3_bitrate: 128,
      },
      ...(useWebhook
        ? { webhook: webhookUrl, webhook_events_filter: ['completed'] }
        : {}),
    }),
    cache: 'no-store',
  });

  if (res.status === 429) {
    // Replicate tightens this to ~6/min with a burst of 1 while the account
    // holds less than $5 in credit, which two people starting rounds at once
    // will hit. Say that, rather than a raw 429 body.
    throw new Error(
      'Replicate is rate-limiting us — wait a few seconds and start the round again. (Accounts under $5 of credit get a much tighter limit.)',
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Replicate rejected the prediction (${res.status}): ${detail.slice(0, 300)}`);
  }

  return (await res.json()) as Prediction;
}

export async function getPrediction(id: string): Promise<Prediction | null> {
  if (isMockPredictionId(id)) {
    const { status, output } = mockPrediction(id);
    return { id, status, output };
  }

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Bearer ${token()}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as Prediction;
}

const STEM_NAMES: StemName[] = ['drums', 'bass', 'other', 'vocals'];

/**
 * Demucs wrappers differ in output shape between versions: usually an object
 * keyed by stem name, occasionally an array of URLs in the canonical order.
 * Handle both rather than pinning ourselves to one wrapper's schema.
 */
export function parseStems(output: unknown): Partial<Record<StemName, string>> {
  const stems: Partial<Record<StemName, string>> = {};
  if (!output) return stems;

  if (Array.isArray(output)) {
    output.forEach((value, i) => {
      const name = STEM_NAMES[i];
      if (name && typeof value === 'string') stems[name] = value;
    });
    return stems;
  }

  if (typeof output === 'object') {
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      const name = STEM_NAMES.find((s) => key.toLowerCase().includes(s));
      if (name && typeof value === 'string' && value.startsWith('http')) stems[name] = value;
    }
  }

  return stems;
}

/**
 * Replicate signs webhooks with the standard-webhooks (svix) scheme:
 * HMAC-SHA256 over `{id}.{timestamp}.{body}`, base64, in a space-separated
 * `v1,<sig>` list.
 */
export function verifyWebhookSignature(headers: Headers, rawBody: string): boolean {
  const secret = process.env.REPLICATE_WEBHOOK_SECRET;
  // Without a configured secret the per-round key in the callback URL is the
  // only gate. Fine for local dev; .env.example says to set this in prod.
  if (!secret) return true;

  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatureHeader = headers.get('webhook-signature');
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject replays of anything older than five minutes.
  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent) || Math.abs(Date.now() / 1000 - sent) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);

  return signatureHeader
    .split(' ')
    .map((part) => part.split(',')[1] ?? '')
    .some((candidate) => {
      const candidateBuf = Buffer.from(candidate);
      return (
        candidateBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(candidateBuf, expectedBuf)
      );
    });
}
