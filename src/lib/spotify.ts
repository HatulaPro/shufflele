import { type BrokeredToken, fetchBrokeredToken } from './broker';
import { PLAYLIST_TTL_SECONDS, TOKEN_SLACK_SECONDS, keys, redis } from './redis';
import { baseUrl } from './replicate';
import type { Artist, Track } from './types';

/**
 * Playlists are read from the Web API proper: `GET /v1/playlists/{id}/tracks`,
 * paged 100 at a time until the playlist runs out. That gives us the whole
 * tracklist — and `popularity`, album art, release date, explicit, duration and
 * artist ids in the same response, none of which needed a second source.
 *
 * Getting there needed a token an ordinary app can't mint; see `accessToken`.
 */

/**
 * Practical ceiling, not an API one — the endpoint pages as far as you like.
 * What it protects is the lobby's track blob in Redis: a full 16-player lobby
 * at this cap is ~8k tracks, and that is already a multi-megabyte value read
 * and rewritten on every join. Personal playlists sit far below it; a curated
 * 2,000-song monster contributes its first 500 songs.
 */
const MAX_TRACKS_PER_PLAYLIST = 500;

/** The endpoint's own maximum. */
const PAGE_SIZE = 100;

/**
 * Only the fields we store. Worth spelling out: the unprojected payload carries
 * `available_markets` on both the track and its album, which is ~180 country
 * codes per entry and dwarfs everything we actually want.
 */
const TRACK_FIELDS =
  'total,items(is_local,track(id,name,popularity,explicit,duration_ms,preview_url,' +
  'artists(id,name),album(name,album_type,release_date,images)))';

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

export type IngestedPlaylist = { playlistId: string; playlistName: string; tracks: Track[] };

/**
 * Read a public playlist into `Track`s.
 *
 * `contributor` is the guest's name — the clue and the "same playlist" guess
 * tier both name the person, not the playlist. SPEC §1.5.
 *
 * The whole result is cached in Redis for a few minutes, because the same
 * playlist is often ingested more than once in quick succession (a re-join, or
 * friends sharing a playlist across lobbies) and a 500-track playlist is five
 * API calls. The TTL is short since playlists get edited; see
 * PLAYLIST_TTL_SECONDS. The contributor is stamped per caller, never cached.
 */
export async function ingestPlaylist(
  playlistId: string,
  contributor: string,
): Promise<IngestedPlaylist> {
  const cached = await readPlaylistCache(playlistId);
  if (cached) {
    return {
      ...cached,
      tracks: cached.tracks.map((t) => ({ ...t, contributor })),
    };
  }

  const head = await fetchPlaylistHead(playlistId);
  const playlistName = head.name?.trim() || 'Untitled playlist';
  const total = Math.min(head.tracks?.total ?? MAX_TRACKS_PER_PLAYLIST, MAX_TRACKS_PER_PLAYLIST);

  const tracks: Track[] = [];
  const seen = new Set<string>();

  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const page = await fetchTrackPage(playlistId, offset);
    if (page.length === 0) break;

    for (const item of page) {
      const entry = item.track;
      // Local files carry no id, and a track pulled from the catalogue comes
      // back as a null `track`. SPEC §3.1.4.
      if (item.is_local || !entry?.id || !entry.name) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

      const artists = parseArtists(entry.artists);
      if (artists.length === 0) continue;

      tracks.push({
        spotifyId: entry.id,
        title: entry.name,
        artists,
        albumArt: pickArtwork(entry.album?.images),
        releaseYear: parseYear(entry.album?.release_date),
        popularity: typeof entry.popularity === 'number' ? entry.popularity : null,
        explicit: typeof entry.explicit === 'boolean' ? entry.explicit : null,
        durationMs: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
        albumName: entry.album?.name?.trim() || null,
        albumType: entry.album?.album_type ?? null,
        previewUrl: entry.preview_url ?? null,
        playlistId,
        contributor,
      });

      if (tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
    }

    if (tracks.length >= MAX_TRACKS_PER_PLAYLIST || page.length < PAGE_SIZE) break;
  }

  if (tracks.length === 0) {
    throw new IngestError('We can read that playlist, but there are no playable songs in it.', 400);
  }

  const result: IngestedPlaylist = { playlistId, playlistName, tracks };
  await writePlaylistCache(result);
  return result;
}

// --- cross-lobby cache -------------------------------------------------------

/**
 * Cached with an empty contributor, since that's the one per-caller field;
 * `ingestPlaylist` stamps the real name on the way out. Cache errors are
 * swallowed on both sides — a broken cache means a normal, slower ingest.
 */
async function readPlaylistCache(playlistId: string): Promise<IngestedPlaylist | null> {
  try {
    return await redis().get<IngestedPlaylist>(keys.playlist(playlistId));
  } catch {
    return null;
  }
}

async function writePlaylistCache(result: IngestedPlaylist): Promise<void> {
  try {
    await redis().set(
      keys.playlist(result.playlistId),
      { ...result, tracks: result.tracks.map((t) => ({ ...t, contributor: '' })) },
      { ex: PLAYLIST_TTL_SECONDS },
    );
  } catch {
    // The next ingest of this playlist just does the full read again.
  }
}

// --- the Web API -------------------------------------------------------------

type SpotifyImage = { url?: string; width?: number | null; height?: number | null };

type ApiTrack = {
  id?: string | null;
  name?: string;
  popularity?: number;
  explicit?: boolean;
  duration_ms?: number;
  preview_url?: string | null;
  artists?: { id?: string | null; name?: string }[];
  album?: {
    name?: string;
    album_type?: string;
    release_date?: string;
    images?: SpotifyImage[];
  };
};

type PlaylistHead = { name?: string; tracks?: { total?: number } };
type TrackItem = { is_local?: boolean; track?: ApiTrack | null };

async function fetchPlaylistHead(playlistId: string): Promise<PlaylistHead> {
  return apiGet<PlaylistHead>(`/playlists/${playlistId}?fields=name,tracks(total)`);
}

async function fetchTrackPage(playlistId: string, offset: number): Promise<TrackItem[]> {
  const body = await apiGet<{ items?: TrackItem[] }>(
    `/playlists/${playlistId}/tracks?limit=${PAGE_SIZE}&offset=${offset}` +
      `&fields=${encodeURIComponent(TRACK_FIELDS)}`,
  );
  return body.items ?? [];
}

/**
 * One authenticated GET, with a single retry on an expired token.
 *
 * Every failure mode here becomes an `IngestError` with a message a guest can
 * act on, because the only caller is the join route and the only reader is
 * somebody's phone.
 */
async function apiGet<T>(path: string, retried = false): Promise<T> {
  const token = await accessToken();
  if (!token) {
    throw new IngestError("Spotify isn't configured on this server.", 500);
  }

  let res: Response;
  try {
    res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { authorization: `Bearer ${token.value}` },
      cache: 'no-store',
    });
  } catch {
    throw new IngestError("Couldn't reach Spotify. Try again in a moment.", 502);
  }

  if (res.ok) return (await res.json()) as T;

  // 401 is an expired token — ours may have been minted by another instance, or
  // the broker's may have been rotated under us. 403 on the *first* call of an
  // instance means our own app lacks the quota this endpoint needs; both are
  // worth one retry against a freshly sourced token. See `accessToken`.
  if ((res.status === 401 || res.status === 403) && !retried) {
    await invalidateToken(token.source);
    if (res.status === 403) ownAppUsable = false;
    return apiGet<T>(path, true);
  }

  if (res.status === 404) {
    throw new IngestError(
      "Spotify won't show us that playlist. It's private, or the link is wrong. If it's yours: open it in Spotify, tap ⋯ → Edit details → Public, then paste the link again.",
      404,
    );
  }
  if (res.status === 429) {
    throw new IngestError('Spotify is rate-limiting us. Wait a few seconds and try again.', 429);
  }
  throw new IngestError('Spotify returned an error while reading that playlist.', 502);
}

// --- tokens ------------------------------------------------------------------

/**
 * Reading a playlist needs an app in **extended quota mode** — see lib/broker.ts
 * for what that rules out and why. The token comes from an app that has it, in
 * this order:
 *
 * 1. **SPOTIFY_TOKEN_OVERRIDE**, a token pasted in by hand. The escape hatch for
 *    local development, where the broker is unreachable (Node TLS) and the Edge
 *    route below is emulated on Node and so is unreachable too.
 * 2. **This deployment's own app**, if SPOTIFY_CLIENT_ID/SECRET are set and the
 *    API actually answers for them. If the app ever gets extended quota mode,
 *    this is the only path taken and nothing else here runs.
 * 3. **Chosic's, brokered**, via the Edge route.
 *
 * The verdict on (2) is remembered per instance: `null` until the first request
 * decides it, then sticky. A 403 flips it to false in `apiGet` and the retry
 * goes to the broker.
 */
let ownAppUsable: boolean | null = null;

type TokenSource = 'own' | 'broker';
type AccessToken = { value: string; source: TokenSource };

/** In-process cache, so a warm instance re-uses a token for its whole lifetime. */
const cached = new Map<TokenSource, { value: string; expiresAt: number }>();

async function accessToken(): Promise<AccessToken | null> {
  const override = process.env.SPOTIFY_TOKEN_OVERRIDE;
  if (override) return { value: override, source: 'own' };

  if (ownAppUsable !== false) {
    const own = await ownAppToken();
    if (own) return { value: own, source: 'own' };
    // No credentials configured at all. Don't keep asking.
    ownAppUsable = false;
  }

  const brokered = await brokeredToken();
  return brokered ? { value: brokered, source: 'broker' } : null;
}

async function invalidateToken(source: TokenSource): Promise<void> {
  cached.delete(source);
  if (source === 'broker') {
    try {
      await redis().del(keys.spotifyToken());
    } catch {
      // Worst case the next instance re-reads a token we know is stale and
      // burns its own retry on it.
    }
  }
}

function remember(source: TokenSource, value: string, expiresInSeconds: number): string {
  cached.set(source, {
    value,
    expiresAt: Date.now() + Math.max(expiresInSeconds - TOKEN_SLACK_SECONDS, 30) * 1000,
  });
  return value;
}

function fresh(source: TokenSource): string | null {
  const entry = cached.get(source);
  return entry && Date.now() < entry.expiresAt ? entry.value : null;
}

/** Client Credentials against this deployment's own app, when it has one. */
async function ownAppToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  const hit = fresh('own');
  if (hit) return hit;

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

  return remember('own', body.access_token, body.expires_in ?? 3600);
}

/**
 * The brokered token, cached in Redis so the whole deployment shares one rather
 * than every cold instance asking again. Chosic caches server-side too and
 * hands the same token to everyone until it expires, so this mostly keeps our
 * traffic off them.
 */
async function brokeredToken(): Promise<string | null> {
  const hit = fresh('broker');
  if (hit) return hit;

  try {
    const shared = await redis().get<{ value: string; expiresAt: number }>(keys.spotifyToken());
    if (shared && Date.now() < shared.expiresAt) {
      cached.set('broker', shared);
      return shared.value;
    }
  } catch {
    // Fall through to a live fetch.
  }

  const minted = await mintBrokeredToken();
  if (!minted) return null;

  remember('broker', minted.value, minted.expiresIn);
  try {
    await redis().set(keys.spotifyToken(), cached.get('broker'), {
      ex: Math.max(minted.expiresIn - TOKEN_SLACK_SECONDS, 60),
    });
  } catch {
    // In-process cache still holds it for this instance.
  }
  return minted.value;
}

/**
 * Mint a fresh brokered token.
 *
 * On the Edge runtime this is the broker call itself. Everywhere else — which
 * in practice means every route in this app, since they all need `node:crypto`
 * — it is one hop through the Edge route, because Node's TLS handshake is what
 * Cloudflare refuses. lib/broker.ts has the finding in full.
 */
async function mintBrokeredToken(): Promise<BrokeredToken | null> {
  if (process.env.NEXT_RUNTIME === 'edge') return fetchBrokeredToken();

  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return null;

  try {
    const res = await fetch(`${baseUrl()}/api/internal/spotify-token`, {
      method: 'POST',
      headers: { 'x-internal-secret': secret },
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const body = (await res.json()) as Partial<BrokeredToken>;
    return body.value ? { value: body.value, expiresIn: body.expiresIn ?? 3600 } : null;
  } catch {
    return null;
  }
}

// --- payload helpers ---------------------------------------------------------

/**
 * The reveal renders album art on a small tile at 2x, so the 300px image is the
 * one to take. Spotify orders `images` largest first but documents no
 * guarantee, so pick by width rather than by index.
 */
function pickArtwork(images?: SpotifyImage[]): string | null {
  if (!images?.length) return null;

  let best: SpotifyImage | null = null;
  for (const image of images) {
    if (!image.url) continue;
    if (!best) {
      best = image;
      continue;
    }
    const width = image.width ?? 0;
    const bestWidth = best.width ?? 0;
    // Smallest image at least 300px wide; failing that, the largest there is.
    const betterFit = width >= 300 && (bestWidth < 300 || width < bestWidth);
    const betterFallback = bestWidth < 300 && width > bestWidth;
    if (betterFit || betterFallback) best = image;
  }

  return best?.url ?? null;
}

/** `release_date` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD` depending on precision. */
function parseYear(date?: string): number | null {
  const year = Number.parseInt(date?.slice(0, 4) ?? '', 10);
  return Number.isFinite(year) && year > 1900 ? year : null;
}

/**
 * Artist ids come through now, which is what `artistKey` prefers — the artist
 * guess tier no longer has to decide whether two spellings are the same band.
 */
function parseArtists(artists?: { id?: string | null; name?: string }[]): Artist[] {
  return (artists ?? []).flatMap((artist) => {
    const name = artist.name?.trim();
    return name ? [{ id: artist.id ?? null, name }] : [];
  });
}
