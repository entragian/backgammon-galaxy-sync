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

module.exports = { findNewMatches };
