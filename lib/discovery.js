/**
 * High-level match discovery over the core client.
 *
 * I/O-free: you pass an `isKnown` predicate and the library decides which matches
 * are new. It never touches disk — the CLI backs `isKnown` with files on disk, a
 * game could back it with a database.
 */

/**
 * Walk the analysis list newest-first, yielding each match the consumer doesn't
 * already have, and STOP at the first already-seen match.
 *
 * Assumption: your known set is a contiguous newest-first prefix. The scan stops
 * as soon as `isKnown()` reports true, so a match deleted from the MIDDLE of your
 * local history will NOT be re-fetched. Yields the raw analysis-list entry
 * (matchId + whatever metadata the endpoint returns) — NOT a fetched .mat. Fetch
 * the .mat yourself with `client.fetchMat(matchId)` if you want it.
 *
 * @param {{ matches: () => AsyncIterable<{ matchId: number }> }} client
 *        A createClient() result (or anything with a compatible `matches()`).
 * @param {object} opts
 * @param {(matchId: number) => boolean} opts.isKnown
 * @yields {{ matchId: number }} the list entry for each new match.
 */
async function* findNewMatches(client, { isKnown } = {}) {
  if (typeof isKnown !== 'function') {
    throw new TypeError('findNewMatches requires an isKnown(matchId) predicate');
  }
  for await (const analysis of client.matches()) {
    if (isKnown(analysis.matchId)) return;
    yield analysis;
  }
}

/**
 * Walk the ENTIRE analysis list and yield every match the consumer doesn't have.
 *
 * Unlike findNewMatches, this does NOT early-stop — so it resumes an interrupted
 * bulk download and re-fetches gaps left by earlier failures (e.g. a match that
 * 500'd mid-history). The cost is scanning every list page each run; the benefit
 * is a correct, complete sync. I/O-free, same contract as findNewMatches.
 *
 * @param {{ matches: () => AsyncIterable<{ matchId: number }> }} client
 * @param {object} opts
 * @param {(matchId: number) => boolean} opts.isKnown
 * @yields {{ matchId: number }} the list entry for each match not yet known.
 */
async function* findMissingMatches(client, { isKnown } = {}) {
  if (typeof isKnown !== 'function') {
    throw new TypeError('findMissingMatches requires an isKnown(matchId) predicate');
  }
  for await (const analysis of client.matches()) {
    if (!isKnown(analysis.matchId)) yield analysis;
  }
}

module.exports = { findNewMatches, findMissingMatches };
