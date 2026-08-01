/**
 * Browser-based auth for Backgammon Galaxy.
 *
 * This is the ONLY module that imports Playwright. It encapsulates the whole
 * "get me a JWT_ACCESS token" dance — saved-session reuse, Edge/Chromium launch,
 * waiting for the human to sign in, and persisting the session — and exposes it
 * as a single injectable `getToken` function for the client.
 *
 * A different consumer (e.g. a game that already holds a token) can skip this
 * module entirely and pass its own getToken to createClient().
 */

const fs = require('fs');
// Playwright is require()'d lazily inside launchBrowser (not at module load) so
// that importing this module — and anything that depends on it, like the sync
// consumer — never drags in the browser unless a real login actually happens.

const { setTimeout: delay } = require('timers/promises');

// Galaxy's mid-2026 rewrite renamed the auth cookie (was 'bg-app-token') and moved
// it to the www host. Its value is a JWT sent as a bearer token to the api host.
// Getting this name wrong is invisible: sign-in succeeds, the cookie simply never
// appears under the expected name, and waitForLogin polls forever.
const TOKEN_COOKIE = 'JWT_ACCESS';

/** Find the auth cookie in a cookies array, or undefined. Name-only match, so the
 *  cookie's host (www) can differ from the API host without extra plumbing. */
function findTokenCookie(cookies) {
  return cookies?.find(c => c.name === TOKEN_COOKIE);
}

/**
 * @param {object} opts
 * @param {string} opts.sessionFile   Path to the Playwright storageState JSON.
 * @param {string} opts.loginUrl      Page to open for sign-in.
 * @param {(msg: string) => void} [opts.log]   Optional progress sink (keeps
 *        console out of the module by default; the CLI passes console.log).
 * @returns {{ getToken: (o?: {forceRefresh?: boolean}) => Promise<string> }}
 */
function createBrowserAuth({ sessionFile, loginUrl, log = () => {} }) {
  let cachedToken = null;

  async function getToken({ forceRefresh = false } = {}) {
    if (forceRefresh) {
      cachedToken = null;
      log('\n     Session expired, re-authenticating...\n');
      // Drop the stale session so the browser forces a fresh login.
      try {
        fs.unlinkSync(sessionFile);
      } catch {
        // No session file to remove — fine.
      }
    } else {
      if (cachedToken) return cachedToken;
      const fromSession = readTokenFromSession(sessionFile);
      if (fromSession) {
        cachedToken = fromSession;
        log('     Using saved session...');
        return cachedToken;
      }
    }

    cachedToken = await getTokenViaBrowser({ sessionFile, loginUrl, log });
    return cachedToken;
  }

  return { getToken };
}

/** Read a still-valid token straight from the saved session, or null. */
function readTokenFromSession(sessionFile) {
  if (!fs.existsSync(sessionFile)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const tokenCookie = findTokenCookie(session.cookies);
    if (tokenCookie && tokenCookie.expires * 1000 > Date.now()) {
      return tokenCookie.value;
    }
  } catch {
    // Invalid session file — ignore and fall back to the browser.
  }
  return null;
}

// Playwright is an OPTIONAL peer dependency — only this module needs it, and only
// when a real sign-in happens. Surface a clear, actionable error if it's absent
// instead of a raw MODULE_NOT_FOUND.
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Browser sign-in needs Playwright, which is an optional dependency. ' +
          'Install it with:  npm i playwright'
      );
    }
    throw err;
  }
}

async function launchBrowser(log) {
  const { chromium } = loadPlaywright();
  // Try Edge first, fall back to default Chromium.
  try {
    return await chromium.launch({ headless: false, channel: 'msedge' });
  } catch {
    log('     Edge not found, using Chromium...');
    return await chromium.launch({ headless: false });
  }
}

async function waitForLogin(context, log) {
  log('\n   Waiting for you to sign in...');
  log('   (Continues automatically once logged in)\n');

  while (true) {
    const cookies = await context.cookies();
    const tokenCookie = findTokenCookie(cookies);
    if (tokenCookie) return tokenCookie.value;
    await delay(1000);
  }
}

async function getTokenViaBrowser({ sessionFile, loginUrl, log }) {
  log('     Opening browser...');

  let browser;
  try {
    browser = await launchBrowser(log);

    const contextOptions = {};
    if (fs.existsSync(sessionFile)) {
      contextOptions.storageState = sessionFile;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'networkidle' });

    const cookies = await context.cookies();
    let token = findTokenCookie(cookies)?.value;
    if (!token) {
      token = await waitForLogin(context, log);
    }

    await context.storageState({ path: sessionFile });
    log('     Logged in! (session saved)');

    return token;
  } finally {
    if (browser) await browser.close();
  }
}

// TOKEN_COOKIE is exported so the smoke suite can pin the name — it is the one
// constant whose drift produces a silent infinite wait rather than an error.
module.exports = { createBrowserAuth, TOKEN_COOKIE };
