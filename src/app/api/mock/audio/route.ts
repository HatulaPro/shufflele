import type { NextRequest } from 'next/server';
import { mockEnabled, mockTrackInfo } from '@/lib/mock';
import { type MockAudioKind, isMockAudioKind, renderMockAudio } from '@/lib/mockaudio';

export const dynamic = 'force-dynamic';

/**
 * Serves the synthesised preview and stems that stand in for iTunes and
 * Replicate in mock mode. `?t=` is a mock Spotify id, `?s=` is a stem name or
 * `mix`. See lib/mockaudio.ts for what is actually being played.
 *
 * Range requests are answered properly rather than ignored: `<audio>` asks for
 * one on every load, and Safari refuses to play a source that won't serve one.
 */
function parse(req: NextRequest): { spotifyId: string; kind: MockAudioKind } | null {
  const params = req.nextUrl.searchParams;
  const spotifyId = params.get('t') ?? '';
  const kind = params.get('s') ?? 'mix';
  if (!mockTrackInfo(spotifyId) || !isMockAudioKind(kind)) return null;
  return { spotifyId, kind };
}

function render(req: NextRequest): { body: Buffer; status: number; headers: Headers } | null {
  if (!mockEnabled()) return null;
  const target = parse(req);
  if (!target) return null;

  const wav = renderMockAudio(target.spotifyId, target.kind);

  const headers = new Headers({
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    // Deterministic content under a deterministic URL, but a dev server is
    // where the generator itself gets edited — so it must never be cached.
    'cache-control': 'no-store',
  });

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (range) {
    const start = range[1] ? Number.parseInt(range[1], 10) : 0;
    const end = range[2] ? Math.min(Number.parseInt(range[2], 10), wav.length - 1) : wav.length - 1;
    if (Number.isFinite(start) && start <= end && start < wav.length) {
      const slice = wav.subarray(start, end + 1);
      headers.set('content-range', `bytes ${start}-${end}/${wav.length}`);
      headers.set('content-length', String(slice.length));
      return { body: slice, status: 206, headers };
    }
  }

  headers.set('content-length', String(wav.length));
  return { body: wav, status: 200, headers };
}

export async function GET(req: NextRequest): Promise<Response> {
  const result = render(req);
  if (!result) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(result.body), {
    status: result.status,
    headers: result.headers,
  });
}

/**
 * Answered explicitly because it is load-bearing: the server-side byte-size
 * guard on a finished separation (lib/separation.ts) HEADs every stem and
 * drops any that comes back under 4 KB, so a HEAD with no `content-length`
 * would quietly reduce the ladder.
 */
export async function HEAD(req: NextRequest): Promise<Response> {
  const result = render(req);
  if (!result) return new Response(null, { status: 404 });
  return new Response(null, { status: result.status, headers: result.headers });
}
