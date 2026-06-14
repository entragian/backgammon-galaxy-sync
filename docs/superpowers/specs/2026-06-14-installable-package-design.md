# Design: make Backgammon Galaxy Sync an installable package

_Date: 2026-06-14_

## Context / problem

The project was a single-purpose CLI. A prior refactor had already split the internals into
a browser-free core (`lib/client.js`, takes an injected `getToken`) and one auth
implementation (`lib/browser-auth.js`, Playwright), but the **packaging** didn't expose that:
`main` pointed at the CLI, the reusable pieces were only reachable via deep `lib/*` paths, and
Playwright was a hard dependency every consumer paid for.

Goal: a properly packaged library — a lightweight core anyone can `require` (bringing their
own token), an **optional** browser-auth add-on, and a clean two-level API — with the existing
CLI kept as the worked example. First intended consumer is a data-analysis tool that ingests
`.mat` directly, so **no `.mat` parser is in scope**.

## Decisions

- **One package, core + optional add-on.** Keep the existing data/auth split; expose it.
- **Playwright = optional peer dependency** (`peerDependenciesMeta.playwright.optional`).
  npm won't auto-install it; the core stays lightweight. The auth module lazy-loads it and
  throws an actionable "run `npm i playwright`" error if absent.
- **Subpath `exports`** enforce the boundary: `.` → `index.js` (core, no Playwright),
  `./auth` → `lib/browser-auth.js`. No `./parser` (an export is a promise; a stub is a broken
  one — `lib/parser.js` deleted).
- **Two API levels.** Low: `createClient` → `{ getProfile, matches, fetchMat }`. High:
  `findNewMatches(client, { isKnown })`, an **I/O-free** async generator that walks newest-first
  and stops at the first already-seen match. It **yields discovery only** (list metadata, not
  fetched `.mat`); consumers opt into downloads via `client.fetchMat(id)`.
- **Robustness by layer.** 429 + `Retry-After` handling lives in the shared client (every
  consumer benefits); atomic writes (temp + rename) live in the CLI where the filesystem is.
- **Ship types** (`.d.ts` generated from existing JSDoc via `tsc`, emit-only) and a rewritten
  README.

## Auth boundary

The client's only contact with auth is `getToken({ forceRefresh? }) => Promise<string>`.
Bring-your-own-token consumers pass a one-liner; the browser add-on (`createBrowserAuth`)
returns a compatible `getToken`. The core never imports Playwright.

## Early-stop assumption (documented public behavior)

`findNewMatches` assumes the known set is a contiguous newest-first prefix. It stops at the
first already-seen match, so a match deleted from the *middle* of local history is not
re-fetched. Full re-scan = iterate `client.matches()` directly.

## Open data question

The exact per-match list-metadata fields (date / opponent / result / rating?) are unconfirmed
— no captured response exists in the repo and the code only reads `matchId`. `matches()` /
`findNewMatches` yield the whole entry, so whatever exists is exposed. To settle the
"analyze from list metadata, parse zero `.mat`" bet, capture one real
`/stats/api/v2/analyses/list/1` response on the first authenticated run and document the
fields.

## Verification

- `npm run smoke` — offline: client, 401 refresh, 429 + `RateLimitError`, `findNewMatches`
  early-stop, atomic-write consumer, export surface.
- `npm run build:types` — emits declarations cleanly.
- Light-core import without Playwright; `/auth` loads lazily; missing-peer error path.
- End-to-end real run (`npm i` + `npm i playwright` + `node sync.js`) — manual; also the place
  to capture the metadata sample.

Implementation tracked in plan: `~/.claude/plans/okan-it-out-then-silly-taco.md`.

## Addendum (2026-06-14): resync correctness + concurrency

A real test-drive (1526 matches) revealed that the CLI's early-stop discovery was wrong for
the bulk case: downloads go newest-first, ~18 matches 500'd mid-history (leaving gaps), and on
restart `findNewMatches` saw the newest match on disk and stopped immediately → false "ALL UP
TO DATE", stranding the gaps and any un-downloaded older matches.

Changes:
- Added `findMissingMatches(client, { isKnown })` — full-scan, no early stop — alongside
  `findNewMatches` (kept as the fast incremental option). The CLI now uses `findMissingMatches`,
  so re-runs resume interruptions and backfill failed-download gaps.
- CLI downloads concurrently via a bounded pool (`CONFIG.concurrency = 4`); downloading stays in
  the consumer (library remains I/O-free).
- Failed match ids are collected and reported at the end with a "re-run to retry" hint
  (chosen over a persistent skip-list).

