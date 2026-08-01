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
matches/              # Downloaded matches. Each run writes into its own dated batch
                      #   folder (matches/YYYY-MM-DD/, -2/-3 on collision); the flat
                      #   match{id}.txt at the root are the pre-batching downloads.
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
   the `JWT_ACCESS` cookie is still valid; otherwise opens Edge (falls back to
   Chromium) via Playwright, waits for the user to sign in, and persists the session.
2. **Discovery** (`[2/3]`): client paginates `/stats/api/v2/analyses/list/{page}`;
   `findMissingMatches` does a **full newest-first scan** yielding every matchId not
   already on disk (full scan, not early-stop, so interrupted runs resume and past
   failures are retried). "On disk" means anywhere under `matches/` — see the
   recursive-scan note below.
3. **Download** (`[3/3]`): once discovery proves something is missing (and not
   before), the run claims a dated batch folder `matches/YYYY-MM-DD/` — `-2`, `-3`
   for extra runs the same day — then fetches each missing match's `.mat` text
   concurrently (pool of `CONFIG.concurrency`, default 4) from `/api/matches/{id}`,
   writing each atomically as `match{id}.txt` into that folder (temp file + rename
   so a crash never leaves a half-written file). A batch folder left empty because
   every fetch failed is removed again.
4. **Import status**: scans the whole `matches/` tree and reports how many `.txt`
   ExtremeGammon has already imported, how many are waiting, and how many are
   unimportable stubs. Then the footer prints, and on Windows the run opens the
   batch folder it just filled (not the flat root) if anything was downloaded.

`discovery.js` also exports `findNewMatches` (early-stop variant) for consumers that
want to fetch only matches newer than their newest known one.

## Key API Details

- **Two hosts.** Sign-in is the Flutter app at `https://www.backgammongalaxy.com/play`,
  which sets the `JWT_ACCESS` cookie; every data call goes to `api.backgammongalaxy.com`
  with that cookie's value as `Authorization: Bearer`. `LOGIN_URL` and `API_HOST` in
  `sync.js` are deliberately separate constants for this reason.
- **The old host is a trap.** `play.backgammongalaxy.com` still answers **200 with the
  SPA's HTML shell** instead of 404, so pointing the client there fails as a confusing
  `JSON.parse` error inside `listPage` rather than an HTTP error. Cookie auth alone
  returns 401 on the API host — the bearer header is required.
- Paths themselves are unchanged across the rewrite: `/stats/api/v2/analyses/list/{page}`
  and `/api/matches/{id}`. `scripts/smoke.js` pins host, paths, and cookie name
  (`testEndpoints`) because drift in the cookie name causes a *silent infinite wait*
  in `waitForLogin`, not an error.
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
- **Existence detection is a recursive whole-tree walk**: `getExistingMatchIds` walks
  every folder under `matches/` (`walkMatchDir`, an iterative stack walk with a
  `realpathSync` cycle guard). If it ever scans only the root again, the next run
  silently re-downloads every match sitting in a batch folder. The walk is
  hand-rolled because `readdirSync(dir, { recursive: true, withFileTypes: true })`
  needs Node >= 20.12 and the README advertises a Node 18 floor. Keep the filename
  regexes **anchored** (`/^match(\d+)\.txt$/i`) — that's what excludes a leftover
  `match123.txt.tmp` from `atomicWrite`.
- **Batch folders**: `createBatchDir` uses **non-recursive** `mkdirSync` + `EEXIST`
  as an atomic claim (`existsSync`-then-`mkdir` is racy if `Sync Matches.bat` is
  double-clicked, and `recursive: true` would succeed on an existing folder and
  defeat the `-2`/`-3` suffix loop). `todayStamp` uses **local** date parts, never
  `toISOString()`. `downloadNewMatches` takes an injected `resolveTargetDir`
  callback defaulting to the identity `() => outputDir`, so batching stays in the
  consumer's `main()` and the plain code path is unchanged.
- **`.xg` pairing is per-folder**: ExtremeGammon writes `match{id}.xg` next to each
  `.txt` it imports, and `scanImportStatus` pairs them **within one directory
  only**. A single global set of `.xg` basenames would wrongly mark
  `matches/match6.txt` imported because `matches/2026-08-01/match6.xg` exists.
  Only unpaired `.txt` are read; `hasDiceRolls` then splits genuine
  waiting-to-import files from resign-before-first-roll stubs XG can never import.
- **`printFooter` moved out of `downloadNewMatches` into `main()`**: the footer says
  "File > Import", so it has to print *after* the import-status readout, and it
  points at the batch folder rather than the flat root.
- **Browser fallback**: Tries Edge (`channel: 'msedge'`) first, falls back to Chromium.
- **Playwright is an optional peer dependency**: the core works without it; only
  `browser-auth` (and therefore the CLI's sign-in) needs it. `SETUP.bat` installs it explicitly.
- **The core stays pure**: keep filesystem/console/browser out of `lib/client.js`
  and `lib/discovery.js`; put new I/O in the consumer.
