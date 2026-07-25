import type { Artist, Track } from './types';

/**
 * The embed page server-renders at most 100 tracks and offers no way to ask for
 * more — verified by parameter probing (`?offset=`, `?limit=`, `?page=` are all
 * ignored) and by scrolling the widget itself, which fires no follow-up request.
 * A playlist longer than this contributes its first 100 songs.
 */
const MAX_TRACKS_PER_PLAYLIST = 100;

/**
 * Spotify blocks datacentre IPs less often when the request looks like a browser
 * loading the widget, which is exactly what it is.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

/**
 * Metadata is fetched one id at a time, which looks wasteful next to the
 * 50-ids-per-call batch endpoint — but `GET /v1/tracks?ids=…` answers 403 for a
 * Client Credentials app, as do every other `?ids=` route. `GET /v1/tracks/{id}`
 * still answers 200. Twenty in parallel measured ~300ms, so the whole tracklist
 * costs about a second.
 */
const META_CONCURRENCY = 10;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

/** Accepts a share link, a spotify: URI, or a bare id. */
export function parsePlaylistId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  const direct = text.match(/^[A-Za-z0-9]{22}$/);
  if (direct) return direct[0];

  const uri = text.match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
  if (uri) return uri[1];

  const url = text.match(
    /^https?:\/\/open\.spotify\.com\/(?:embed\/)?(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/,
  );
  if (url) return url[1];

  return null;
}

/** The slice of the embed payload we rely on. Everything else is ignored. */
type EmbedTrack = {
  uri?: string;
  title?: string;
  subtitle?: string;
  isPlayable?: boolean;
  audioPreview?: { url?: string } | null;
};

type EmbedEntity = {
  name?: string;
  trackList?: EmbedTrack[];
};

export type IngestedPlaylist = { playlistId: string; playlistName: string; tracks: Track[] };

/**
 * Reads a playlist through the public embed widget rather than the Web API.
 *
 * The Web API is no longer usable for this: Client Credentials tokens can't read
 * playlist contents at all, and a user token can only read playlists its *own*
 * account owns — a public playlist made by someone else answers 403 even when
 * the account follows it. Since the whole game is guests bringing their own
 * playlists, that left no API path. The embed page at open.spotify.com/embed/…
 * serves the tracklist to anyone, logged in or not, and carries a preview mp3
 * per track as a bonus.
 *
 * The trade: this is not a documented API and Spotify makes no promise about it.
 * If the payload shape changes, ingest breaks and every path here surfaces a
 * message rather than a stack trace.
 *
 * `contributor` is the guest's name — the clue and the "same playlist" guess
 * tier both name the person, not the playlist. SPEC §1.5.
 */
export async function ingestPlaylist(
  playlistId: string,
  contributor: string,
): Promise<IngestedPlaylist> {
  const entity = await fetchEmbedEntity(playlistId);
  const playlistName = entity.name?.trim() || 'Untitled playlist';

  const tracks: Track[] = [];
  const seen = new Set<string>();

  for (const entry of entity.trackList ?? []) {
    const id = trackIdFromUri(entry?.uri);
    // Local files carry a spotify:local: uri and no id; unplayable tracks are
    // region-blocked or pulled from the catalogue. SPEC §3.1.4.
    if (!id || !entry.title || entry.isPlayable === false) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const artists = parseArtists(entry.subtitle);
    if (artists.length === 0) continue;

    tracks.push({
      spotifyId: id,
      title: entry.title,
      artists,
      // The embed carries no album art. It comes from the iTunes match when a
      // track is picked as the secret, the only place it's shown. lib/itunes.ts.
      albumArt: null,
      // All filled in below, in one Web API pass over the whole tracklist.
      releaseYear: null,
      // Deezer's job, and only for the tracks that end up pooled. See
      // lib/deezer.ts and the start route.
      popularity: null,
      pooled: false,
      explicit: null,
      durationMs: null,
      albumName: null,
      albumType: null,
      previewUrl: entry.audioPreview?.url ?? null,
      playlistId,
      contributor,
    });

    if (tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
  }

  if (tracks.length === 0) {
    throw new IngestError('We can read that playlist, but there are no playable songs in it.', 400);
  }

  // Doing it here rather than at pick time means the values are in the pool in
  // Redis, so re-rolls and later rounds cost nothing.
  const meta = await fetchTrackMeta(tracks.map((t) => t.spotifyId));
  for (const track of tracks) {
    const extra = meta.get(track.spotifyId);
    if (!extra) continue;
    track.releaseYear = extra.releaseYear;
    track.explicit = extra.explicit;
    track.durationMs = extra.durationMs;
    track.albumName = extra.albumName;
    track.albumType = extra.albumType;
  }

  return { playlistId, playlistName, tracks };
}

async function fetchEmbedEntity(playlistId: string): Promise<EmbedEntity> {
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      cache: 'no-store',
    });
  } catch {
    throw new IngestError("Couldn't reach Spotify. Try again in a moment.", 502);
  }

  if (res.status === 404) {
    throw new IngestError('Spotify has no playlist at that link.', 404);
  }
  if (res.status === 429) {
    throw new IngestError('Spotify is rate-limiting us. Wait a few seconds and try again.', 429);
  }
  if (!res.ok) {
    throw new IngestError('Spotify returned an error while reading that playlist.', 502);
  }

  const html = await res.text();
  const match = html.match(NEXT_DATA);
  if (!match) {
    throw new IngestError("Couldn't read that playlist from Spotify.", 502);
  }

  let entity: EmbedEntity | undefined;
  try {
    const data = JSON.parse(match[1]) as {
      props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } };
    };
    entity = data.props?.pageProps?.state?.data?.entity;
  } catch {
    throw new IngestError("Couldn't read that playlist from Spotify.", 502);
  }

  // Private and nonexistent playlists both answer 200 with the shell of the page
  // and no entity at all, so this — not the 404 above — is the branch that
  // actually fires for a bad link. SPEC §3.1.6.
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new IngestError(
      "Spotify won't show us that playlist. It's private, or the link is wrong. If it's yours: open it in Spotify, tap ⋯ → Edit details → Public, then paste the link again.",
      404,
    );
  }

  return entity;
}

// --- catalogue metadata (Web API) -------------------------------------------

/**
 * Cached app token. Module-level, so it lives as long as the serverless
 * instance does — a cold start pays one extra POST, which is not worth moving
 * into Redis for.
 */
let tokenCache: { token: string; expires: number } | null = null;

/**
 * Client Credentials token, or null when the app has no credentials configured.
 *
 * This is the one thing an app token *can* do for us. Reading a guest's
 * playlist through the Web API is still impossible for the reasons in the
 * `ingestPlaylist` comment above — but `GET /v1/tracks` is plain catalogue
 * metadata, needs no user, and survived the November 2024 deprecation that took
 * `audio-features` and the API's own preview URLs with it.
 */
async function appToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache.token;

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');

  let res: Response;
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;

  // 60s of slack, so a token can't expire between two batches of one ingest.
  tokenCache = {
    token: body.access_token,
    expires: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
  return tokenCache.token;
}

export type TrackMeta = {
  releaseYear: number | null;
  explicit: boolean | null;
  durationMs: number | null;
  albumName: string | null;
  albumType: string | null;
};

/**
 * Catalogue metadata per track id, for the ids Spotify answers for. All of it
 * feeds the loading screen (SPEC §1.2); par is Deezer's job now, since Spotify
 * no longer returns `popularity` to an app like this one on any endpoint.
 *
 * Never throws and never rejects an ingest: a missing credential or a bad
 * response degrades to blander loading lines rather than a guest who can't join.
 */
export async function fetchTrackMeta(ids: string[]): Promise<Map<string, TrackMeta>> {
  const out = new Map<string, TrackMeta>();
  if (ids.length === 0) return out;

  const token = await appToken();
  if (!token) return out;

  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++];

      try {
        const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        // 404 for an id Spotify no longer knows, 429 if we've been too eager.
        if (!res.ok) continue;

        const track = (await res.json()) as SpotifyTrack;
        if (!track?.id) continue;

        out.set(track.id, {
          releaseYear: parseYear(track.album?.release_date),
          explicit: typeof track.explicit === 'boolean' ? track.explicit : null,
          durationMs: typeof track.duration_ms === 'number' ? track.duration_ms : null,
          albumName: track.album?.name?.trim() || null,
          albumType: track.album?.album_type ?? null,
        });
      } catch {
        // Next id; this track just keeps its nulls.
      }
    }
  };

  await Promise.all(Array.from({ length: META_CONCURRENCY }, worker));

  return out;
}

type SpotifyTrack = {
  id?: string;
  popularity?: number;
  explicit?: boolean;
  duration_ms?: number;
  album?: { name?: string; album_type?: string; release_date?: string };
};

/** `release_date` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD` depending on precision. */
function parseYear(date?: string): number | null {
  const year = Number.parseInt(date?.slice(0, 4) ?? '', 10);
  return Number.isFinite(year) && year > 1900 ? year : null;
}

function trackIdFromUri(uri?: string): string | null {
  const match = uri?.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  return match ? match[1] : null;
}

/**
 * The embed gives one `subtitle` string instead of an artist array. Spotify
 * joins collaborators with ", " and nothing else — "STARSET, Breaking Benjamin,
 * Judge & Jury" is three artists, the last of them a band with an ampersand in
 * its name — so comma is the only safe separator. A band whose own name has a
 * comma ("Tyler, The Creator") splits wrongly; that costs a display label, not
 * a match, since every entry in the pool splits the same way.
 *
 * Artist ids aren't in the payload. `artistKey` already falls back to the
 * normalised name, so the artist guess tier is unaffected.
 */
function parseArtists(subtitle?: string): Artist[] {
  return (subtitle ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ id: null, name }));
}
