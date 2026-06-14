# Backgammon Galaxy Sync

A small library **and** CLI for [Backgammon Galaxy](https://play.backgammongalaxy.com):

- **Library** — a browser-free API client you can drop into your own Node app to pull match
  history and `.mat` data. Bring your own auth token, or use the optional browser sign-in
  add-on.
- **CLI** — `node sync.js` downloads your new matches as `.txt` files for ExtremeGammon. It's
  the worked example of the library.

---

## Library usage

```bash
npm install backgammon-galaxy-sync
```

The core is pure data — installing it pulls **no browser engine**. Playwright is an optional
peer dependency, needed only if you use the browser sign-in helper:

```bash
npm install playwright   # only if you need browser sign-in (see "Auth" below)
```

### Quick start (bring your own token)

```js
const { createClient, findNewMatches } = require('backgammon-galaxy-sync');

const client = createClient({ getToken: async () => MY_BG_APP_TOKEN });

const profile = await client.getProfile();          // { userName, totalPages }

// Stream new matches, stopping at the first you already have:
for await (const analysis of findNewMatches(client, { isKnown: id => haveItLocally(id) })) {
  const mat = await client.fetchMat(analysis.matchId);   // ExtremeGammon-compatible text
  // ...do whatever you want with `analysis` (list metadata) and `mat`
}
```

### Auth: the data/auth split

The client only ever calls `getToken({ forceRefresh? }) => Promise<string>`. That single
function is the entire boundary — the core never knows *how* the token was obtained. Two ways
to satisfy it:

```js
// A) You already have a bg-app-token (no browser, no Playwright):
const client = createClient({ getToken: async () => MY_TOKEN });

// B) Human sign-in via the optional add-on (needs `npm i playwright`):
const { createBrowserAuth } = require('backgammon-galaxy-sync/auth');
const { getToken } = createBrowserAuth({
  sessionFile: './.session.json',
  loginUrl: 'https://play.backgammongalaxy.com/',
});
const client = createClient({ getToken });
```

If you import `/auth` without Playwright installed, the sign-in call throws a clear
*"Browser sign-in needs Playwright … npm i playwright"* — not a cryptic `MODULE_NOT_FOUND`.

### API reference

**`require('backgammon-galaxy-sync')`** (core — no Playwright)

| Export | Description |
| --- | --- |
| `createClient({ getToken, baseUrl?, fetchImpl?, requestDelayMs? })` | Returns `{ getProfile, matches, fetchMat }`. Retries 5xx/network errors, honors `Retry-After` on 429, and forces one token refresh on 401. |
| `findNewMatches(client, { isKnown })` | Async generator. Walks the match list newest-first and yields each **new** list entry, stopping at the first `isKnown(matchId)` hit. I/O-free; yields metadata, not fetched `.mat`. |
| `AuthError`, `HttpError`, `NetworkError`, `RateLimitError` | Typed errors you can branch on (each carries `.status` where relevant). |

**`client` methods**

| Method | Returns |
| --- | --- |
| `getProfile()` | `{ userName, totalPages }` |
| `matches()` | Async generator of raw analysis-list entries (newest-first, all pages) |
| `fetchMat(matchId)` | The `.mat` text for one match |

**`require('backgammon-galaxy-sync/auth')`** (needs Playwright)

| Export | Description |
| --- | --- |
| `createBrowserAuth({ sessionFile, loginUrl, log? })` | Returns `{ getToken }`. Reuses a saved session, opens Edge (falls back to Chromium) for sign-in, and persists the session. |

> **Note on `findNewMatches` early-stop.** It assumes your known set is a contiguous
> newest-first prefix: it stops at the first already-seen match, so a match deleted from the
> *middle* of your local history won't be re-fetched. If you need a full re-scan, iterate
> `client.matches()` directly.

> **Note on list metadata.** `matches()` / `findNewMatches` yield the raw list entry, so any
> fields the API returns per match are exposed untouched. The exact set of fields isn't yet
> documented here — capture one real `/stats/api/v2/analyses/list/1` response to see what's
> available (`matchId` is always present).

TypeScript types ship with the package (generated from JSDoc).

---

## CLI usage (download matches for ExtremeGammon)

### Quick start (Windows, end users)

1. **First time only**: double-click `SETUP.bat` (installs Node.js if needed, downloads
   dependencies).
2. **To sync**: double-click `Sync Matches.bat` — opens a browser for login the first time,
   downloads only new matches, and opens the `matches` folder when done.

### From a terminal

```bash
npm install
npm install playwright   # the CLI signs in via a browser
node sync.js
```

The CLI saves your session (no repeat login), downloads only matches you don't already have,
and writes each as `matchN.txt` via an atomic write (no half-written files on Ctrl-C).

### Importing to ExtremeGammon

1. Open ExtremeGammon → **File > Import**
2. Select the `.txt` files from the `matches` folder

---

## Requirements

- Node.js 18+ (for global `fetch`)
- For the CLI / browser sign-in: Microsoft Edge (pre-installed on Windows; falls back to
  Chromium) and Playwright

## Troubleshooting

- **"Browser sign-in needs Playwright"** — run `npm i playwright`.
- **"Session expired"** — the client forces one re-auth automatically; the CLI re-opens the
  browser if needed.
- **Browser doesn't open** — ensure Microsoft Edge is installed (the CLI falls back to
  Chromium).

## Development

```bash
npm run smoke         # offline test suite — no network, no browser, no creds
npm run build:types   # regenerate type declarations from JSDoc
```
