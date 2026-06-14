# CLAUDE.md

## Project Overview

Node.js tool that downloads Backgammon Galaxy match history for ExtremeGammon
analysis. Shipped as two things from one repo: a **core library** (a Galaxy API
client, no browser dependency) and a **CLI** (`sync.js`) that is the worked
example of consuming it.

## Architecture

The code is split along a deliberate seam: a pure, I/O-free data core that never
imports Playwright, an optional browser-auth add-on that does, and a CLI consumer
that owns all filesystem/console I/O.

```
index.js              # Public core entry point (barrel). Requiring it NEVER pulls in Playwright.
lib/client.js         # API client: HTTP transport + auth/retry state machine + typed errors.
lib/discovery.js      # I/O-free match-discovery policy (findNewMatches / findMissingMatches).
lib/browser-auth.js   # OPTIONAL add-on — the only Playwright importer. Exposes getToken.
sync.js               # CLI consumer: wires auth into the client, owns all disk + console I/O.
scripts/smoke.js      # Offline test suite (hand-rolled assert harness, dependency-injected).
types/                # Generated .d.ts (npm run build:types).
matches/              # Downloaded match files (match{id}.txt). Created on first run.
SETUP.bat             # Windows double-click setup (installs deps + Playwright).
Sync Matches.bat      # Windows double-click run.
```

The core never knows *how* a token is obtained: `createClient({ getToken })`
takes an injected token source. The CLI passes `browser-auth`'s `getToken`; a
different consumer (e.g. a game holding its own token) can skip `browser-auth`
entirely. This is why `require('backgammon-galaxy')` stays Playwright-free and
`require('backgammon-galaxy/auth')` is the opt-in browser piece.

## How It Works (the CLI flow)

1. **Auth** (`[1/3]`): `browser-auth` reuses a saved session (`.session.json`) if
   the `bg-app-token` cookie is still valid; otherwise opens Edge (falls back to
   Chromium) via Playwright, waits for the user to sign in, and persists the session.
2. **Discovery** (`[2/3]`): client paginates `/stats/api/v2/analyses/list/{page}`;
   `findMissingMatches` does a **full newest-first scan** yielding every matchId not
   already on disk (full scan, not early-stop, so interrupted runs resume and past
   failures are retried).
3. **Download** (`[3/3]`): fetches each missing match's `.mat` text concurrently
   (pool of `CONFIG.concurrency`, default 4) from `/api/matches/{id}`, writing each
   atomically as `match{id}.txt` (temp file + rename so a crash never leaves a
   half-written file).
4. On Windows, opens the `matches/` folder if anything was downloaded.

`discovery.js` also exports `findNewMatches` (early-stop variant) for consumers that
want to fetch only matches newer than their newest known one.

## Key API Details

- `Accept: application/json` → returns JSON metadata
- `Accept: application/vnd.galaxy+mat` → returns ExtremeGammon-compatible text format
- Client centralizes resilience: 401 → one forced token refresh; 429 → honor
  `Retry-After` (else backoff); 5xx / network error → retry with backoff
  (`MAX_RETRIES`, `RETRY_BACKOFF_MS` in `lib/client.js`).

## Modification Notes

- **Tests**: `npm test` (alias of `npm run smoke`) runs the offline suite. It uses
  dependency injection (`fetchImpl`, fake clients, `getToken`, temp dirs) so it
  needs no network or browser. Keep it green.
- **Rate limiting**: `DEFAULT_REQUEST_DELAY_MS` (200ms) spaces consecutive requests.
- **File naming**: `match{id}.txt` is how existing downloads are detected — don't change it lightly.
- **Browser fallback**: Tries Edge (`channel: 'msedge'`) first, falls back to Chromium.
- **Playwright is an optional peer dependency**: the core works without it; only
  `browser-auth` (and therefore the CLI's sign-in) needs it. `SETUP.bat` installs it explicitly.
- **The core stays pure**: keep filesystem/console/browser out of `lib/client.js`
  and `lib/discovery.js`; put new I/O in the consumer.
