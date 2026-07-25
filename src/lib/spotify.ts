import { keys, redis } from './redis';
import type { Artist, Track } from './types';

const MAX_TRACKS_PER_PLAYLIST = 200;
const PAGE_SIZE = 50;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

type CachedToken = { token: string; expiresAt: number };

/**
 * Spotify no longer serves playlist contents to Client Credentials tokens —
 * /playlists/{id}/items answers 401 "Valid user authentication required". So
 * the server holds one long-lived user grant (SPOTIFY_REFRESH_TOKEN, minted by
 * `npm run spotify:auth`) and acts as that account for every lobby. Guests
 * still never log in: Development Mode caps user logins at 25 hand-registered
 * accounts, which scan-the-QR guests can't satisfy.
 *
 * Access tokens last an hour; cached in Redis until a minute before expiry.
 */
export async function getUserToken(): Promise<string> {
  const cached = (await redis().get<CachedToken>(keys.spotifyToken())) ?? null;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  if (!id || !secret) {
    throw new IngestError('Spotify credentials are not configured on the server.', 500);
  }
  if (!refreshToken) {
    throw new IngestError(
      'The server has no Spotify authorization. Run `npm run spotify:auth` and set SPOTIFY_REFRESH_TOKEN.',
      500,
    );
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    cache: 'no-store',
  });

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!res.ok || !body.access_token) {
    // invalid_grant means the grant is gone for good — revoked at
    // spotify.com/account/apps, or the client secret was rotated. No amount of
    // retrying fixes it, so say what to do instead of a generic 502.
    if (body.error === 'invalid_grant') {
      throw new IngestError(
        "The server's Spotify authorization was revoked. Re-run `npm run spotify:auth` and update SPOTIFY_REFRESH_TOKEN.",
        500,
      );
    }
    throw new IngestError('Could not authenticate with Spotify. Check the server credentials.', 502);
  }

  const expiresIn = body.expires_in ?? 3600;
  await redis().set<CachedToken>(
    keys.spotifyToken(),
    { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 },
    { ex: Math.max(60, expiresIn - 60) },
  );

  return body.access_token;
}

async function spotifyGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (res.status === 404) {
    // A private playlist is indistinguishable from a missing one over the API,
    // so this is the "make it public" case. SPEC §3.1.6. Spotify's own
    // editorial and algorithmic playlists (Discover Weekly, Top 50, anything
    // under the spotify: owner) also 404 here — they were cut off from the Web
    // API and no auth flow brings them back.
    throw new IngestError(
      "Spotify won't show us that playlist. If it's one of Spotify's own (Discover Weekly, Top 50, Release Radar), the API can't read it at all — pick a playlist someone made. Otherwise it's private or the link is wrong: open it in Spotify, tap ⋯ → Edit details → Public, then paste the link again.",
      404,
    );
  }
  if (res.status === 401) {
    throw new IngestError(
      "The server's Spotify authorization is no longer valid. Re-run `npm run spotify:auth`.",
      500,
    );
  }
  if (res.status === 429) {
    throw new IngestError('Spotify is rate-limiting us. Wait a few seconds and try again.', 429);
  }
  if (!res.ok) {
    throw new IngestError('Spotify returned an error while reading that playlist.', 502);
  }

  return (await res.json()) as T;
}

/**
 * Note `item`, not `track`: /playlists/{id}/items nests the entry under `item`,
 * unlike the retired /tracks endpoint. `popularity` is no longer served on any
 * track object — see parFor() in lib/par.ts.
 */
type SpotifyPlaylistItem = {
  item: {
    id: string | null;
    name: string;
    type?: string;
    is_local?: boolean;
    album?: { release_date?: string; images?: { url: string; width: number | null }[] };
    artists?: { id: string | null; name: string }[];
  } | null;
};

export type IngestedPlaylist = { playlistId: string; playlistName: string; tracks: Track[] };

/**
 * Lists the playlists the server's Spotify account owns. Followed playlists are
 * filtered out: /me/playlists returns them, but their contents are unreadable —
 * only the owning account can read a playlist's items.
 */
export async function listOwnPlaylists(): Promise<
  { id: string; name: string; trackCount: number; image: string | null }[]
> {
  const token = await getUserToken();
  const me = await spotifyGet<{ id: string }>('/me', token);

  const out: { id: string; name: string; trackCount: number; image: string | null }[] = [];

  for (let offset = 0; offset < 200; offset += PAGE_SIZE) {
    const page = await spotifyGet<{
      items: ({
        id: string;
        name: string;
        owner?: { id?: string };
        /** Track count lives under `items`, not `tracks` — same rename as the playlist body. */
        items?: { total?: number };
        images?: { url: string; width: number | null }[];
      } | null)[];
      next: string | null;
    }>(`/me/playlists?limit=${PAGE_SIZE}&offset=${offset}`, token);

    for (const p of page.items ?? []) {
      if (!p?.id || p.owner?.id !== me.id) continue;
      out.push({
        id: p.id,
        name: p.name || 'Untitled playlist',
        trackCount: p.items?.total ?? 0,
        image: pickArt(p.images),
      });
    }

    if (!page.next) break;
  }

  return out;
}

/** Fetches up to 200 usable tracks from a playlist the server's account owns. */
export async function ingestPlaylist(playlistId: string): Promise<IngestedPlaylist> {
  const token = await getUserToken();

  const meta = await spotifyGet<{ name: string }>(
    `/playlists/${playlistId}?fields=name`,
    token,
  );
  const playlistName = meta.name || 'Untitled playlist';

  const tracks: Track[] = [];
  const seen = new Set<string>();

  for (let offset = 0; offset < MAX_TRACKS_PER_PLAYLIST; offset += PAGE_SIZE) {
    const page = await spotifyGet<{ items: SpotifyPlaylistItem[]; next: string | null }>(
      `/playlists/${playlistId}/items?limit=${PAGE_SIZE}&offset=${offset}` +
        '&fields=next,items(item(id,name,type,is_local,album(release_date,images),artists(id,name)))',
      token,
    );

    for (const entry of page.items ?? []) {
      const t = entry?.item;
      // Drop local files, podcast episodes, and nulls. SPEC §3.1.4.
      if (!t || !t.id || t.is_local || (t.type && t.type !== 'track')) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);

      const artists: Artist[] = (t.artists ?? [])
        .filter((a) => a?.name)
        .map((a) => ({ id: a.id ?? null, name: a.name }));
      if (artists.length === 0) continue;

      tracks.push({
        spotifyId: t.id,
        title: t.name,
        artists,
        albumArt: pickArt(t.album?.images),
        playlistId,
        contributor: playlistName,
        releaseYear: parseYear(t.album?.release_date),
      });

      if (tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
    }

    if (!page.next || tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
  }

  if (tracks.length === 0) {
    throw new IngestError('That playlist is readable but has no playable tracks in it.', 400);
  }

  return { playlistId, playlistName, tracks };
}

function pickArt(images?: { url: string; width: number | null }[]): string | null {
  if (!images || images.length === 0) return null;
  // Smallest image that is still big enough for a 56px thumb at 2x.
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 120) ?? sorted[sorted.length - 1]).url;
}

function parseYear(releaseDate?: string): number | null {
  if (!releaseDate) return null;
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}
