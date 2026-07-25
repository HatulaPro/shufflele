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

/**
 * Accepts every shape a player might paste:
 *   https://open.spotify.com/playlist/37i9…?si=abc
 *   open.spotify.com/intl-de/playlist/37i9…
 *   spotify:playlist:37i9…
 *   37i9…
 */
export function parsePlaylistId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const uri = raw.match(/^spotify:playlist:([A-Za-z0-9]+)/i);
  if (uri) return uri[1];

  const url = raw.match(/playlist\/([A-Za-z0-9]+)/i);
  if (url) return url[1];

  if (/^[A-Za-z0-9]{16,30}$/.test(raw)) return raw;

  return null;
}

type CachedToken = { token: string; expiresAt: number };

/**
 * Client Credentials token, app-wide rather than per-user, cached in Redis
 * until a minute before expiry. SPEC §2.1 — no user ever logs in.
 */
export async function getAppToken(): Promise<string> {
  const cached = (await redis().get<CachedToken>(keys.spotifyToken())) ?? null;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new IngestError('Spotify credentials are not configured on the server.', 500);
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new IngestError('Could not authenticate with Spotify. Check the server credentials.', 502);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = Date.now() + body.expires_in * 1000;
  await redis().set<CachedToken>(
    keys.spotifyToken(),
    { token: body.access_token, expiresAt },
    { ex: Math.max(60, body.expires_in - 60) },
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
    // so this is the "make it public" case. SPEC §3.1.6.
    throw new IngestError(
      "Spotify won't show us that playlist. It's either private or the link is wrong — open it in Spotify, tap ⋯ → Edit details → Public, then paste the link again. (Spotify's own algorithmic playlists can't be read either.)",
      404,
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

type SpotifyTrackItem = {
  track: {
    id: string | null;
    name: string;
    type?: string;
    is_local?: boolean;
    popularity?: number;
    album?: { release_date?: string; images?: { url: string; width: number | null }[] };
    artists?: { id: string | null; name: string }[];
  } | null;
};

export type IngestedPlaylist = { playlistId: string; playlistName: string; tracks: Track[] };

/** Fetches up to 200 usable tracks from a public playlist. SPEC §3.1. */
export async function ingestPlaylist(playlistId: string, contributor: string): Promise<IngestedPlaylist> {
  const token = await getAppToken();

  const meta = await spotifyGet<{ name: string }>(
    `/playlists/${playlistId}?fields=name`,
    token,
  );

  const tracks: Track[] = [];
  const seen = new Set<string>();

  for (let offset = 0; offset < MAX_TRACKS_PER_PLAYLIST; offset += PAGE_SIZE) {
    const page = await spotifyGet<{ items: SpotifyTrackItem[]; next: string | null }>(
      `/playlists/${playlistId}/tracks?limit=${PAGE_SIZE}&offset=${offset}` +
        '&fields=next,items(track(id,name,type,is_local,popularity,album(release_date,images),artists(id,name)))',
      token,
    );

    for (const item of page.items ?? []) {
      const t = item?.track;
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
        contributor,
        releaseYear: parseYear(t.album?.release_date),
        popularity: typeof t.popularity === 'number' ? t.popularity : 0,
      });

      if (tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
    }

    if (!page.next || tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
  }

  if (tracks.length === 0) {
    throw new IngestError('That playlist is readable but has no playable tracks in it.', 400);
  }

  return { playlistId, playlistName: meta.name || 'Untitled playlist', tracks };
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
