/**
 * One-time bootstrap for the server's Spotify identity.
 *
 * shufflele reads playlists with a single long-lived user token rather than
 * per-guest OAuth: Spotify stopped serving playlist tracks to Client
 * Credentials tokens, and Development Mode caps user logins at 25 manually
 * registered accounts, which is incompatible with scan-the-QR guests.
 *
 * Run `npm run spotify:auth`, log in as the account the server should act as,
 * and paste the printed SPOTIFY_REFRESH_TOKEN into .env.local (and Vercel).
 * Refresh tokens from this flow do not expire on a timer — re-run this only if
 * the app is revoked, the client secret is rotated, or SCOPES change below.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = 8888;
// Loopback literal IP — Spotify's HTTPS-only rule exempts 127.0.0.1, but not
// the hostname "localhost". This exact string must be a redirect URI on the app.
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// Read-only, and only what ingestPlaylist needs. Widening this list invalidates
// nothing, but the existing refresh token keeps the OLD scopes — re-run then.
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative'].join(' ');

/** Minimal .env reader; .env.local wins, matching Next's precedence. */
function loadEnv() {
  for (const file of ['.env', '.env.local']) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || line.trim().startsWith('#')) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

function openBrowser(url) {
  // Not `cmd /c start`: cmd splits the URL on its `&` query separators and the
  // browser receives a truncated request. rundll32 takes the URL verbatim.
  if (process.platform === 'win32') {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true });
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true });
  } else {
    spawn('xdg-open', [url], { detached: true });
  }
}

function page(title, detail) {
  return `<!doctype html><meta charset="utf-8"><title>shufflele</title>
<style>body{font:16px/1.5 system-ui;margin:15vh auto;max-width:34rem;padding:0 1.5rem}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#555}</style>
<h1>${title}</h1><p>${detail}</p>`;
}

async function exchange(code, clientId, clientSecret) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(`${body.error ?? res.status}: ${body.error_description ?? ''}`);
  return body;
}

function main() {
  loadEnv();
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env or .env.local.');
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl =
    'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      // Force the consent screen so re-runs reliably mint a fresh token.
      show_dialog: 'true',
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const finish = (status, html, exitCode) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      server.close();
      // Give the socket a beat to flush before the process exits.
      setTimeout(() => process.exit(exitCode), 250);
    };

    const error = url.searchParams.get('error');
    if (error) {
      console.error(`\nSpotify denied the request: ${error}`);
      finish(400, page('Authorization failed', `Spotify said: <code>${error}</code>`), 1);
      return;
    }

    if (url.searchParams.get('state') !== state) {
      console.error('\nState mismatch — ignoring this callback.');
      finish(400, page('Authorization failed', 'State mismatch.'), 1);
      return;
    }

    try {
      const token = await exchange(url.searchParams.get('code'), clientId, clientSecret);
      console.log('\nAdd this to .env.local and to your Vercel environment:\n');
      console.log(`SPOTIFY_REFRESH_TOKEN=${token.refresh_token}\n`);
      console.log(`(scopes granted: ${token.scope})`);
      finish(200, page('Connected', 'Refresh token printed in your terminal. You can close this tab.'), 0);
    } catch (err) {
      console.error(`\nToken exchange failed — ${err.message}`);
      finish(500, page('Authorization failed', 'Token exchange failed; see terminal.'), 1);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Listening on ${REDIRECT_URI}`);
    console.log('Opening Spotify for you to log in. If nothing opens, visit:\n');
    console.log(`${authUrl}\n`);
    openBrowser(authUrl);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is busy. Close whatever is using it and re-run.`);
      process.exit(1);
    }
    throw err;
  });
}

main();
