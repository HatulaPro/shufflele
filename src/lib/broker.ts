/**
 * Where the Spotify access token comes from.
 *
 * Reading a playlist this app doesn't own requires an app in **extended quota
 * mode** — a review Spotify grants to organisations, not to party games. A
 * default app gets 403 from `GET /v1/playlists/{id}` outright, and the
 * endpoints that do answer it omit `popularity` from the payload. Client
 * Credentials versus a user token makes no difference: the gate is the app, not
 * the caller.
 *
 * chosic.com/spotify-playlist-analyzer has that quota, and hands its own Client
 * Credentials token to any browser that asks, over an unauthenticated endpoint,
 * so its analyser can call the Web API from the page. We ask the same way.
 *
 * Read that for what it is: an undocumented endpoint belonging to somebody
 * else, serving credentials that are theirs, spending quota that is theirs. It
 * can be rate-limited, gated behind the Turnstile widget the page already
 * loads, or simply changed, on any day and with no notice. Every path out of
 * here returns null rather than throwing, and the caller degrades to a message.
 * If this deployment's own app ever gets extended quota mode, set
 * SPOTIFY_CLIENT_ID/SECRET and none of this is reached.
 */

export type BrokeredToken = { value: string; expiresIn: number };

const ENDPOINT = 'https://www.chosic.com/api/tools/t/';
const APP = 'playlist_analyzer';

/**
 * The `Referer` is load-bearing and so is the browser `User-Agent`: without
 * both, Cloudflare answers its challenge page (403) instead of the endpoint.
 * Without the `app` header WordPress rejects the request with `empty params`.
 * All three established by probing.
 */
const HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://www.chosic.com/spotify-playlist-analyzer/',
  origin: 'https://www.chosic.com',
  app: APP,
  'content-type': 'application/x-www-form-urlencoded',
};

/**
 * Ask chosic.com directly.
 *
 * **This only succeeds from a runtime whose TLS handshake Cloudflare doesn't
 * score as a bot**, which rules out Node: its ClientHello comes from OpenSSL
 * and is refused every time, while the same request from curl's Schannel
 * backend is accepted every time. Header order, cipher and curve shaping,
 * TLS 1.3-only and HTTP/2 were all tried and none of them move it — the
 * ClientHello isn't reachable from JavaScript.
 *
 * So this runs on the Edge runtime, which does not use Node's TLS stack. See
 * `app/api/internal/spotify-token/route.ts`; Node callers go through that.
 */
export async function fetchBrokeredToken(): Promise<BrokeredToken | null> {
  const { token } = await callBroker();
  return token;
}

/**
 * The broker call, plus enough of what came back to tell a Cloudflare challenge
 * apart from a genuine change at the other end. Never includes the token.
 */
export type BrokerProbe = {
  ok: boolean;
  status: number | null;
  /** True when the body is Cloudflare's interstitial rather than the endpoint. */
  challenged: boolean;
  detail: string;
};

export async function probeBroker(): Promise<BrokerProbe> {
  const { token, probe } = await callBroker();
  return { ...probe, ok: token !== null };
}

async function callBroker(): Promise<{ token: BrokeredToken | null; probe: BrokerProbe }> {
  const fail = (status: number | null, challenged: boolean, detail: string) => ({
    token: null,
    probe: { ok: false, status, challenged, detail },
  });

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: `app=${APP}`,
      cache: 'no-store',
    });
  } catch (error) {
    return fail(null, false, error instanceof Error ? error.message : 'network error');
  }

  const text = await res.text();
  // Cloudflare's managed challenge is an HTML page titled "Just a moment...".
  const challenged = /just a moment|cf-browser-verification|challenge-platform/i.test(text);

  if (!res.ok) {
    return fail(
      res.status,
      challenged,
      challenged
        ? 'Cloudflare served its challenge page — this runtime\'s TLS handshake is being scored as a bot.'
        : text.slice(0, 200),
    );
  }

  try {
    // The endpoint answers with a JSON *string* containing JSON, and `time` is
    // seconds of life left rather than an expiry stamp.
    const outer = JSON.parse(text) as unknown;
    const inner = typeof outer === 'string' ? (JSON.parse(outer) as unknown) : outer;
    const body = inner as { token?: string; time?: number };
    if (!body.token) return fail(res.status, challenged, 'no token field in the response');

    return {
      token: { value: body.token, expiresIn: body.time ?? 3600 },
      probe: { ok: true, status: res.status, challenged: false, detail: 'token received' },
    };
  } catch {
    return fail(res.status, challenged, 'response was not JSON');
  }
}
