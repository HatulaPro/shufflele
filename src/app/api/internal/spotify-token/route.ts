import { fetchBrokeredToken, probeBroker } from '@/lib/broker';

/**
 * The one reason this route exists: **the Edge runtime does not use Node's TLS
 * stack**, and the token broker is behind a Cloudflare check that refuses
 * Node's ClientHello outright. See lib/broker.ts for the full finding.
 *
 * So the token fetch is carved out of the ingest path and put here, and the
 * Node functions that actually read playlists call this over HTTP once an hour
 * — the result is cached in Redis for the whole deployment (lib/spotify.ts).
 *
 * This is a private hop, not an API: it hands out an access token, and while
 * that token is one chosic.com already gives the whole internet, an open relay
 * for it is nobody's idea of a good time. INTERNAL_API_SECRET gates it, and the
 * route is disabled outright when that isn't configured.
 */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

function authorize(req: Request): Response | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return Response.json({ error: 'INTERNAL_API_SECRET is not configured.' }, { status: 503 });
  }
  if (req.headers.get('x-internal-secret') !== secret) {
    return Response.json({ error: 'Not for you.' }, { status: 403 });
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const denied = authorize(req);
  if (denied) return denied;

  const token = await fetchBrokeredToken();
  if (!token) return Response.json({ error: 'Broker refused.' }, { status: 502 });

  return Response.json(token);
}

/**
 * Diagnostics. The whole Edge-runtime gamble rests on whether Cloudflare scores
 * this runtime's TLS handshake as a bot, and that is only answerable from a
 * real deployment — `next dev` emulates Edge on Node. This reports the raw
 * outcome of the broker call without handing back the token, so it can be
 * curled by hand while debugging a deployment.
 */
export async function GET(req: Request): Promise<Response> {
  const denied = authorize(req);
  if (denied) return denied;

  return Response.json(await probeBroker());
}
