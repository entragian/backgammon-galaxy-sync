/**
 * Backgammon Galaxy API client (core).
 *
 * Pure data layer: no filesystem, no console, no browser. Every method returns a
 * string or a plain object so any consumer — the sync CLI today, a backgammon
 * game tomorrow — can drive it and decide what to do with the result.
 *
 * Auth is injected via `getToken` so the core never depends on Playwright.
 */

const DEFAULT_BASE_URL = 'play.backgammongalaxy.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const DEFAULT_REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;
// Fallback backoff before a retry (network error, 429 without Retry-After, 5xx).
const RETRY_BACKOFF_MS = 1000;

const MAT_ACCEPT = 'application/vnd.galaxy+mat';
const JSON_ACCEPT = 'application/json';

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

class RateLimitError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'RateLimitError';
    this.status = status;
    this.body = body;
  }
}

const { setTimeout: delay } = require('timers/promises');

/**
 * @param {object} opts
 * @param {(o?: {forceRefresh?: boolean}) => Promise<string>} opts.getToken
 *        Returns a bearer token. Called before every request; should be cheap
 *        (memoized). `forceRefresh: true` must obtain a brand-new token.
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl]   Injectable for tests.
 * @param {number} [opts.requestDelayMs]    Polite pacing before each request.
 */
function createClient({
  getToken,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
} = {}) {
  if (typeof getToken !== 'function') {
    throw new TypeError('createClient requires a getToken function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'createClient requires global fetch (Node 18+) or an explicit fetchImpl'
    );
  }

  // Politeness pacing spaces *consecutive* requests, so the very first request
  // of a run skips it — there's nothing before it to space from.
  let firstRequestDone = false;

  // The single network primitive. Adds auth + accept headers, retries on 5xx and
  // network errors, and forces one token refresh on 401 (preserving the old
  // auto-reauth behavior, now centralized instead of string-matched in main()).
  async function request(
    urlPath,
    accept,
    { retries = MAX_RETRIES, allowRefresh = true } = {}
  ) {
    if (requestDelayMs > 0 && firstRequestDone) await delay(requestDelayMs);
    firstRequestDone = true;

    const token = await getToken();

    let res;
    try {
      res = await fetchImpl(`https://${baseUrl}${urlPath}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });
    } catch (err) {
      if (retries > 0) {
        await delay(RETRY_BACKOFF_MS);
        return request(urlPath, accept, { retries: retries - 1, allowRefresh });
      }
      throw new NetworkError(err.message);
    }

    if (res.status === 401) {
      if (allowRefresh) {
        await getToken({ forceRefresh: true });
        return request(urlPath, accept, { retries, allowRefresh: false });
      }
      throw new AuthError((await safeText(res)) || 'Unauthorized');
    }

    // Throttled: respect Retry-After when the server sends it, else fall back to
    // the same backoff as 5xx. Shared here so every consumer is polite for free.
    if (res.status === 429) {
      if (retries > 0) {
        await delay(retryAfterMs(res) ?? RETRY_BACKOFF_MS);
        return request(urlPath, accept, { retries: retries - 1, allowRefresh });
      }
      throw new RateLimitError(res.status, await safeText(res));
    }

    if (res.status >= 500 && retries > 0) {
      await delay(1000);
      return request(urlPath, accept, { retries: retries - 1, allowRefresh });
    }

    if (res.status >= 400) {
      throw new HttpError(res.status, await safeText(res));
    }

    return res.text();
  }

  async function listPage(page) {
    return JSON.parse(await request(`/stats/api/v2/analyses/list/${page}`, JSON_ACCEPT));
  }

  // Page 1 carries the profile (userName/totalPages) AND the newest analyses, so
  // getProfile() and matches() both need it. Memoize it so a run fetches it once
  // instead of once per caller.
  let firstPagePromise = null;
  function fetchFirstPage() {
    if (!firstPagePromise) firstPagePromise = listPage(1);
    return firstPagePromise;
  }

  async function getProfile() {
    const first = await fetchFirstPage();
    if (!first.userName) {
      throw new Error('Could not fetch user data. Token may be invalid.');
    }
    return { userName: first.userName, totalPages: first.totalPages };
  }

  /**
   * Lazy pagination. Yields one analysis-metadata entry at a time (NOT a fetched
   * .mat). The consumer owns stopping (e.g. break at the first already-saved id)
   * and progress; pacing is handled by `requestDelayMs`.
   */
  async function* matches() {
    let page = 1;
    let totalPages = Infinity;
    while (page <= totalPages) {
      const data = page === 1 ? await fetchFirstPage() : await listPage(page);
      totalPages = data.totalPages ?? page;
      const analyses = data.analyses || [];
      for (const analysis of analyses) yield analysis;
      if (analyses.length === 0) break;
      page++;
    }
  }

  /** GET the ExtremeGammon-compatible .mat text for a single match. */
  async function fetchMat(matchId) {
    return request(`/api/matches/${matchId}`, MAT_ACCEPT);
  }

  return { getProfile, matches, fetchMat };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Parse a Retry-After header into milliseconds, or null if absent/non-numeric. */
function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after');
  if (header == null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

module.exports = { createClient, AuthError, HttpError, NetworkError, RateLimitError };
