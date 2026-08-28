import type { NextRequest } from 'next/server';
import { mockCoverPalette, mockEnabled, mockTrackInfo } from '@/lib/mock';

export const dynamic = 'force-dynamic';

/**
 * Album art for the mock catalogue, drawn rather than fetched — Spotify's CDN
 * would serve a real cover happily enough, but a mock that reaches the network
 * for anything is a mock that fails on a train.
 *
 * Each cover is a two-tone gradient keyed to the track id plus the song's own
 * title and artist, which matters more than it sounds: the reveal screen, the
 * Rush board and the guess list are all rows of small square tiles, and the
 * only way to see at a glance that the right one came back is for them to look
 * different from each other and to say what they are.
 */
function escape(text: string): string {
  return text.replace(/[<>&]/g, (character) =>
    character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&amp;',
  );
}

/** Rough character budget for one line at this size, so long titles wrap. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.map((entry) => (entry.length > perLine ? `${entry.slice(0, perLine - 1)}…` : entry));
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!mockEnabled()) return new Response('Not found', { status: 404 });

  const spotifyId = req.nextUrl.searchParams.get('t') ?? '';
  const track = mockTrackInfo(spotifyId);
  if (!track) return new Response('Not found', { status: 404 });

  const { from, to, ink } = mockCoverPalette(spotifyId);
  const titleLines = wrap(track.title, 18, 3);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300" role="img">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="300" height="300" fill="url(#g)"/>
  <circle cx="230" cy="70" r="86" fill="${ink}" opacity="0.08"/>
  <circle cx="60" cy="250" r="120" fill="${ink}" opacity="0.06"/>
  <g fill="${ink}" font-family="Helvetica, Arial, sans-serif">
    <text x="24" y="${196 - (titleLines.length - 1) * 26}" font-size="26" font-weight="700">
${titleLines
  .map((line, index) => `      <tspan x="24" dy="${index === 0 ? 0 : 28}">${escape(line)}</tspan>`)
  .join('\n')}
    </text>
    <text x="24" y="234" font-size="16" opacity="0.78">${escape(wrap(track.artist, 24, 1)[0] ?? '')}</text>
    <text x="24" y="262" font-size="13" opacity="0.55">${track.year} · mock</text>
  </g>
</svg>`;

  return new Response(svg, {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' },
  });
}
