/**
 * Offline smoke test — no network, no browser, no real creds.
 *
 * Exercises the core library (createClient / findNewMatches), the CLI consumer
 * logic (sync.js downloadNewMatches), and the public export surface against
 * injected fakes, end-to-end and offline. Run with: npm run smoke
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createClient, findNewMatches, findMissingMatches, RateLimitError } = require('../index');
const { downloadNewMatches, getExistingMatchIds } = require('../sync');

// Minimal fetch Response stand-in. `headers` mimics the WHATWG Headers.get().
const response = (status, body, headers = {}) => ({
  status,
  text: async () => body,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
});

const LIST = {
  1: { userName: 'tester', totalPages: 2, analyses: [{ matchId: 100 }, { matchId: 99 }] },
  2: { userName: 'tester', totalPages: 2, analyses: [{ matchId: 98 }, { matchId: 97 }] },
};

async function testClient() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const list = url.match(/\/analyses\/list\/(\d+)/);
    if (list) return response(200, JSON.stringify(LIST[Number(list[1])] || { totalPages: 2, analyses: [] }));
    const mat = url.match(/\/api\/matches\/(\d+)/);
    if (mat) return response(200, `; [Match ${mat[1]}]\n`);
    return response(404, 'not found');
  };

  const client = createClient({ getToken: async () => 'TKN', fetchImpl, requestDelayMs: 0 });

  const profile = await client.getProfile();
  assert.deepEqual(profile, { userName: 'tester', totalPages: 2 }, 'getProfile');

  const ids = [];
  for await (const a of client.matches()) ids.push(a.matchId);
  assert.deepEqual(ids, [100, 99, 98, 97], 'matches() pages newest-first and stops at totalPages');

  const mat = await client.fetchMat(100);
  assert.ok(mat.includes('Match 100'), 'fetchMat returns body');
  const last = calls[calls.length - 1];
  assert.equal(last.headers.Accept, 'application/vnd.galaxy+mat', 'fetchMat sends .mat Accept');
  assert.equal(last.headers.Authorization, 'Bearer TKN', 'fetchMat sends bearer token');
  assert.ok(last.url.startsWith('https://play.backgammongalaxy.com/'), 'fetchMat hits https base url');

  console.log('  ok  client: getProfile / matches() pagination / fetchMat headers');
}

async function test401Refresh() {
  const tokenCalls = [];
  let served401 = false;
  const fetchImpl = async () => {
    if (!served401) {
      served401 = true;
      return response(401, 'expired');
    }
    return response(200, 'OK-MAT');
  };
  const getToken = async opts => {
    tokenCalls.push(opts);
    return 'TKN';
  };
  const client = createClient({ getToken, fetchImpl, requestDelayMs: 0 });

  const body = await client.fetchMat(5);
  assert.equal(body, 'OK-MAT', '401 then retry returns final body');
  assert.ok(
    tokenCalls.some(c => c && c.forceRefresh === true),
    '401 triggers getToken({ forceRefresh: true })'
  );

  console.log('  ok  client: 401 forces one token refresh and retries');
}

async function test429RateLimit() {
  // 429 with Retry-After: 0, then success → one retry, final body returned.
  let served = 0;
  const fetchImpl = async () => {
    served++;
    if (served === 1) return response(429, 'slow down', { 'retry-after': '0' });
    return response(200, 'OK-MAT');
  };
  const client = createClient({ getToken: async () => 'TKN', fetchImpl, requestDelayMs: 0 });
  assert.equal(await client.fetchMat(7), 'OK-MAT', '429 then retry returns final body');
  assert.equal(served, 2, 'retried exactly once after a single 429');

  // Persistent 429 → retries exhaust → RateLimitError (status 429).
  const always429 = createClient({
    getToken: async () => 'TKN',
    fetchImpl: async () => response(429, 'nope', { 'retry-after': '0' }),
    requestDelayMs: 0,
  });
  await assert.rejects(
    always429.fetchMat(8),
    e => e instanceof RateLimitError && e.status === 429,
    'persistent 429 throws RateLimitError'
  );

  console.log('  ok  client: 429 honors Retry-After, retries, then RateLimitError');
}

async function testDiscovery() {
  const fakeClient = {
    async *matches() {
      for (const id of [100, 99, 98, 97]) yield { matchId: id, date: `d${id}` };
    },
  };

  const seen = new Set([98]);
  const stopped = [];
  for await (const a of findNewMatches(fakeClient, { isKnown: id => seen.has(id) })) {
    stopped.push(a.matchId);
  }
  assert.deepEqual(stopped, [100, 99], 'findNewMatches stops at first already-seen match');

  // Yields the whole list entry (metadata), not just an id.
  const all = [];
  for await (const a of findNewMatches(fakeClient, { isKnown: () => false })) all.push(a);
  assert.equal(all[0].date, 'd100', 'findNewMatches yields full list metadata');

  await assert.rejects(
    (async () => {
      for await (const _ of findNewMatches(fakeClient, {})) void _;
    })(),
    /isKnown/,
    'findNewMatches requires an isKnown predicate'
  );

  // findMissingMatches: full scan, NO early-stop. With only the newest known,
  // findNewMatches yields nothing but findMissingMatches still finds the gaps.
  const newestKnown = id => id === 100;
  const viaNew = [];
  for await (const a of findNewMatches(fakeClient, { isKnown: newestKnown })) viaNew.push(a.matchId);
  assert.deepEqual(viaNew, [], 'findNewMatches stops immediately when the newest is known');

  const viaMissing = [];
  for await (const a of findMissingMatches(fakeClient, { isKnown: newestKnown })) viaMissing.push(a.matchId);
  assert.deepEqual(viaMissing, [99, 98, 97], 'findMissingMatches scans past known to fill gaps');

  await assert.rejects(
    (async () => {
      for await (const _ of findMissingMatches(fakeClient, {})) void _;
    })(),
    /isKnown/,
    'findMissingMatches requires an isKnown predicate'
  );

  console.log('  ok  discovery: early-stop vs full-scan + metadata + guards');
}

async function testConsumer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    fs.writeFileSync(path.join(tmp, 'match98.txt'), 'already have this one');
    const existingIds = getExistingMatchIds(tmp);
    assert.ok(existingIds.has(98), 'existing match98 detected');

    const fakeClient = {
      async getProfile() {
        return { userName: 'tester', totalPages: 2 };
      },
      async *matches() {
        for (const id of [100, 99, 98, 97]) yield { matchId: id };
      },
      async fetchMat(id) {
        return `; match ${id}\n`;
      },
    };

    const result = await downloadNewMatches({
      client: fakeClient,
      outputDir: tmp,
      existingIds,
      log: () => {},
    });

    assert.deepEqual(result.missingIds, [100, 99, 97], 'full scan finds the gap (97), not just the newest');
    assert.equal(result.downloaded, 3, 'downloaded all missing, including the gap');
    assert.equal(result.errors, 0, 'no errors');
    assert.deepEqual(result.failedIds, [], 'no failed ids');
    for (const id of [100, 99, 97]) {
      assert.ok(fs.existsSync(path.join(tmp, `match${id}.txt`)), `wrote match${id}`);
    }
    assert.equal(
      fs.readdirSync(tmp).filter(f => f.endsWith('.tmp')).length,
      0,
      'atomic write leaves no .tmp files behind'
    );

    console.log('  ok  consumer: full resync fills gaps via concurrent pool');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testExports() {
  const core = require('../index');
  for (const name of ['createClient', 'findNewMatches', 'findMissingMatches', 'AuthError', 'HttpError', 'NetworkError', 'RateLimitError']) {
    assert.equal(typeof core[name], 'function', `core exports ${name}`);
  }

  const auth = require('../lib/browser-auth');
  assert.equal(typeof auth.createBrowserAuth, 'function', '/auth exports createBrowserAuth');

  // Requiring the core/CLI/auth must NOT drag Playwright into the module graph.
  const playwrightLoaded = Object.keys(require.cache).some(p =>
    p.includes(`node_modules${path.sep}playwright${path.sep}`)
  );
  assert.equal(playwrightLoaded, false, 'core + /auth load without pulling in Playwright');

  console.log('  ok  exports: core surface (no Playwright) + /auth');
}

(async () => {
  console.log('Running offline smoke...');
  await testClient();
  await test401Refresh();
  await test429RateLimit();
  await testDiscovery();
  await testConsumer();
  testExports();
  console.log('\nAll smoke checks passed.');
})().catch(err => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
