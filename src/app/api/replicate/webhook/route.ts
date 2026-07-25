import crypto from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { loadRound, saveRound } from '@/lib/lobby';
import type { Prediction } from '@/lib/replicate';
import { verifyWebhookSignature } from '@/lib/replicate';
import { applyPrediction } from '@/lib/separation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Demucs completion. Writes the stem URLs into the round key; the host's poll
 * picks them up on its next tick. SPEC §3.3.
 *
 * Two independent gates: the standard-webhooks signature, and an unguessable
 * per-round key carried in the callback URL.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();

  if (!verifyWebhookSignature(req.headers, raw)) {
    return NextResponse.json({ error: 'Bad signature.' }, { status: 401 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code') ?? '';
  const n = Number.parseInt(url.searchParams.get('n') ?? '', 10);
  const key = url.searchParams.get('k') ?? '';

  if (!code || !Number.isFinite(n) || !key) {
    return NextResponse.json({ error: 'Missing round reference.' }, { status: 400 });
  }

  const round = await loadRound(code, n);
  if (!round || !safeEqual(key, round.webhookKey)) {
    // Nothing to write to. Return 200 so Replicate doesn't retry forever.
    return NextResponse.json({ ok: true });
  }

  // Late duplicate for a round that already moved on.
  if (round.state !== 'preparing') return NextResponse.json({ ok: true });

  let prediction: Prediction;
  try {
    prediction = JSON.parse(raw) as Prediction;
  } catch {
    return NextResponse.json({ error: 'Malformed payload.' }, { status: 400 });
  }

  await saveRound(await applyPrediction(round, prediction));
  return NextResponse.json({ ok: true });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
