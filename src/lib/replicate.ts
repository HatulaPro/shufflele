import crypto from 'node:crypto';
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

/**
 * Kicks off a 4-stem separation and returns immediately. Demucs cold starts
 * routinely outrun a Hobby function's 60s ceiling, so the request is never
 * held open — the webhook writes the result. SPEC §3.3.
 *
 * The prediction runs the model's *latest* version (the
 * `/models/{owner}/{name}/predictions` endpoint), so there's no version hash
 * to keep in sync here.
 */
export async function createSeparation(audioUrl: string, webhookUrl: string): Promise<Prediction> {
  const model = process.env.REPLICATE_DEMUCS_MODEL || DEFAULT_MODEL;

  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        // The iTunes preview is already a public URL, so nothing is downloaded
        // into or uploaded out of the function. SPEC §3.3.
        audio: audioUrl,
        // htdemucs, not htdemucs_6s — the 6-stem guitar/piano outputs are
        // frequently near-silent and produce dead rounds. SPEC §3.3.
        model_name: 'htdemucs',
        output_format: 'mp3',
        mp3_bitrate: 128,
      },
      webhook: webhookUrl,
      webhook_events_filter: ['completed'],
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Replicate rejected the prediction (${res.status}): ${detail.slice(0, 300)}`);
  }

  return (await res.json()) as Prediction;
}

export async function getPrediction(id: string): Promise<Prediction | null> {
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
