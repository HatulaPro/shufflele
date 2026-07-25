# Shufflele — Spec

A party game for guessing songs pulled from the players' own Spotify playlists. One phone (the
host's) runs the game; everyone else joins briefly from their own phone only to contribute a
playlist, then puts it away and guesses out loud.

Private/personal project. Deployed to Vercel Hobby (non-commercial use only).

---

## 1. Game flow (UX)

### 1.1 Lobby

**Host phone**
1. Opens the app, taps **Create lobby**.
2. Gets a 6-digit code displayed large on screen.
3. Sees a live-updating list of joined players and whether each has submitted a playlist.
4. The host also joins their own lobby (same join form, inline on the host screen) so their
   playlist is in the pool.
5. **Start game** is enabled once ≥1 playlist has been ingested successfully.

**Guest phones**
1. Open the app, tap **Join**, enter the 6-digit code.
2. Enter their name.
3. Paste a **public Spotify playlist URL**. No sign-in, ever — nobody authenticates with Spotify.
   The UI tells them plainly: *"Your playlist must be public. Spotify → playlist → ⋯ → Edit
   details → Public."*
4. Server validates and ingests the playlist; the guest sees either an error ("that playlist is
   private or the link is wrong") or a **thank-you screen**. That is the last interaction from
   the guest's phone. Nothing else is ever rendered there.

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
6. **Result screen**: reveal the track, whose playlist it came from, and a Spotify embed of the
   track (plays a 30s preview for logged-out listeners — acceptable). Button: **Next song**.

### 1.3 The reveal ladder

Only three usable stems exist (see §3.3 — vocals are withheld by design), so the ladder is
padded to five rows to keep the Bandle feel:

| Row | Unlocks | What you hear |
|-----|---------|---------------|
| 1 | Drums | drums only |
| 2 | + Bass | drums + bass |
| 3 | + Other | full instrumental (everything but vocals) |
| 4 | Clue | instrumental + a text clue (release year already shown; clue reveals the whose-playlist-is-it, or genre) |
| 5 | Final guess | last chance, no new information |

Guessing on row 1 is the maximum score. Burning the last row is a loss.

**Par is derived from the track's Spotify `popularity`** (0–100, returned on the track object at
ingest — no extra call). A well-known song should be expected in fewer stems than an obscure one. Par is display-and-scoring only — it sets the "Difficulty: Medium (par 3)" header and what counts as a good result. It does **not** change how many rows the round has; the ladder length is always driven by how many stems survived the silence check.

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
| Guessed track is from **the same playlist** as the secret track | amber-ish, cool ("getting closer") | `Artist — Title` + **the name of the player who contributed that playlist**, not the playlist's title |
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
                      ├─► Spotify Web API  (Client Credentials — app token, no user OAuth)
                      ├─► iTunes Search API (30s preview mp3 URL)
                      └─► Replicate         (Demucs htdemucs, 4-stem)
```

Everything is stateless request/response. **No WebSockets, no SSE** — Vercel Hobby can't hold a
socket server and SSE would pin a function for its whole duration. The host phone polls; guest
phones don't need updates at all after submitting.

### 2.1 Why no user auth

A new Spotify app is stuck in *development mode*, where only up to 25 manually-registered users
may authorize it, and Extended Quota Mode requires a review a hobby project won't pass. Reading
a **public** playlist needs only a Client Credentials token, which is app-level and uncapped. So:
players make their playlist public and paste the link. Zero logins in the entire product.

### 2.2 Persistence

Upstash Redis is the only datastore. Keys, all with TTL so there is no cleanup job (Hobby allows
only 2 cron jobs at daily granularity):

| Key | Type | TTL | Contents |
|-----|------|-----|----------|
| `lobby:{code}` | JSON | 6h | status, host token, created-at, player list |
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

On playlist submit:
1. Parse the playlist ID out of whatever the user pasted — accept `open.spotify.com/playlist/…`,
   `spotify:playlist:…`, with or without `?si=` tracking params.
2. Fetch a Client Credentials token (cache it in Redis until ~1 min before expiry; it's app-wide,
   not per-user).
3. `GET /v1/playlists/{id}/tracks`, paginating. Cap at 200 tracks per playlist to bound cost and
   keep the client-side search list small.
4. Drop local files, podcast episodes, and nulls.
5. Store per track: `spotifyId, title, artists[{id,name}], albumArt, playlistId, contributor
   (player name), releaseYear, popularity`.
6. A private playlist returns 404 from the API — surface that as the "make it public" error, not
   a generic failure.

**Preview URLs are resolved lazily**, at song-pick time, not at ingest. Only one track per round
needs one, and resolving 200 tracks per player against iTunes would be slow and pointlessly
close to their (informal, ~20 req/min) rate limit.

### 3.2 Song selection and preview resolution

Selection is deliberately naive for now — uniform random over the pool, excluding tracks already
used this lobby. Weighting by popularity/contributor fairness is a later problem.

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
| `/api/lobby/[code]` | GET | — | lobby status + players (host polls this) |
| `/api/lobby/[code]/join` | POST | — | name + playlist URL, ingest, add player |
| `/api/lobby/[code]/start` | POST | host | rate-limit check, pick track, kick off Demucs |
| `/api/lobby/[code]/round/[n]` | GET | host | round state; **vocals stem stripped** |
| `/api/lobby/[code]/round/[n]/guess` | POST | host | submit guess/skip, return feedback tier |
| `/api/lobby/[code]/candidates` | GET | host | full track list for the guess modal |
| `/api/replicate/webhook` | POST | signature | Demucs completion → write stem URLs |

**Guessing is validated server-side.** The client never receives the secret track id, and the
guess route returns only a feedback tier (`correct` / `artist` / `playlist` / `none`) plus, for
the playlist tier, the contributing player's name. Otherwise the answer is one devtools tab away
— which matters, because the host is playing on a phone in front of an audience that can see it.

### 3.6 Config

```
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
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

- Public playlists only; a private one just errors with instructions.
- 30s previews, so guesses are made on a fragment — usually the chorus-adjacent middle, since
  that's what iTunes serves.
- Three real stems means a short ladder, padded with a clue row.
- iTunes matching will occasionally pick a remaster or live version; the retry loop covers total
  misses but not subtly-wrong matches.
- Result-screen Spotify embed plays a preview, not the full track, for logged-out listeners.
- Replicate cold starts can make the loading screen run over a minute.
- 5 games/day hard cap.

## 5. Deliberately deferred

- Song selection algorithm (weighting, difficulty tuning, per-contributor fairness).
- Scoring across a session, leaderboards.
- Visual identity — palette, type, motion.

Explicitly **not** doing: caching separated stems. At 5 games/day across a large pooled track
list, repeats are rare enough that the storage and expiry handling isn't worth it.
