# Shufflele

A party game for guessing songs pulled from the host's Spotify playlists. One phone (the host's)
runs the game; everyone else joins briefly from their own phone only to give a name, then puts it
away and guesses out loud.

Implementation of [SPEC.md](SPEC.md).

## Running it

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill it in:

| Variable | Where it comes from |
|---|---|
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) — create an app, tick **Web API**, and add `http://127.0.0.1:8888/callback` as a redirect URI. |
| `SPOTIFY_REFRESH_TOKEN` | Run `npm run spotify:auth` and log in. See [Spotify authorization](#spotify-authorization). |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | [console.upstash.com](https://console.upstash.com) — create a Redis database, copy the **REST** credentials. |
| `REPLICATE_API_TOKEN` | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |
| `REPLICATE_WEBHOOK_SECRET` | [replicate.com/account/webhook](https://replicate.com/account/webhook) — starts with `whsec_`. Optional locally, required in production. |
| `NEXT_PUBLIC_BASE_URL` | Public origin used to build the webhook callback URL. On Vercel this falls back to `VERCEL_URL`. |

```bash
npm run dev
```

Then open the app on the host phone, tap **Create lobby**, and read the six digits out loud. Add
a playlist or two from the picker — it lists the playlists your Spotify account owns — while
guests join with their names. **Start game** lights up once one playlist is in.

### Spotify authorization

Spotify no longer serves playlist contents to Client Credentials tokens —
`/playlists/{id}/items` answers `401 Valid user authentication required`. Per-guest
OAuth isn't an option either: an app in Development Mode only admits 25 users, each
added by hand in the dashboard, which guests scanning a QR code can't satisfy.

So the server holds a single long-lived user grant and reads every playlist as that
one account. Run this once:

```bash
npm run spotify:auth
```

It opens Spotify, you log in as the account the server should act as, and it prints
`SPOTIFY_REFRESH_TOKEN=…` for `.env.local` and your Vercel environment. Refresh
tokens from this flow don't expire on a timer. Re-run it only if you revoke the app
at [spotify.com/account/apps](https://www.spotify.com/account/apps/), rotate the
client secret, or change the requested scopes — the app surfaces a message naming
the script when that happens.

A second restriction shapes the whole game: **a user token can only read playlists its own account
owns.** Not "public playlists" — owned ones. A public playlist made by someone else returns 403 on
its contents even if the account follows it. That's why guests can't bring playlists and why the
picker lists owned playlists only. See [SPEC.md §2.1](SPEC.md) for what was tested to establish
this, and what else disappeared in the same round of API changes.

Other consequences worth knowing:

- **Spotify's own playlists can't be used.** Discover Weekly, Release Radar, Top 50
  and every other editorial or algorithmic playlist return 404 regardless of auth.
- **Track `popularity` is gone from the API**, so per-track difficulty is currently
  flat — see [`src/lib/par.ts`](src/lib/par.ts).
- **The response shape changed.** Playlist bodies now carry their paging object under `items`
  rather than `tracks`, and each entry nests the track under `item` rather than `track`. A stale
  `fields` mask returns `200` with an empty object instead of erroring, so this fails quietly.

### Local development without a public URL

Replicate can't call a webhook at `localhost`, so while a round is `preparing` the round route
also polls Replicate directly (at most once every 3s, and only until the stems land). That makes
the whole flow work on a laptop with no tunnel, and doubles as insurance against a dropped
webhook in production. Set `REPLICATE_POLL_FALLBACK=0` to turn it off.

## Deploying

Vercel Hobby, no configuration needed. Set the environment variables in the project settings and
point `NEXT_PUBLIC_BASE_URL` at the deployment's own origin so Replicate can reach the webhook.

Everything is stateless request/response — no WebSockets, no SSE. The host phone polls every 2s;
guest phones need no updates at all after joining.

## How a round works

```
start ──► pick a track (uniform random, unused)
          └─ resolve a 30s preview via iTunes, retrying up to 8 tracks
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

**The Demucs model is configurable.** Predictions are created against
`POST /v1/models/{owner}/{name}/predictions`, which runs the model's *latest* version, so there's
no version hash to go stale. It defaults to `ryan5453/demucs` and can be overridden with
`REPLICATE_DEMUCS_MODEL`. The output parser accepts both shapes these wrappers use (an object
keyed by stem name, or an array in canonical order) rather than committing to one schema.

**The webhook has two independent gates:** the standard-webhooks (svix) signature, and an
unguessable per-round key carried in the callback URL. A delivery for a round that already moved
on is ignored, and anything unrecognised returns 200 so Replicate doesn't retry forever.

**Rate limiting counts rounds, not lobbies** — `INCR ratelimit:games:{today}`, checked before any
GPU time is spent, refunded if the round fails to launch. Default 5/day, `GAMES_PER_DAY` to change.

## Known limitations

Carried over from the spec, all accepted:

- The pool is one person's music — every track comes from the host's playlists.
- Only playlists the host's account owns; followed ones and Spotify's own can't be read.
- The host's Spotify grant is a single point of failure: revoke it and every lobby breaks.
- Par is flat, so the difficulty header carries no information right now.
- 30s previews, so guesses are made on a fragment.
- Three real stems means a short ladder, padded with a clue row and a final row.
- iTunes matching will occasionally pick a remaster or a live version.
- The result-screen Spotify embed plays a preview, not the full track, for logged-out listeners.
- Replicate cold starts can make the loading screen run over a minute.
- 5 rounds/day hard cap.

Deliberately deferred: a replacement difficulty signal for par, per-player playlists if Extended
Quota Mode is approved, song-selection weighting, scoring across a session, leaderboards.
Deliberately not done: caching separated stems.

## Licence

MIT — see [LICENSE](LICENSE). Non-commercial personal project; Vercel Hobby terms apply.
