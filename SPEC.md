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
   cold). A progress bar, *"This usually takes a minute."*, and a one-liner about the pooled
   playlists that changes every 6 seconds — *"3 songs, John? Weak."*, *"81% of this pool is
   Maya's. Tyrant."* Short enough for a phone, name the player, insult them, stop. The pipeline is
   not narrated and the rules are not explained: which stem is being separated is nobody's
   entertainment, and the room already knows how the game works. Lines come from
   `GET /api/lobby/:code/quips` (§3.5), computed once per round from the pool already in Redis.
   Every "how much" is a share of the pool rather than a raw count — 5 plays of one artist is
   nothing in 400 songs — and no line may point at the secret: titles are counted, never quoted,
   and a single release year is never attributed to a player, since the guess screen shows the
   secret's year and the pair together would give away the `playlist` tier (§1.5). A wide era
   *range* per player is fine, it says almost nothing.

   The material is whatever ingest already stored (§3.1): playlist sizes, artist concentration,
   duplicate songs, `explicit`, `duration_ms`, `album.release_date`, album vs single, and
   `popularity`. Popularity lines follow the same non-identifying rule and it bites harder there,
   because the guess screen shows a difficulty label derived straight from the secret's popularity
   (§1.3): "everything Maya brought is obscure" plus a `Very hard` header is the release-year leak
   again. So pool-wide shares, which name nobody, and exactly one per-player line — a *spread*,
   safe for the same reason the era range is. Each per-player dig picks the *most* extreme playlist
   rather than the first that qualifies, so a lobby mocks the same person for the same thing every
   round. Host phone polls status every 2s.
3. **Guess screen** (the Bandle-like layout from the reference):
   - Header: song metadata that is *not* identifying — release year.
   - A vertical list of numbered rows. Row 1 is unlocked; the rest unlock as rows burn, and
     carry no "locked" labelling of their own.
   - Playback controls under the list: play/pause, ±5s, volume, and a scrubber.
   - **SKIP** and **GUESS** buttons at the bottom.
4. The host guesses. Each guess or skip burns the current row, logs the attempt into that row,
   and unlocks the next one (adding another stem to the mix).
5. Round ends when the host guesses correctly (**win**) or burns the last row (**lose**).
6. **Result screen**: reveal the track, whose playlist it came from, and a Spotify embed of the
   track (plays a 30s preview for logged-out listeners — acceptable). Button: **Next song**.

### 1.3 The reveal ladder

Only three usable stems exist (see §3.3 — vocals are withheld by design), so the ladder is one
row per stem plus a final row:

| Row | Unlocks | What you hear |
|-----|---------|---------------|
| 1 | Drums | drums only |
| 2 | + Bass | drums + bass |
| 3 | + Other | full instrumental (everything but vocals) |
| 4 | Final guess | last chance + a lyric hint |

Guessing on row 1 is the maximum score. Burning the last row is a loss.

**The final row shows a lyric hint**: one random line of the song's lyrics, from lyrics.ovh (no
token, no auth). Any line containing a distinctive word of the title or the primary artist's name
is excluded — for *Cruel Summer*, no line with "cruel" or "summer" (prefix-matched, so "summers"
counts too), with stopwords like "the" exempt so a title like *The Man* only bans "man". The line
is fetched server-side one row before the final row unlocks and stored on the round, so it never
changes between polls and the client never sees anything derived from the title. When lyrics.ovh
has no match, times out, or every line would give the song away, the row falls back to its plain
"last chance" label — the hint is decoration, never load-bearing.

**Par** is the row you're expected to get it by, shown in the header as `Medium · par 3` and
restated on the result screen (`2 rows used — par 3`). It is display-and-scoring only — it never
changes how many rows the round has. It comes from Spotify's own 0–100 `popularity`, which
arrives with the tracklist at ingest for every track (§2.1, §3.1):

| `popularity` | Difficulty | Par |
|---|---|---|
| 75–100 | Very easy | 1 |
| 60–74 | Easy | 2 |
| 40–59 | Medium | 3 |
| 20–39 | Hard | 4 |
| 0–19 | Very hard | 4 |

A full ladder is four rows, so par caps there — Hard and Very hard share a par and differ only in
label. When the payload omits `popularity` for a track, the round runs with no difficulty header
rather than an invented one.

**There is no clue row.** It only ever restated whose playlist the track came from, which the
`playlist` guess tier (§1.5) and the reveal already say.

If the silence check (§3.3) rejects a stem, that row is dropped and the ladder shortens for that
round — the UI renders whatever rows the round actually has, it is not hardcoded.

### 1.4 The guess modal

Full-screen overlay opened by **GUESS**.

- A single search field, autofocused.
- **Empty by default — no results shown until the user types.** This matters: the candidate list
  is every track from every playlist, and showing it would leak the answer set.
- Substring match, case- and diacritic-insensitive, against **both** track title and artist
  name(s). Client-side over the full candidate list (a few thousand rows at most, trivially
  fast).
- Each result row: title and artist only — no artwork.
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
                      ├─► api.spotify.com/v1/playlists/{id}  (tracklist + popularity + art)
                      │      └─ token via /api/internal/spotify-token (Edge) ─► chosic.com
                      ├─► iTunes Search API (30s preview mp3)
                      └─► Replicate         (Demucs htdemucs, 4-stem)
```

Everything is stateless request/response. **No WebSockets, no SSE** — Vercel Hobby can't hold a
socket server and SSE would pin a function for its whole duration. The host phone polls; guest
phones don't need updates at all after submitting.

### 2.1 How playlists are read without anyone logging in

Ingest is the plain Web API: `GET /v1/playlists/{id}` for the name and total, then
`GET /v1/playlists/{id}/tracks?limit=100&offset=…` until the playlist runs out. A `fields=`
projection trims the response to what is stored — chiefly to drop `available_markets`, which is
~180 country codes on both the track and its album and dwarfs everything wanted.

That one response carries `popularity`, `album.images`, `album.release_date`, `explicit`,
`duration_ms`, `album.name`, `album.album_type` and artist **ids**. No second source, no per-track
follow-up, nothing resolved lazily except the preview.

The difficulty is entirely in obtaining a usable token.

**Extended quota mode is the gate.** An app without it 403s on `GET /v1/playlists/{id}` for any
playlist it does not own, and never sees `popularity` on any endpoint at any auth level. This is
not a Client-Credentials-versus-user-token distinction — both fail, because the gate is the app:

- Client Credentials: `403` on playlist contents.
- A user token: reads playlists that account **owns**, and 403s a public playlist made by someone
  else even when the account follows it. Since the game is guests bringing *their* playlists, that
  path is closed.
- Per-guest OAuth: Development Mode admits 25 users registered by hand in the dashboard, which
  guests scanning a QR code cannot satisfy.

Extended quota mode lifts all three, and is a Spotify review that expects an organisation.

**So the token is borrowed from an app that has it.** chosic.com's playlist analyser calls
`api.spotify.com` from the browser with a token it fetches from its own unauthenticated
`POST /api/tools/t/` — no login, no cookie. `src/lib/broker.ts` asks the same way. Load-bearing,
each established by probing: a browser `User-Agent` **and** a `Referer` of the analyser page (both
required, or Cloudflare serves its challenge page), and an `app: playlist_analyzer` header (or
WordPress answers `empty params`). The response is a JSON *string* containing JSON, and its `time`
field is seconds remaining, not an expiry stamp.

#### 2.1.1 Why the token fetch runs on the Edge runtime

Cloudflare fingerprints the TLS handshake in front of chosic.com, and **Node's ClientHello does not
pass**. Measured, interleaved, on the same machine and IP: Node/OpenSSL `403` on every attempt,
curl/Schannel `200` on every attempt. What was tried and does not move it — header order and
casing, Chrome cipher and curve ordering, `honorCipherOrder`, `sigalgs`, TLS 1.2-only, TLS 1.3-only,
and HTTP/2 via `node:http2`. The ClientHello is simply not reachable from JavaScript.

Doing it from the guest's browser is closed as well: chosic's `access-control-allow-origin` is
pinned to their own origin and the CORS preflight `403`s, so a cross-origin page cannot read the
response even if Cloudflare let it through.

The Edge runtime does not use Node's TLS stack. So the fetch — and only the fetch — is carved out
into `POST /api/internal/spotify-token`, which runs on Edge and is gated by `INTERNAL_API_SECRET`;
the Node routes that read playlists call it over HTTP. The result is cached in Redis for the whole
deployment, so that hop costs about one request an hour, and the token is shared rather than minted
per cold start.

`next dev` emulates Edge on Node, so neither path works locally. `SPOTIFY_TOKEN_OVERRIDE` takes a
hand-pasted token for development.

#### 2.1.2 What this costs, honestly

- It is **someone else's endpoint, someone else's credentials and someone else's quota**. It can be
  rate-limited, moved behind the Turnstile widget that page already loads, or changed, with no
  notice. Every path out of the broker returns null and surfaces a message, but ingest is down when
  it does.
- `SPOTIFY_CLIENT_ID`/`SECRET` is the exit. They are tried **first**, and a `403` on the first
  request of an instance is what demotes them; if the deployment's own app ever gets extended quota
  mode, setting them makes everything above unreachable.
- What got better in exchange: Spotify's own editorial playlists read fine, where an ordinary app
  404s them; and the whole tracklist is available, not a first page.

### 2.2 Persistence

Upstash Redis is the only datastore. Keys, all with TTL so there is no cleanup job (Hobby allows
only 2 cron jobs at daily granularity):

| Key | Type | TTL | Contents |
|-----|------|-----|----------|
| `lobby:{code}` | JSON | 6h | status, host token, created-at, player list |
| `lobby:{code}:tracks` | JSON | 6h | every ingested track for the lobby (see §3.1) |
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
1. Parse the playlist ID out of whatever the user pasted — accept `open.spotify.com/playlist/…`
   (including `/intl-xx/` and `/embed/` forms), `spotify:playlist:…`, or a bare id, with or
   without `?si=` tracking params.
2. `GET /v1/playlists/{id}?fields=name,tracks(total)` for the display name and the page count.
3. `GET /v1/playlists/{id}/tracks?limit=100&offset=…` until `total` (capped, see below) is reached
   or a short page comes back. Both calls carry the token from §2.1.
4. Drop entries flagged `is_local` (local files carry no id) and entries whose `track` is null
   (pulled from the catalogue).
5. Store per track: `spotifyId, title, artists[{id,name}], albumArt, releaseYear, popularity,
   explicit, durationMs, albumName, albumType, previewUrl, playlistId, contributor (player name)`.
   Nothing is deferred to pick time except the iTunes preview (§3.2).
6. **A private or nonexistent playlist answers `404`**, and the two are indistinguishable, so the
   "make it public" message covers both.

**500 tracks per playlist, capped.** The endpoint pages as far as you like; the limit is that a
lobby's tracks live in one Redis value, read and rewritten on every join, and 16 players at this
cap is already ~8k tracks. A longer playlist contributes its first 500 songs.

**Artist ids are real**, which `artistKey` prefers over the normalised name — the artist guess tier
(§1.5) no longer has to decide whether two spellings are the same band.

**The whole ingest is cached in Redis for 10 minutes**, keyed by playlist id and stored with an
empty contributor (stamped per caller on the way out). It absorbs the common burst — a re-join, or
friends sharing a playlist across lobbies — and spares a 500-song playlist its five API calls each
time. The TTL is short because people edit playlists.

### 3.2 Song selection and preview resolution

**Every ingested track is a candidate.** There used to be a sampling stage here that marked a
subset `pooled`, because popularity cost one Deezer search per track and the budget stretched to
about 150 a lobby; popularity arrives with the tracklist now, so there is nothing left to ration
and the stage is gone. The guess-modal search (§1.4) and the answer set are therefore the same set,
which is fine — search shows nothing until the user types, so it never displays the answer set on
screen.

Selection runs in three stages over the tracks not already used or marked unusable this lobby:

1. **A playlist, uniformly at random.** Every player's playlist has the same chance no matter how
   many tracks it contributed — a 30-song playlist matters exactly as much as a 300-song one, and
   picking the playlist first gets that without any size normalisation.
2. **A track inside it, weighted by `exp(-deficit / 10)`**, where `deficit` is how far the track's
   `popularity` sits below its *own playlist's* 90th percentile, clamped to `[0, 50]`.
3. **With probability 0.1, ignore stage 2** and draw uniformly from the playlist instead.

Weighting on the gap rather than the raw 0–100 score is what makes one formula behave differently
per playlist with no per-playlist tuning. A playlist of global hits spans maybe 75–92, so its
least-likely song is only ~5x behind its most-likely — effectively a fair draw. An alternative
playlist spans 5–65, so its deep cuts sit 50 points down and are ~148x rarer (the clamp's floor).
Simulated over 200k draws at 250 tracks/playlist, picks land in the playlist's top/2nd/3rd/bottom
popularity quartile roughly 43/29/18/10 for the tight playlist and 70/20/7/3 for the wide one.

The reference point is the 90th percentile rather than the max so the whole top decile ties for
maximum weight: a 200-song playlist gets a head of ~20 songs instead of one mega-hit that flattens
everything under it, and one outlier smash in an otherwise niche playlist stays harmless.

Repetition is handled without any new state. Within a lobby the used-track exclusion already drains
the head; across lobbies the 10% uniform mixture and the deficit clamp keep the head from being the
only thing anyone ever hears (effective pool size stays in the 80–180 range for a 100–400 track
playlist, not 4). A track whose popularity is null counts as its playlist's median, so a
track the payload omitted the field for is left unlabelled rather than unpickable; a playlist with
no popularity at all degenerates to a uniform draw.

Cost is one O(n) group plus one O(m log m) sort of the chosen playlist — ~0.03 ms for a 1000-track
pool, so the retry loop below can afford to re-draw from scratch every attempt.

Weighting by contributor fairness is still a later problem.

**iTunes is the preview source.** The tracklist also carries Spotify's own `preview_url` (for
roughly six tracks in seven), which is appealing because it's the exact recording rather than a
search match —
but its length is inconsistent in a way that breaks the game. Sampled across 50 tracks from two
playlists: 17 ran the full ~30s, 17 came in at 20–28s, and 16 were under 20s, the shortest 15s.
Architects' "Curse" is 16s against a 181s track. A 16s clip is not a round. So the Spotify preview
is kept only as a fallback for tracks iTunes can't match at all, where the alternative is skipping
the track entirely.

The preview is now the *only* thing iTunes is asked for. Album art and release year used to come
from it too, because the embed payload had no field for either; they arrive at ingest now, and
Spotify's win — the iTunes values survive only as a fallback for a track that somehow has neither.

```
for attempt in 1..8:
    track = pick_secret(eligible)             # the three stages above
    match = itunes_lookup(track)              # preview (+ art/year as fallback)
    preview = match.previewUrl or track.previewUrl   # Spotify only as a fallback
    if preview:
        return track + {albumArt, releaseYear preferring Spotify's}, preview
    mark track unusable for this lobby
fail the round with "couldn't find a playable track"
```

iTunes matching: `https://itunes.apple.com/search?term={artist track}&media=music&limit=10`,
then score candidates on normalized title + artist similarity and require a threshold, so
"Live at Wembley" and karaoke covers don't slip through. Take `previewUrl`, `artworkUrl100`
(requested at 300×300 off the same path) and `releaseDate` from the winner.

### 3.3 Stem separation

- Replicate, `htdemucs` (4-stem), **not** `htdemucs_6s`. The 6-stem model's guitar and piano
  outputs are unreliable and frequently near-silent, which produces dead rounds.
- Input is the preview URL **directly**, whether it came from Spotify (`p.scdn.co`) or iTunes —
  both are already public URLs, so nothing needs to be downloaded into or uploaded from a Vercel
  function.
- We use `drums`, `bass`, `other`. **`vocals` is fetched but never served to the client** — the
  API response for a round strips it, so it can't be pulled out of devtools.
- Predictions are created with `POST /v1/predictions` and an explicit `version`. The tidier
  `POST /v1/models/{owner}/{name}/predictions`, which runs a model's latest version with no hash,
  is **official-models-only** — a community model answers 404 there. The version is resolved from
  `GET /v1/models/{owner}/{name}` and memoised per process, so no hash is hardcoded.
- **Async, never blocking.** The start-round route creates the prediction and returns
  immediately; a Replicate **webhook** writes the stem URLs into the round key when it completes,
  and the host polls a status route every 2s. Hobby functions cap at 60s (300s with Fluid
  compute) and a cold Demucs boot can exceed that, so holding the request is not an option.
- **The webhook is only sent to HTTPS origins.** Replicate rejects an `http://` callback with a
  422 that fails the whole prediction rather than just the callback, so on a local origin it is
  omitted and the poll fallback below carries the round.
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
| `/api/lobby/[code]/round/[n]/ladder` | POST | host | finalise the ladder after the browser's silence check (§3.3) |
| `/api/lobby/[code]/candidates` | GET | host | full track list for the guess modal |
| `/api/lobby/[code]/quips` | GET | host | loading-screen lines about the pooled playlists (§1.2) |
| `/api/replicate/webhook` | POST | signature | Demucs completion → write stem URLs |

**Guessing is validated server-side.** The client never receives the secret track id, and the
guess route returns only a feedback tier (`correct` / `artist` / `playlist` / `none`) plus, for
the playlist tier, the contributing player's name. Otherwise the answer is one devtools tab away
— which matters, because the host is playing on a phone in front of an audience that can see it.

### 3.6 Config

`INTERNAL_API_SECRET` is required — without it the Edge token route is disabled and no playlist
can be read (§2.1.1). `SPOTIFY_CLIENT_ID`/`SECRET` are useful only with extended quota mode;
`SPOTIFY_TOKEN_OVERRIDE` is local development only.

```
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
- **The first 500 tracks of a playlist** — a Redis-size cap, not an API one (§3.1).
- **The Spotify token is borrowed** from a third party's unauthenticated endpoint, behind a bot
  check, spending their quota. It can break on any day with no notice (§2.1.2).
- Par is a global popularity score, not a read on *this* room — a niche track everyone present
  happens to know still shows as Very hard (§1.3).
- Par thresholds are absolute while selection is now relative (§3.2), so most rounds land on Very
  easy / Easy and par 4–5 is rare. Making par playlist-relative too is a later call.
- 30s previews, so guesses are made on a fragment.
- Three real stems means a short, four-row ladder.
- Where a track has no Spotify preview, the iTunes fallback will occasionally pick a remaster or
  live version; the retry loop covers total misses but not subtly-wrong matches.
- Result-screen Spotify embed plays a preview, not the full track, for logged-out listeners.
- Replicate cold starts can make the loading screen run over a minute.
- 5 games/day hard cap.

## 5. Deliberately deferred

- Difficulty tuning and per-contributor fairness in selection. Popularity weighting itself is
  done (§3.2).
- Scoring across a session, leaderboards.
- Visual identity — palette, type, motion.

Explicitly **not** doing: caching separated stems. At 5 games/day across a large pooled track
list, repeats are rare enough that the storage and expiry handling isn't worth it.
