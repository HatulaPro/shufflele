# Shufflele

A party game for guessing songs pulled from the players' own Spotify playlists. One phone (the
host's) runs the game; everyone else joins briefly from their own phone only to contribute a
playlist, then puts it away and guesses out loud.

Implementation of [SPEC.md](SPEC.md).

## Running it

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill it in:

| Variable | Where it comes from |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | [console.upstash.com](https://console.upstash.com) — create a Redis database, copy the **REST** credentials. |
| `REPLICATE_API_TOKEN` | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |
| `REPLICATE_WEBHOOK_SECRET` | [replicate.com/account/webhook](https://replicate.com/account/webhook) — starts with `whsec_`. Optional locally, required in production. |
| `NEXT_PUBLIC_BASE_URL` | Public origin used to build the webhook callback URL. On Vercel this falls back to `VERCEL_URL`. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) — create an app, no review needed. Optional: without them the game runs, just with no difficulty header. |

```bash
npm run dev
```

Nobody signs into Spotify — not the host, not the guests. The Spotify app credentials are used
server-side for a single metadata call and are optional. See
[Reading playlists](#reading-playlists).

Then open the app on the host phone, tap **Create lobby**, and read the six digits out loud.
Guests open the join link, give a name and paste a link to a public playlist of theirs; the pool
is everyone's music mixed together. **Start game** lights up once one playlist is in.

### Reading playlists

Playlists are read from `open.spotify.com/embed/playlist/{id}` — the widget Spotify serves for
embedding a playlist in a web page. It server-renders the tracklist into a `__NEXT_DATA__` script
tag, for any public playlist, to anyone, with no authentication.

This is not the Web API, and that isn't a shortcut — the Web API can't do this any more:

- **Client Credentials tokens can't read playlist contents.** `/v1/playlists/{id}/items` answers
  `401 Valid user authentication required`, and the older `/tracks` endpoint is retired.
- **A user token only reads playlists its own account owns.** Not "public playlists" — owned ones.
  A public playlist made by someone else returns 403 on its contents even if the account follows
  it. Since the whole game is guests bringing *their* playlists, that path is closed.
- **Per-guest OAuth isn't viable.** An app in Development Mode admits 25 users, each added by hand
  in the dashboard — guests scanning a QR code at a party can't satisfy that.

The trade-offs are real and worth knowing before relying on this:

- **It's undocumented.** Spotify promises nothing about the embed payload and this use sits
  outside the Developer Terms. If the shape changes, ingest breaks — every failure path surfaces a
  message rather than a stack trace, but it will still be broken.
- **100 tracks per playlist, and no way to page past it.** Verified: `?offset=`, `?limit=` and
  `?page=` are ignored, and scrolling the live widget fires no further request. A longer playlist
  contributes its first 100 songs.
- **No album art or release year per track** — the payload has neither. Both are filled in from
  the iTunes match when a track is picked, which is the only place they're shown.

One thing gets *better* in exchange: Spotify's own editorial playlists (Today's Top Hits and
friends) work, where the Web API 404s them at any auth level.

The embed also carries a preview mp3 per track, which is the exact recording in the playlist
rather than an iTunes guess at it — but **it is not reliably 30 seconds**. Sampled across 50
tracks from two playlists: 17 ran the full ~30s, 17 were 20–28s, and 16 were under 20s (Architects'
"Curse" is 16s against a 181s track). Previews come from iTunes for that reason; the Spotify one
is used only when iTunes can't match the track at all, where the alternative is skipping it.

### Where popularity comes from

Not from Spotify, not any more. `GET /v1/tracks?ids=…` answers **403** to a Client Credentials
token, as does every other `?ids=` batch route. The single-track `GET /v1/tracks/{id}` still
answers 200 — but `popularity` is simply absent from the payload, as it is from `/v1/search`
results and from `/v1/artists/{id}`. Getting the field back means extended quota mode, which wants
a company and a review. The dashboard checkbox for "Web API" is not it.

**Deezer supplies it instead.** Its search endpoint needs no key at all and carries a `rank` per
track, which [`src/lib/deezer.ts`](src/lib/deezer.ts) maps onto Spotify's old 0–100 scale so that
[`par.ts`](src/lib/par.ts) and the selection weighting keep the units they were written against.
The mapping is piecewise-linear rather than a formula because rank is badly compressed at the top:
a global smash and a well-known album track sit a few percent apart near 1,000,000, while the
entire long tail lives below 500,000.

Three things that look like shortcuts and aren't:

- **Search, not ISRC.** `/track/isrc:…` is exact and skips fuzzy matching entirely, but rank is
  *per release*: Bohemian Rhapsody's 2011-remaster ISRC returns rank 26,799 where the canonical
  upload returns 958,949. Exact matching would file half the classics as obscure.
- **A loose query, not Deezer's field syntax.** `artist:"…" track:"…"` returns nothing for tracks
  that plainly exist — Taylor Swift's "Cruel Summer" among them. Matching reuses the same fuzzy
  scoring as the iTunes matcher.
- **Quota refusals arrive as HTTP 200.** Past ~50 requests per 5s per IP, Deezer answers 200 with
  `{"error":{"code":4}}` in the body, so `res.ok` is not enough. On Vercel Hobby the egress IP is
  shared with other tenants (static IPs are a Pro feature), so that bucket isn't ours alone —
  hence pacing well under the ceiling, one backoff, then giving up on the track.

Alternatives that were checked and rejected: iTunes carries no popularity signal in any field, on
any endpoint; Apple's RSS charts are a current top-100 only, which a party playlist barely
intersects; ListenBrainz has the right data but its popularity API is currently returning 500 and
needs MusicBrainz MBID resolution first. Last.fm's `playcount` is the one genuinely better source,
and costs a free API key.

### The pool

Looking up 100 tracks per playlist would be both slow and a lot of someone else's rate limit, so
the lobby samples first. On the first round — not at join time, since the divisor is how many
players turn out to show up — [`samplePool`](src/lib/select.ts) draws **150 tracks total, split
evenly across playlists and capped at 50 each**, and only those get a Deezer lookup. That is the
answer set for the whole lobby: at 5 rounds a day it is more secrets than anyone can spend.

Everything *not* sampled stays in Redis and still appears in the guess-modal search. If search only
contained poolable songs, the search box would be the answer set.

The lookup runs under a 25s wall-clock budget; whatever doesn't resolve keeps `popularity: null`.

### What the Web API is still good for

Release year, `explicit`, `duration_ms`, `album.name` and `album.album_type` — still there, still
free, and they're what the loading screen makes fun of people with (see
[`src/lib/quips.ts`](src/lib/quips.ts)). Since the batch route 403s, ingest fetches these one id at
a time with a small concurrency pool; twenty in parallel measured ~300ms, so a full tracklist costs
about a second.

This is a soft dependency on purpose. No credentials, a rate limit, a dead network — every path
falls back to `popularity: null`, the round drops its difficulty header, and the game plays on.

### Picking the secret song

[`src/lib/select.ts`](src/lib/select.ts) draws a playlist uniformly, then a track inside it weighted
by `exp(-deficit / 10)` — where `deficit` is how far that track's popularity sits below its **own
playlist's** 90th percentile, clamped to 45 points. One round in ten skips the weighting entirely
and draws uniformly.

Weighting the gap rather than the raw score is the whole trick. A playlist of wall-to-wall hits
spans ~75–92, so everything in it is roughly fair game; an alternative playlist spans ~5–65, so its
deep cuts are ~148x rarer than its singles without anyone tuning a knob per playlist. Nothing becomes
unreachable, and no state is written anywhere — within a lobby the used-track list already drains
the popular head, and the uniform mixture covers the rest.

A track with no popularity counts as its playlist's median rather than a zero, so a track Deezer
couldn't match costs you the difficulty label, not the song.

### Local development without a public URL

Replicate can't call a webhook at `localhost`, so while a round is `preparing` the round route
also polls Replicate directly (at most once every 3s, and only until the stems land). That makes
the whole flow work on a laptop with no tunnel, and doubles as insurance against a dropped
webhook in production. Set `REPLICATE_POLL_FALLBACK=0` to turn it off.

## Deploying

Vercel Hobby, no configuration needed. Set the environment variables in the project settings and
point `NEXT_PUBLIC_BASE_URL` at the deployment's own origin so Replicate can reach the webhook.

Everything is stateless request/response — no WebSockets, no SSE. The host phone polls every 2s;
guest phones need no updates at all after submitting.

## How a round works

```
start ──► pick a track (uniform random, unused)
          └─ iTunes match → preview + album art + release year, retrying up to 8
             tracks (Spotify's own preview is a fallback only — see below)
       ──► create a Demucs prediction (htdemucs, 4-stem) and return immediately
                                              │
   host polls ◄── round: preparing            │
                                              ▼
                  round: ready   ◄──── Replicate webhook writes the stem URLs
                        │
      host's browser decodes each stem, measures RMS, reports the dead ones
                        ▼
                  round: playing ──► guesses ──► won / lost
```

`vocals` is separated but never leaves the server, so it can't be pulled out of devtools. Stem
URLs are handed to the client one row at a time as the ladder unlocks, and the secret track id
is never sent at all — guesses are resolved server-side and come back as a feedback tier only.
This matters because the host is playing on a phone in front of an audience that can see it.

## Notes on the implementation

A few things the spec left open, and how they were resolved:

**The silence check runs in the browser.** The spec offers two options: compare stem file sizes
against the mix, or decode and measure RMS. File size turns out to be useless here — the stems
come back as constant-bitrate mp3, so a silent render weighs exactly as much as a busy one. The
server keeps a cheap byte-size guard that catches empty or truncated files, and the real check is
RMS over the decoded buffer in the host's browser, rejecting anything below −45 dBFS. That needs
one route the spec's table doesn't list, `POST /api/lobby/[code]/round/[n]/ladder`, which the
browser calls once to finalise the ladder before the guess screen renders. It's idempotent, and
if it never arrives the first guess falls back to the full ladder rather than wedging the round.

**The Demucs model is configurable, and its version is resolved at runtime.** `POST
/v1/models/{owner}/{name}/predictions` — the endpoint that runs a model's latest version without
naming a hash — exists only for Replicate's *official* models; for a community model like
`ryan5453/demucs` it returns a bare 404 that looks exactly like a typo in the model name.
Community models need `POST /v1/predictions` with a version hash, so the model's `latest_version`
is looked up first and memoised for an hour. That keeps the no-stale-hash property without
hardcoding one. Defaults to `ryan5453/demucs`, overridable with `REPLICATE_DEMUCS_MODEL`. The
output parser accepts both shapes these wrappers use (an object keyed by stem name, or an array
in canonical order) rather than committing to one schema.

**The webhook is dropped on non-HTTPS origins.** Replicate rejects an `http://` callback with a
422 that fails the *whole prediction*, not just the callback — so on a local origin the webhook is
omitted and the round route's poll delivers the result instead. This is why `npm run dev` works
with `NEXT_PUBLIC_BASE_URL=http://localhost:3000` and no tunnel.

**The webhook has two independent gates:** the standard-webhooks (svix) signature, and an
unguessable per-round key carried in the callback URL. A delivery for a round that already moved
on is ignored, and anything unrecognised returns 200 so Replicate doesn't retry forever.

**Rate limiting counts rounds, not lobbies** — `INCR ratelimit:games:{today}`, checked before any
GPU time is spent, refunded if the round fails to launch. Default 5/day, `GAMES_PER_DAY` to change.

## Known limitations

Carried over from the spec, all accepted:

- Public playlists only; a private one errors with instructions.
- The first 100 tracks of a playlist, with no way to reach the rest.
- Ingest rides on an undocumented endpoint Spotify can change without notice.
- Par reads global popularity, not the room — a niche track everyone present knows still shows as
  Very hard.
- Par's thresholds are absolute while song selection is playlist-relative, so most rounds land on
  Very easy / Easy and the harder pars are rare.
- 30s previews, so guesses are made on a fragment.
- Three real stems means a short ladder: one row per stem plus a final row.
- iTunes matching will occasionally pick a remaster or a live version.
- A track iTunes can't match falls back to Spotify's preview, which may be as short as ~15s, and
  shows no album art or release year.
- The result-screen Spotify embed plays a preview, not the full track, for logged-out listeners.
- Replicate cold starts can make the loading screen run over a minute.
- 5 rounds/day hard cap.

Deliberately deferred: per-contributor fairness in selection, scoring across a session, leaderboards.
Deliberately not done: caching separated stems.

## Licence

MIT — see [LICENSE](LICENSE). Non-commercial personal project; Vercel Hobby terms apply.
