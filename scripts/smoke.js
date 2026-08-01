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
const {
  downloadNewMatches,
  getExistingMatchIds,
  todayStamp,
  createBatchDir,
  scanImportStatus,
  printImportStatus,
  hasDiceRolls,
} = require('../sync');

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
  assert.ok(last.url.startsWith('https://api.backgammongalaxy.com/'), 'fetchMat hits https base url');

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

// A .mat body with real dice rolls, and the resign-before-first-roll stub that
// ExtremeGammon can never import. Shared by the import-status tests.
const MAT_WITH_ROLLS = [
  '; [Site "BackgammonGalaxy"]',
  '; [Player 1 Elo "1,00/0"]',
  '; [EventTime "02.44"]',
  '; [CubeLimit "1024"]',
  '',
  '4 point match',
  '',
  ' Game 1',
  '  1)                             53: 8/3 6/3',
  '  2) 54: 24/20 20/15             62: 24/18 24/22',
  '',
].join('\n');

const MAT_STUB = [
  '; [Site "BackgammonGalaxy"]',
  '; [Player 2 Elo "0,00/0"]',
  '; [EventTime "01.01"]',
  '; [CubeLimit "1024"]',
  '',
  '2 point match',
  '',
  ' Game 1',
  '  1)                              Losses 1 point',
  '      Wins 1 point',
  '',
].join('\n');

// A match id already on disk in ANY folder must never be re-downloaded, so the
// existence scan has to walk the whole tree — not just the root.
function testRecursiveScan() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    const nested = path.join(tmp, '2026-08-01');
    const deeper = path.join(nested, 'archive');
    fs.mkdirSync(deeper, { recursive: true });

    fs.writeFileSync(path.join(tmp, 'match1.txt'), 'root');
    fs.writeFileSync(path.join(nested, 'match2.txt'), 'batch');
    fs.writeFileSync(path.join(deeper, 'match3.txt'), 'doubly nested');
    fs.writeFileSync(path.join(nested, 'match4.txt.tmp'), 'half-written');
    fs.writeFileSync(path.join(nested, 'match5.xg'), 'xg only');

    const ids = getExistingMatchIds(tmp);
    assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3], 'scan walks root + nested + doubly-nested, ignoring .tmp and .xg');

    console.log('  ok  scan: existing ids found anywhere in the matches tree');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testScanCreatesRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    const root = path.join(tmp, 'matches');
    const ids = getExistingMatchIds(root);

    assert.equal(ids.size, 0, 'missing matches root yields an empty id set');
    assert.ok(fs.existsSync(root), 'missing matches root is created');
    assert.deepEqual(fs.readdirSync(root), [], 'created root is empty — no batch folder made just by scanning');

    console.log('  ok  scan: missing matches root is created empty');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testBatchNaming() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    // Local components, never toISOString(): 20:30 local on Aug 1 is Aug 2 in UTC
    // for anyone east of Greenwich, and Jul 31 for anyone far enough west.
    assert.equal(todayStamp(new Date(2026, 7, 1, 20, 30)), '2026-08-01', 'stamp uses local date parts');
    assert.equal(todayStamp(new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'stamp zero-pads month and day');

    assert.equal(createBatchDir(tmp, '2026-08-01'), path.join(tmp, '2026-08-01'), 'first run of the day gets the bare stamp');
    assert.equal(createBatchDir(tmp, '2026-08-01'), path.join(tmp, '2026-08-01-2'), 'second run of the day gets -2');
    assert.equal(createBatchDir(tmp, '2026-08-01'), path.join(tmp, '2026-08-01-3'), 'third run of the day gets -3');

    // A pre-existing suffixed folder must be stepped over, not reused.
    fs.mkdirSync(path.join(tmp, '2026-09-09-2'));
    assert.equal(createBatchDir(tmp, '2026-09-09'), path.join(tmp, '2026-09-09'), 'bare stamp still claimed when only -2 exists');
    assert.equal(createBatchDir(tmp, '2026-09-09'), path.join(tmp, '2026-09-09-3'), 'suffix loop skips a pre-existing -2');

    console.log('  ok  batch: local-date stamp with -2/-3 collision suffixes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The load-bearing test: new files land in the batch folder, ids already sitting
// in a batch folder are not re-downloaded, and the flat root stays untouched.
async function testBatchDownload() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    const oldBatch = path.join(tmp, '2026-07-30');
    fs.mkdirSync(oldBatch);
    fs.writeFileSync(path.join(oldBatch, 'match98.txt'), 'already have this one');

    const existingIds = getExistingMatchIds(tmp);
    assert.ok(existingIds.has(98), 'match98 found inside an existing batch folder');

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

    let resolverCalls = 0;
    const result = await downloadNewMatches({
      client: fakeClient,
      outputDir: tmp,
      existingIds,
      log: () => {},
      resolveTargetDir: () => {
        resolverCalls++;
        return createBatchDir(tmp, '2026-08-01');
      },
    });

    assert.equal(resolverCalls, 1, 'target dir resolved exactly once per run');
    assert.equal(result.targetDir, path.join(tmp, '2026-08-01'), 'result reports the batch folder');
    assert.deepEqual(result.missingIds, [100, 99, 97], 'id in a batch folder is not re-downloaded');
    assert.equal(result.downloaded, 3, 'downloaded the three genuinely missing matches');
    for (const id of [100, 99, 97]) {
      assert.ok(fs.existsSync(path.join(result.targetDir, `match${id}.txt`)), `match${id} written into the batch folder`);
    }
    assert.deepEqual(
      fs.readdirSync(tmp).filter(f => /^match\d+\.txt$/i.test(f)),
      [],
      'flat root gains no new match files'
    );
    assert.equal(
      fs.readdirSync(result.targetDir).filter(f => f.endsWith('.tmp')).length,
      0,
      'atomic write leaves no .tmp files in the batch folder'
    );

    console.log('  ok  batch: new matches land in the batch folder, root untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testUpToDateCreatesNoFolder() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    for (const id of [100, 99, 98, 97]) {
      fs.writeFileSync(path.join(tmp, `match${id}.txt`), `; match ${id}\n`);
    }
    const existingIds = getExistingMatchIds(tmp);

    const fakeClient = {
      async getProfile() {
        return { userName: 'tester', totalPages: 2 };
      },
      async *matches() {
        for (const id of [100, 99, 98, 97]) yield { matchId: id };
      },
      async fetchMat() {
        throw new Error('should not fetch when up to date');
      },
    };

    const result = await downloadNewMatches({
      client: fakeClient,
      outputDir: tmp,
      existingIds,
      log: () => {},
      resolveTargetDir: () => {
        throw new Error('resolveTargetDir must not run when nothing is missing');
      },
    });

    assert.deepEqual(result.missingIds, [], 'nothing missing');
    assert.equal(result.targetDir, null, 'no batch folder reported for an up-to-date run');
    const dirs = fs.readdirSync(tmp, { withFileTypes: true }).filter(e => e.isDirectory());
    assert.deepEqual(dirs, [], 'an up-to-date run creates no folders at all');

    console.log('  ok  batch: up-to-date run resolves no target and creates no folder');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testEmptyBatchReaped() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  // downloadNewMatches reports per-match failures straight to console.error,
  // ignoring the injected log — stub it so the suite output stays readable.
  const realError = console.error;
  console.error = () => {};
  try {
    const existingIds = getExistingMatchIds(tmp);

    const fakeClient = {
      async getProfile() {
        return { userName: 'tester', totalPages: 1 };
      },
      async *matches() {
        for (const id of [100, 99]) yield { matchId: id };
      },
      async fetchMat() {
        throw new Error('boom');
      },
    };

    const result = await downloadNewMatches({
      client: fakeClient,
      outputDir: tmp,
      existingIds,
      log: () => {},
      resolveTargetDir: () => createBatchDir(tmp, '2026-08-01'),
    });

    assert.equal(result.downloaded, 0, 'every fetch failed');
    assert.deepEqual(result.failedIds, [100, 99], 'both ids reported as failed');
    assert.equal(fs.existsSync(path.join(tmp, '2026-08-01')), false, 'empty batch folder is reaped');
    assert.deepEqual(fs.readdirSync(tmp), [], 'nothing left behind after a fully failed run');

    console.log('  ok  batch: folder left empty by failed fetches is removed');
  } finally {
    console.error = realError;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testImportStatus() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    const batch = path.join(tmp, '2026-08-01');
    fs.mkdirSync(batch);

    // Imported: .txt with its .xg alongside, in the same folder.
    fs.writeFileSync(path.join(tmp, 'match1.txt'), MAT_WITH_ROLLS);
    fs.writeFileSync(path.join(tmp, 'match1.xg'), 'xg');
    fs.writeFileSync(path.join(batch, 'match5.txt'), MAT_WITH_ROLLS);
    fs.writeFileSync(path.join(batch, 'match5.xg'), 'xg');

    // Not imported.
    fs.writeFileSync(path.join(tmp, 'match2.txt'), MAT_WITH_ROLLS);
    // Unimportable stub — no dice rolls, so not outstanding work.
    fs.writeFileSync(path.join(tmp, 'match3.txt'), MAT_STUB);
    // A leftover atomic-write temp must be invisible to the scan.
    fs.writeFileSync(path.join(tmp, 'match4.txt.tmp'), MAT_WITH_ROLLS);
    // The cross-folder trap: root/match6.txt is NOT imported even though a
    // match6.xg exists in the batch folder. A global .xg set gets this wrong.
    fs.writeFileSync(path.join(tmp, 'match6.txt'), MAT_WITH_ROLLS);
    fs.writeFileSync(path.join(batch, 'match6.xg'), 'xg for a different folder');

    const status = scanImportStatus(tmp);
    const needs = status.needsImport.map(f => path.relative(tmp, f)).sort();

    assert.equal(status.imported, 2, 'only same-folder .txt/.xg pairs count as imported');
    assert.deepEqual(
      needs,
      ['match2.txt', 'match6.txt'].sort(),
      '.xg pairing is per-folder: root/match6.txt is not imported by a batch-folder match6.xg'
    );
    assert.deepEqual(status.stubs.map(f => path.basename(f)), ['match3.txt'], 'roll-less stub is split out from needs-import');
    assert.deepEqual(status.unreadable, [], 'nothing unreadable');

    console.log('  ok  status: .xg pairing is per-folder, stubs split from needs-import');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testHasDiceRolls() {
  assert.equal(hasDiceRolls(MAT_WITH_ROLLS), true, 'a real match body has dice rolls');
  assert.equal(hasDiceRolls('  5) 64:'), true, 'a dance (roll with no move after it) counts');
  assert.equal(hasDiceRolls('  1)                             53: 8/3 6/3'), true, 'second player opening counts');
  assert.equal(hasDiceRolls(MAT_STUB), false, 'resign-before-first-roll stub has no dice rolls');
  assert.equal(hasDiceRolls('; [EventTime "02.44"]'), false, 'timestamps are not dice rolls');
  assert.equal(hasDiceRolls('; [Player 2 Elo "0,00/0"]'), false, 'Elo values are not dice rolls');
  assert.equal(hasDiceRolls('; [CubeLimit "1024"]'), false, 'CubeLimit is not a dice roll');
  assert.equal(hasDiceRolls('  1)                              Losses 1 point'), false, 'a resignation line has no roll');

  console.log('  ok  status: hasDiceRolls separates real matches from stubs');
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

// The walk deliberately skips hidden/system folders and stops at MAX_WALK_DEPTH.
// That is fine; doing it SILENTLY is not, because an unscanned folder means every
// match inside it gets downloaded again. Pin the reporting, not just the skipping.
function testWalkReportsSkipped() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    fs.writeFileSync(path.join(tmp, 'match1.txt'), 'visible');
    const hidden = path.join(tmp, '.archive');
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, 'match2.txt'), 'hidden away');

    const skipped = [];
    const ids = getExistingMatchIds(tmp, skipped);

    assert.ok(ids.has(1), 'visible matches are still found');
    assert.ok(!ids.has(2), 'hidden folders are not descended into');
    assert.strictEqual(skipped.length, 1, 'the skipped folder is reported, not dropped silently');
    assert.ok(skipped[0].endsWith('.archive'), 'the report names the folder that was skipped');

    console.log('  ok  scan: skipped folders are reported rather than silently dropped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The import readout is the part of this feature the user actually reads, so assert
// the rendered text — counts, per-folder grouping, and the stub explanation that
// keeps 20 permanently-unimportable files from reading as outstanding work.
function testImportStatusOutput() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    const dice = '  1) 31: 8/5 6/5                 42: 13/9 13/11\n';
    const stub = '  1)  Losses 1 point              Wins 1 point\n';
    fs.writeFileSync(path.join(tmp, 'match1.txt'), dice);
    fs.writeFileSync(path.join(tmp, 'match1.xg'), 'imported');
    fs.writeFileSync(path.join(tmp, 'match2.txt'), stub);
    const batch = path.join(tmp, '2026-08-01');
    fs.mkdirSync(batch);
    fs.writeFileSync(path.join(batch, 'match3.txt'), dice);
    fs.writeFileSync(path.join(batch, 'match4.txt'), dice);

    const out = [];
    printImportStatus(scanImportStatus(tmp), tmp, m => out.push(m));
    const text = out.join('\n');

    assert.ok(/Imported into XG:\s+1\b/.test(text), 'reports the imported count');
    assert.ok(/Not yet imported:\s+2\b/.test(text), 'reports the needs-import count');
    assert.ok(/Unimportable stubs:\s+1\b/.test(text), 'reports the stub count');
    assert.ok(/2026-08-01\s+-\s+2 match/.test(text), 'groups unimported matches by folder');
    assert.ok(/resigned before the first/.test(text), 'explains stubs so they do not read as work');
    assert.ok(!text.includes('(matches root)'), 'a root with no unimported matches is not listed');

    console.log('  ok  status: printed report groups by folder and explains stubs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The per-file try/catch exists so a file ExtremeGammon holds open mid-import can
// never fail an otherwise successful sync. Fault-inject rather than assert it empty.
function testUnreadableIsReported() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-smoke-'));
  try {
    const locked = path.join(tmp, 'match1.txt');
    fs.writeFileSync(locked, '  1) 31: 8/5 6/5\n');

    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(locked)) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return realReadFileSync(p, ...rest);
    };

    let status;
    try {
      status = scanImportStatus(tmp);
    } finally {
      fs.readFileSync = realReadFileSync;
    }

    assert.strictEqual(status.unreadable.length, 1, 'a locked .txt is reported as unreadable');
    assert.strictEqual(status.needsImport.length, 0, 'it is not counted as needing import');
    assert.strictEqual(status.stubs.length, 0, 'it is not misclassified as a stub');

    console.log('  ok  status: a file held open is reported, never throws');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Regression guard for the mid-2026 Galaxy migration: the API moved to
// api.backgammongalaxy.com and the auth cookie was renamed bg-app-token ->
// JWT_ACCESS. The old host is especially nasty to debug because it still answers
// 200 — with the SPA's HTML shell — so a stale base URL surfaces as a JSON.parse
// error deep inside listPage rather than as a 404. Pin the host and paths here.
async function testEndpoints() {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, accept: opts.headers.Accept });
    return response(200, JSON.stringify({ userName: 'tester', totalPages: 1, analyses: [] }));
  };
  // Deliberately no baseUrl — this asserts the shipped DEFAULT_BASE_URL.
  const client = createClient({ getToken: async () => 'TKN', fetchImpl, requestDelayMs: 0 });

  await client.getProfile();
  assert.equal(
    seen[0].url,
    'https://api.backgammongalaxy.com/stats/api/v2/analyses/list/1',
    'default base URL points at the live API host'
  );

  await client.fetchMat(123);
  assert.equal(
    seen[1].url,
    'https://api.backgammongalaxy.com/api/matches/123',
    '.mat download hits /api/matches/{id} on the API host'
  );
  assert.equal(
    seen[1].accept,
    'application/vnd.galaxy+mat',
    '.mat request still negotiates the mat media type'
  );

  assert.equal(
    require('../lib/browser-auth').TOKEN_COOKIE,
    'JWT_ACCESS',
    'auth cookie name matches the cookie the site actually issues'
  );

  console.log('  ok  endpoints: API host, list/mat paths, and auth cookie name');
}

(async () => {
  console.log('Running offline smoke...');
  await testClient();
  await test401Refresh();
  await test429RateLimit();
  await testDiscovery();
  await testConsumer();
  testRecursiveScan();
  testScanCreatesRoot();
  testBatchNaming();
  await testBatchDownload();
  await testUpToDateCreatesNoFolder();
  await testEmptyBatchReaped();
  testImportStatus();
  testHasDiceRolls();
  testWalkReportsSkipped();
  testImportStatusOutput();
  testUnreadableIsReported();
  await testEndpoints();
  testExports();
  console.log('\nAll smoke checks passed.');
})().catch(err => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
