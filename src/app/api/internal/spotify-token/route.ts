import { fetchBrokeredToken } from '@/lib/broker';

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

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return Response.json({ error: 'INTERNAL_API_SECRET is not configured.' }, { status: 503 });
  }
  if (req.headers.get('x-internal-secret') !== secret) {
    return Response.json({ error: 'Not for you.' }, { status: 403 });
  }

  const token = await fetchBrokeredToken();
  if (!token) {
    // The caller only needs "no token"; the status is here because this is the
    // route you curl by hand to find out whether Edge gets past Cloudflare.
    return Response.json({ error: 'Broker refused.' }, { status: 502 });
  }

  return Response.json(token);
}
