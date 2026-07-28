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
| `INTERNAL_API_SECRET` | Any long random string (`openssl rand -hex 32`), same value across one deployment. Gates the Edge route that fetches the Spotify token. Required. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard). Only useful if your app has **extended quota mode** — see [Reading playlists](#reading-playlists). Leave blank otherwise. |
| `SPOTIFY_TOKEN_OVERRIDE` | Local development only. See [Reading playlists](#reading-playlists). |
| `YOUTUBE_API_KEY` | [console.cloud.google.com](https://console.cloud.google.com) — enable **YouTube Data API v3** and create an API key. No OAuth, no billing. Optional: without it the play-count chip just doesn't appear. |

```bash
npm run dev
```

Nobody signs into Spotify — not the host, not the guests. There is no OAuth flow anywhere in
this app. How it reads playlists without one is the interesting part, and it has caveats: see
[Reading playlists](#reading-playlists).

Then open the app on the host phone, tap **Create lobby**, and read the six digits out loud.
Guests open the join link, give a name and paste a link to a public playlist of theirs; the pool
is everyone's music mixed together. **Start game** lights up once one playlist is in.

### Reading playlists

Playlists come from the Web API proper: `GET /v1/playlists/{id}` for the name, then
`/v1/playlists/{id}/tracks` paged 100 at a time until the playlist runs out. One response carries
`popularity`, album art, release date, `explicit`, `duration_ms`, album name and type, and artist
ids — everything the game needs, from one source, with no per-track follow-up calls.

Getting a token that can do that is the whole problem.

**The gate is extended quota mode.** An app without it — the kind anyone can register in the
dashboard — gets `403` from `GET /v1/playlists/{id}` for any playlist it does not own, and never
sees `popularity` in any payload on any endpoint. Client Credentials versus a user token makes no
difference; the gate is the app, not the caller. Nor does per-guest OAuth help: an app in
Development Mode admits 25 users added by hand, which guests scanning a QR code at a party cannot
satisfy. Extended quota mode is a Spotify review that wants an organisation behind it.

**So the token is borrowed.** [chosic.com/spotify-playlist-analyzer](https://www.chosic.com/spotify-playlist-analyzer/)
has that quota, and its page calls `api.spotify.com` from the browser using a token it fetches
from its own `POST /api/tools/t/` — unauthenticated, no login, no cookie. [`src/lib/broker.ts`](src/lib/broker.ts)
asks the same way. Three headers are load-bearing, established by probing: a browser `User-Agent`
**and** the analyser's own `Referer` (without both, Cloudflare serves its challenge page), plus an
`app: playlist_analyzer` header (without it WordPress answers `empty params`).

**And it has to be fetched from the Edge runtime.** This is the part that isn't obvious. Cloudflare
fingerprints the TLS handshake, and Node's ClientHello comes from OpenSSL: from Node the endpoint
answers `403` on **every** attempt, while the identical request from curl's Schannel backend
answers `200` on every attempt — interleaved and confirmed. Header order, cipher and curve shaping,
TLS 1.3-only and HTTP/2 all fail, because the ClientHello is not reachable from JavaScript. Doing
it from the guest's browser is closed too: chosic's `access-control-allow-origin` is pinned to
their own origin and the CORS preflight `403`s. So the fetch lives in
[`/api/internal/spotify-token`](src/app/api/internal/spotify-token/route.ts), which runs on Edge —
a different TLS stack — and the Node routes that read playlists call it over HTTP. The result is
cached in Redis for the whole deployment, so that hop happens about once an hour.

Worth knowing before relying on any of this:

- **It is someone else's endpoint and someone else's quota.** It can be rate-limited, put behind
  the Turnstile widget that page already loads, or changed, on any day and with no notice. Every
  path out of the broker returns null and surfaces a message rather than a stack trace, but it will
  still be broken.
- **`SPOTIFY_CLIENT_ID`/`SECRET` are the way out.** If this deployment's own app ever gets extended
  quota mode, set them: they are tried first, and none of the above is reached.
- **Local development needs `SPOTIFY_TOKEN_OVERRIDE`.** `next dev` emulates the Edge runtime on
  Node, so the broker is unreachable locally by the same TLS check. Paste an hour-long token in by
  hand; the curl command is in `.env.example`.
- **To check a deployment**, `GET` the Edge route with the internal secret. It reports the raw
  outcome of the broker call — including whether Cloudflare served its challenge page — without
  returning the token:

  ```bash
  curl https://YOUR-APP.vercel.app/api/internal/spotify-token -H "x-internal-secret: THE_SECRET"
  ```

  `{"ok":true,...}` means Edge clears Cloudflare. `{"challenged":true,...}` means it does not, and
  the token has to come from somewhere else. Ingest errors name the failing step too, rather than
  a generic "not configured".

One thing that got *better* along the way: Spotify's own editorial playlists (Today's Top Hits and
friends) read fine on this token, where an ordinary app 404s them.

### Where previews come from

Not from Spotify, even though the tracklist carries a `preview_url` for roughly six tracks in
seven. That clip is the exact recording, which is tempting, but **it is not reliably 30 seconds**.
Sampled across 50 tracks from two playlists: 17 ran the full ~30s, 17 were 20–28s, and 16 were
under 20s (Architects' "Curse" is 16s against a 181s track). A short clip makes for a bad round.

So [`src/lib/itunes.ts`](src/lib/itunes.ts) matches the track on the iTunes Search API and uses its
preview, which is consistently 30s, falling back to Spotify's own only when iTunes can't match the
track at all — where the alternative is skipping the song entirely. Thresholds on title and artist
similarity, plus a penalty for `live` / `karaoke` / `tribute` / `in the style of`, keep covers and
concert recordings out.

That is now the *only* thing iTunes is asked for. Album art and release year used to come from it
too, because the old embed payload had neither; they arrive with the tracklist now, so a track
iTunes fluffs still reveals with the right cover.

### The pool

Every ingested track is drawable as the secret, up to 500 per playlist. There used to be a sampling
stage that marked a subset drawable, because popularity cost a Deezer search per track and the
budget only stretched to ~150 of them a lobby; the Web API hands popularity over with the
tracklist, so there is nothing left to ration and `samplePool` is gone.

The 500 cap is a Redis concern, not an API one — the endpoint pages as far as you like, but a full
16-player lobby at that cap is ~8k tracks in one value that is read and rewritten on every join.
Personal playlists sit far below it.

### Picking the secret song

[`src/lib/select.ts`](src/lib/select.ts) draws a playlist uniformly, then a track inside it weighted
by `exp(-deficit / 6)` — where `deficit` is how far that track's popularity sits below its **own
playlist's** 86th percentile, clamped to 50 points. One round in fourteen skips the weighting
entirely and draws uniformly.

Weighting the gap rather than the raw score is the whole trick. A playlist of wall-to-wall hits
spans ~75–92, so everything in it stays in play; an alternative playlist spans ~5–65, so its
deep cuts are ~4200x rarer than its singles without anyone tuning a knob per playlist. Nothing becomes
unreachable, and no state is written anywhere — within a lobby the used-track list already drains
the popular head, and the uniform mixture covers the rest.

A track whose payload omitted `popularity` counts as its playlist's median rather than a zero, so
it costs you the difficulty label, not the song.

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

**Play counts come from YouTube, because Spotify has no stream count.** The header shows the song's
plays next to its par — the two things the round knows about the track — and no Spotify API tier
exposes streams, so [`src/lib/youtube.ts`](src/lib/youtube.ts) searches YouTube and takes the views
on the largest upload that matches on title similarity *and* has the artist in the video title or
channel name (the latter is what catches `Artist - Topic` uploads). Largest single upload rather
than a sum: a song's views are split across the official video, the audio upload and a pile of
lyric videos, and adding them would count the same recording three times. Resolved once at pick
time, so it can't drift between polls, and rounded hard on display — it's a sense of scale, not a
chart position. One round costs 101 of the free tier's 10,000 daily quota units, and without
`YOUTUBE_API_KEY` the chip just never renders.

**Rate limiting counts rounds, not lobbies** — `INCR ratelimit:games:{today}`, checked before any
GPU time is spent, refunded if the round fails to launch. Default 5/day, `GAMES_PER_DAY` to change.

## Known limitations

Carried over from the spec, all accepted:

- Public playlists only; a private one errors with instructions.
- The first 500 tracks of a playlist. A Redis-size cap, not an API one — see [The pool](#the-pool).
- The Spotify token is borrowed from a third party's site over an undocumented endpoint that sits
  behind a bot check. It can break on any day and with no notice — see [Reading playlists](#reading-playlists).
- Par reads global popularity, not the room — a niche track everyone present knows still shows as
  Very hard.
- Par's thresholds are absolute while song selection is playlist-relative, so most rounds land on
  Very easy / Easy and the harder pars are rare.
- 30s previews, so guesses are made on a fragment.
- Three real stems means a short ladder: one row per stem plus a final row.
- iTunes matching will occasionally pick a remaster or a live version.
- A track iTunes can't match falls back to Spotify's preview, which may be as short as ~15s.
- The result-screen Spotify embed plays a preview, not the full track, for logged-out listeners.
- Replicate cold starts can make the loading screen run over a minute.
- 5 rounds/day hard cap.

Deliberately deferred: per-contributor fairness in selection, scoring across a session, leaderboards.
Deliberately not done: caching separated stems.

## Licence

MIT — see [LICENSE](LICENSE). Non-commercial personal project; Vercel Hobby terms apply.
