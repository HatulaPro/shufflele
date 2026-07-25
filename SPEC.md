# Shufflele — Spec

A party game for guessing songs pulled from the host's Spotify playlists. One phone (the host's)
runs the game; everyone else joins briefly from their own phone only to give a name, then puts it
away and guesses out loud.

> The original design pooled a playlist from *every* player. Spotify now serves a playlist's
> contents only to the account that owns it, so that is no longer buildable — see §2.1.

Private/personal project. Deployed to Vercel Hobby (non-commercial use only).

---

## 1. Game flow (UX)

### 1.1 Lobby

**Host phone**
1. Opens the app, taps **Create lobby**.
2. Gets a 6-digit code displayed large on screen.
3. Sees a live-updating list of joined players.
4. Picks playlists for the pool from a list of the ones the server's Spotify account owns — no
   URL to paste, no link to find. Up to 8 per lobby; each is ingested on tap and its track count
   shown. Tracks already pooled from an earlier playlist are not added twice.
5. **Start game** is enabled once ≥1 playlist has been ingested successfully.

**Guest phones**
1. Open the app, tap **Join**, enter the 6-digit code.
2. Enter their name. Names must be unique within a lobby, since the reveal screen credits them.
3. That's it — no sign-in, ever, and nothing to paste. The guest sees a **thank-you screen**, and
   that is the last interaction from their phone. Nothing else is ever rendered there.

The guest lobby view never includes the playlist list: the names of the pooled playlists are the
answer to the playlist guess tier (§1.5), so the lobby route only sends `sources` to the host.

### 1.2 Round

1. Host taps **Start game**. Server picks a secret track from the pooled tracks.
2. **Loading screen** while the preview is fetched and Demucs runs (~20–40s warm, up to ~2min
   cold). Show a progress narrative, not a spinner: *Finding the track → Separating the drums →
   Almost there.* Host phone polls status every 2s.
3. **Guess screen** (the Bandle-like layout from the reference):
   - Header: song metadata that is *not* identifying — release year, difficulty/par.
   - A vertical list of numbered rows. Row 1 is unlocked; the rest are locked.
   - Playback controls under the list: play/pause, ±5s, volume, and a scrubber.
   - **SKIP** and **GUESS** buttons at the bottom.
4. The host guesses. Each guess or skip burns the current row, logs the attempt into that row,
   and unlocks the next one (adding another stem to the mix).
5. Round ends when the host guesses correctly (**win**) or burns the last row (**lose**).
6. **Result screen**: reveal the track, which playlist it came from, and a Spotify embed of the
   track (plays a 30s preview for logged-out listeners — acceptable). Button: **Next song**.

### 1.3 The reveal ladder

Only three usable stems exist (see §3.3 — vocals are withheld by design), so the ladder is
padded to five rows to keep the Bandle feel:

| Row | Unlocks | What you hear |
|-----|---------|---------------|
| 1 | Drums | drums only |
| 2 | + Bass | drums + bass |
| 3 | + Other | full instrumental (everything but vocals) |
| 4 | Clue | instrumental + a text clue (release year already shown; clue names the playlist it came from) |
| 5 | Final guess | last chance, no new information |

Guessing on row 1 is the maximum score. Burning the last row is a loss.

**Par is currently flat — every round is par 3.** It was derived from the track's Spotify
`popularity` (0–100) at ingest, so a well-known song was expected in fewer stems than an obscure
one. Spotify no longer returns `popularity` on any endpoint that still works (not on playlist
items, not on `/tracks/{id}`, not on `/artists/{id}`, not on search results), so there is no
per-track difficulty signal left to read. Replacing it is deferred — see §5.

Par is display-and-scoring only — it sets the "Difficulty (par 3)" header and what counts as a
good result. It does **not** change how many rows the round has; the ladder length is always
driven by how many stems survived the silence check.

If the silence check (§3.3) rejects a stem, that row is dropped and the ladder shortens for that
round — the UI renders whatever rows the round actually has, it is not hardcoded to five.

### 1.4 The guess modal

Full-screen overlay opened by **GUESS**.

- A single search field, autofocused.
- **Empty by default — no results shown until the user types.** This matters: the candidate list
  is every track from every playlist, and showing it would leak the answer set.
- Substring match, case- and diacritic-insensitive, against **both** track title and artist
  name(s). Client-side over the full candidate list (a few thousand rows at most, trivially
  fast).
- Each result row: title, artist, album art thumb.
- Tapping a row submits that guess and closes the modal. No confirm step.
- Already-guessed tracks are shown greyed out and are not tappable.

### 1.5 Guess feedback colours

Every logged guess is rendered inside the row it burned, showing `Artist — Title` under the row
label, with a colour that encodes how close it was. Ordered from coldest to warmest:

| Condition | Colour | Extra text shown |
|-----------|--------|------------------|
| No relation to the secret track | red / muted | `Artist — Title` |
| Guessed track is from **the same playlist** as the secret track | amber-ish, cool ("getting closer") | `Artist — Title` + **the playlist's name** |
| Guessed track's **artist matches** the secret track's artist | warm orange/gold ("so close") | `Artist — Title` |
| Correct track | green | `Artist — Title` |

Artist match outranks playlist match — if a guess is both, show the artist colour.

Artist matching compares normalized primary-artist IDs (Spotify artist ID when available,
normalized name as fallback), so featured-artist noise doesn't create false positives.

---

## 2. Architecture

```
Host phone ──┐
             ├─► Next.js (App Router) on Vercel Hobby
Guest phones ┘        │
                      ├─► Upstash Redis    (all state; HTTP client, no pooling)
                      ├─► Spotify Web API  (one long-lived host grant; no per-player OAuth)
                      ├─► iTunes Search API (30s preview mp3 URL)
                      └─► Replicate         (Demucs htdemucs, 4-stem)
```

Everything is stateless request/response. **No WebSockets, no SSE** — Vercel Hobby can't hold a
socket server and SSE would pin a function for its whole duration. The host phone polls; guest
phones don't need updates at all after submitting.

### 2.1 Why the pool is the host's, and why guests still never log in

Two Spotify constraints, pulling in opposite directions.

**Client Credentials can no longer read playlists.** `GET /v1/playlists/{id}/items` answers
`401 Valid user authentication required` for an app token. The older `/tracks` sub-resource that
this spec was written against is retired and answers `403` to *everyone*, including Spotify's own
first-party docs console. Playlist reads now require a user token, full stop.

**A user token only reads playlists its own account owns.** Not "public playlists" — owned ones.
A playlist that is public, made by an ordinary user, and even followed into the token-holder's
own library still returns `403` on its contents. Metadata (name, owner, artwork) reads fine; the
tracks do not. This was verified directly, and it is the constraint that kills the original
design: there is no auth flow under which the server can read a guest's playlist.

**Per-guest OAuth is not a way out.** An app in development mode admits only 25 users, each added
by hand in the dashboard with their Spotify account email — incompatible with guests who scan a
QR code at a party. Extended Quota Mode lifts that, but it's a review with an uncertain outcome.

So: the server holds **one** long-lived user grant (`SPOTIFY_REFRESH_TOKEN`, minted once by
`npm run spotify:auth`) and reads every playlist as that single account. The host picks from that
account's own playlists. Guests still authenticate with nothing — the property this spec cared
about is preserved, just for a different reason than originally written.

Refresh tokens from the Authorization Code flow don't expire on a timer. They die when the app is
revoked at spotify.com/account/apps, when the client secret is rotated, or when the requested
scopes change. `invalid_grant` from the token endpoint is treated as exactly that and surfaced as
"re-run `npm run spotify:auth`" rather than a generic failure. Scopes requested:
`playlist-read-private`, `playlist-read-collaborative`.

**Also lost to the same round of API restrictions**, each verified rather than assumed: track
`popularity` (§1.3), playlist *search* (returns nothing), `/recommendations` (404), batch
`/tracks?ids=` and `/artists?ids=` (403 at any batch size), and Spotify's own editorial and
algorithmic playlists — Discover Weekly, Release Radar, Top 50 all 404 regardless of auth.

One shape change to watch for when reading the API: the playlist body and `/me/playlists` entries
now carry their paging object under **`items`**, not `tracks`, and each entry nests the track
under **`item`**, not `track`. Passing a `fields` mask written against the old shape returns
`200` with an empty object rather than an error, which makes this failure mode silent.

### 2.2 Persistence

Upstash Redis is the only datastore. Keys, all with TTL so there is no cleanup job (Hobby allows
only 2 cron jobs at daily granularity):

| Key | Type | TTL | Contents |
|-----|------|-----|----------|
| `lobby:{code}` | JSON | 6h | status, host token, created-at, player list, ingested playlists |
| `lobby:{code}:tracks` | JSON | 6h | pooled candidate tracks (see §3.1) |
| `lobby:{code}:round:{n}` | JSON | 6h | secret track id, stem URLs, ladder, guesses, state |
| `ratelimit:games:{YYYY-MM-DD}` | counter | 48h | games started today |

The 6-digit code is generated by retrying `SET lobby:{code} … NX` until it lands on a free key —
collisions are handled by the atomic set, not by a lookup-then-write race.

Authority: the host holds an opaque `hostToken` (set as an httpOnly cookie on lobby creation).
Any mutating route on a lobby requires it. Guests need only the code.

### 2.3 Rate limit

`INCR ratelimit:games:{today}` with `EXPIRE` on first write, checked before starting a round. At
**5 games/day** the start route returns a friendly "daily limit reached" screen. This exists
purely to cap Replicate spend, since each round costs a few cents of GPU time and a runaway loop
could get expensive.

---

## 3. Technical detail

### 3.1 Playlist ingestion

The host picks a playlist id from the picker; there is no URL to parse.

1. Refresh the host grant into an access token (cached in Redis until ~1 min before expiry, under
   a key versioned by token type — a cached app token from an older deploy is not interchangeable
   with a user token and yields a bare `401`).
2. `GET /v1/playlists/{id}/items`, paginating. Cap at 200 tracks per playlist to bound cost and
   keep the client-side search list small. Each entry's track is under `item`, not `track`.
3. Drop local files, podcast episodes, and nulls.
4. Drop tracks already pooled from an earlier playlist in this lobby, so a song in two playlists
   is attributed to whichever was added first and never appears twice in the guess list.
5. Store per track: `spotifyId, title, artists[{id,name}], albumArt, playlistId, contributor
   (playlist name), releaseYear`.
6. A 404 means private, deleted, or Spotify-owned — surface it as guidance, not a generic
   failure. A 401 means the server's grant died; name the fix script.

The picker itself (`GET /v1/me/playlists`) filters to playlists the account **owns**. Followed
playlists come back in that response but their contents are unreadable, so listing them would only
produce a 403 on tap.

**Preview URLs are resolved lazily**, at song-pick time, not at ingest. Only one track per round
needs one, and resolving 200 tracks per playlist against iTunes would be slow and pointlessly
close to their (informal, ~20 req/min) rate limit.

### 3.2 Song selection and preview resolution

Selection is deliberately naive for now — uniform random over the pool, excluding tracks already
used this lobby. Weighting is a later problem, and popularity-based weighting is no longer
possible anyway (§1.3).

Because a picked track may have no iTunes match, selection and resolution are one loop:

```
for attempt in 1..8:
    track = pick_unused_random()
    preview = itunes_lookup(track)         # search by "artist title", then match
    if preview: return track, preview
    mark track unusable for this lobby
fail the round with "couldn't find a playable track"
```

iTunes matching: `https://itunes.apple.com/search?term={artist track}&media=music&limit=10`,
then score candidates on normalized title + artist similarity and require a threshold, so
"Live at Wembley" and karaoke covers don't slip through. Take `previewUrl` from the winner.

### 3.3 Stem separation

- Replicate, `htdemucs` (4-stem), **not** `htdemucs_6s`. The 6-stem model's guitar and piano
  outputs are unreliable and frequently near-silent, which produces dead rounds.
- Input is the iTunes `previewUrl` **directly** — it's already a public URL, so nothing needs to
  be downloaded into or uploaded from a Vercel function.
- We use `drums`, `bass`, `other`. **`vocals` is fetched but never served to the client** — the
  API response for a round strips it, so it can't be pulled out of devtools.
- **Async, never blocking.** The start-round route creates the prediction and returns
  immediately; a Replicate **webhook** writes the stem URLs into the round key when it completes,
  and the host polls a status route every 2s. Hobby functions cap at 60s (300s with Fluid
  compute) and a cold Demucs boot can exceed that, so holding the request is not an option.
- **Silence check**: after separation, each stem is evaluated for whether it carries real signal.
  Cheapest workable version — compare the stem file's byte size against the mix as a proxy, and
  if that's too crude, decode in the browser and compute RMS over the buffer, rejecting anything
  below roughly -45 dBFS. A rejected stem's row is dropped from the ladder before the guess
  screen renders.

### 3.4 Playback

Web Audio API, not `<audio>` elements — multiple `<audio>` tags drift out of sync within seconds.

- Fetch and `decodeAudioData` all unlocked stems up front.
- Play by creating one `AudioBufferSourceNode` per unlocked stem and `start(t)`-ing them all at
  the same `AudioContext.currentTime` offset. Each gets its own `GainNode`.
- Unlocking a new stem doesn't restart playback conceptually, but practically it does — restart
  from the same offset with the new node set.
- iOS requires a user gesture to unlock the `AudioContext`; the first tap on play does it. Never
  attempt autoplay.
- Scrub / ±5s = stop all nodes, recreate at the new offset. Track position with
  `currentTime - startedAt`, since source nodes are one-shot.

### 3.5 API routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/lobby` | POST | — | create lobby, return code, set hostToken cookie |
| `/api/lobby/[code]` | GET | — | lobby status + players; playlists only for the host |
| `/api/lobby/[code]/join` | POST | — | name, add player |
| `/api/lobby/[code]/playlists` | GET | host | the host account's own playlists, for the picker |
| `/api/lobby/[code]/playlists` | POST | host | ingest one playlist into the pool |
| `/api/lobby/[code]/start` | POST | host | rate-limit check, pick track, kick off Demucs |
| `/api/lobby/[code]/round/[n]` | GET | host | round state; **vocals stem stripped** |
| `/api/lobby/[code]/round/[n]/guess` | POST | host | submit guess/skip, return feedback tier |
| `/api/lobby/[code]/candidates` | GET | host | full track list for the guess modal |
| `/api/replicate/webhook` | POST | signature | Demucs completion → write stem URLs |

**Guessing is validated server-side.** The client never receives the secret track id, and the
guess route returns only a feedback tier (`correct` / `artist` / `playlist` / `none`) plus, for
the playlist tier, the playlist's name. Otherwise the answer is one devtools tab away
— which matters, because the host is playing on a phone in front of an audience that can see it.

### 3.6 Config

```
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
SPOTIFY_REFRESH_TOKEN       # from `npm run spotify:auth`; see §2.1
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
REPLICATE_API_TOKEN
REPLICATE_WEBHOOK_SECRET
NEXT_PUBLIC_BASE_URL        # webhook callback target
```

### 3.7 Design constraints

Mobile-first, portrait. The reference screenshots define the **layout and mechanics** we want —
a numbered vertical list of locked/unlocked stem rows, guesses logged inline in the row they
burned, playback controls beneath, guess/skip at the bottom. They do **not** define the visual identity: Shufflele gets its own palette, type, and mood.
---

## 4. Known limitations, accepted

- **The pool is one person's music.** Every track comes from the host's playlists, so the game is
  "guess songs from the host's library" rather than "guess whose song this was". Restoring the
  per-player pool depends on Extended Quota Mode being approved (§2.1).
- The host's Spotify account is a single point of failure: revoke the app and every lobby breaks
  until the auth script is re-run.
- Playlists the host follows but doesn't own can't be used, even public ones.
- Spotify's own playlists (Discover Weekly, Release Radar, Top 50) can't be used at all.
- Par is flat, so the difficulty header and scoring carry no information right now.
- 30s previews, so guesses are made on a fragment — usually the chorus-adjacent middle, since
  that's what iTunes serves.
- Three real stems means a short ladder, padded with a clue row.
- iTunes matching will occasionally pick a remaster or live version; the retry loop covers total
  misses but not subtly-wrong matches.
- Result-screen Spotify embed plays a preview, not the full track, for logged-out listeners.
- Replicate cold starts can make the loading screen run over a minute.
- 5 games/day hard cap.

## 5. Deliberately deferred

- **A replacement difficulty signal for par.** Release year is still available; guess data across
  rounds would measure real difficulty rather than approximating it.
- **Per-player playlists, if Extended Quota Mode is approved.** Guests would authorize once and
  pick from their own playlists; the `sources` model extends to per-player sources rather than
  being rewritten, and `contributor` goes back to naming a person.
- Song selection algorithm (weighting, difficulty tuning, per-contributor fairness).
- Scoring across a session, leaderboards.
- Visual identity — palette, type, motion.

Explicitly **not** doing: caching separated stems. At 5 games/day across a large pooled track
list, repeats are rare enough that the storage and expiry handling isn't worth it.
