#!/usr/bin/env node
/**
 * Backgammon Galaxy Match Sync (CLI consumer).
 *
 * The worked example of the library: discovery-only core + this consumer adding
 * the .mat download and all I/O. It wires browser auth into the API client and
 * owns everything filesystem/console — reading existing match files, writing new
 * ones, and all output. The core returns data; this file decides what to print
 * and where to save.
 *
 * Setup: npm install && npm i playwright
 * Usage: node sync.js
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { createClient, findMissingMatches } = require('./index');
const { createBrowserAuth } = require('./lib/browser-auth');

// The API and the sign-in page live on DIFFERENT hosts since Galaxy's mid-2026
// rewrite: you log in to the Flutter app on www, but every data call goes to api.
// The old play.backgammongalaxy.com still answers 200 with the SPA's HTML shell
// rather than 404, so pointing at it fails as a confusing JSON.parse error.
const API_HOST = 'api.backgammongalaxy.com';
const LOGIN_URL = 'https://www.backgammongalaxy.com/play';

const CONFIG = {
  outputDir: path.join(__dirname, 'matches'),
  baseUrl: API_HOST,
  loginUrl: LOGIN_URL,
  sessionFile: path.join(__dirname, '.session.json'),
  concurrency: 4,
};

// Matches live in dated batch folders under matches/ (plus the flat pre-batching
// files at the root), so every scan has to see the WHOLE tree. Hand-rolled rather
// than readdirSync(recursive:true, withFileTypes:true) — that combination needs
// Node >= 20.12 and README advertises a Node 18 floor. Iterative (no recursion),
// with a realpath cycle guard so OneDrive/Dropbox junctions and symlinks can't
// loop forever. readdirSync errors are deliberately NOT swallowed: a silently
// skipped folder means silently re-downloading every match inside it.
const MAX_WALK_DEPTH = 8;

// `skipped` collects directories the walk deliberately did NOT descend into. It is
// an out-param rather than a return-shape change so callers that don't care stay
// unchanged — but callers that do care can report it, because an unscanned folder
// means silently re-downloading every match inside it. Nothing here is allowed to
// drop a folder without recording it.
function walkMatchDir(rootDir, skipped = []) {
  const files = [];
  const visited = new Set();
  const stack = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();

    let key = dir;
    try {
      key = fs.realpathSync.native(dir);
    } catch {
      // Unresolvable path (e.g. a broken junction) — fall back to the literal
      // path as the cycle key and let readdirSync report the real problem.
    }
    if (visited.has(key)) continue;
    visited.add(key);

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      const full = path.join(dir, name);

      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        // Dirent.isDirectory() is false for links/junctions on some platforms;
        // resolve before deciding rather than betting on Dirent semantics.
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
      }

      if (isDir) {
        // Noise directories (.git, $RECYCLE.BIN) and anything past the depth cap
        // are skipped — but RECORDED, never dropped silently.
        if (name.startsWith('.') || name.startsWith('$') || depth >= MAX_WALK_DEPTH) {
          skipped.push(full);
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
      } else {
        // Files are pushed unfiltered; the anchored match{id}.txt regex downstream
        // is what decides relevance, and no dotfile can satisfy it anyway.
        files.push(full);
      }
    }
  }

  return files;
}

// An id found ANYWHERE under matches/ counts as already downloaded — root or any
// batch folder. The regex stays anchored on purpose: `\.txt$` is what keeps a
// leftover match123.txt.tmp from atomicWrite out of the known set.
function getExistingMatchIds(outputDir, skipped = []) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    return new Set();
  }
  const ids = new Set();
  for (const file of walkMatchDir(outputDir, skipped)) {
    const m = path.basename(file).match(/^match(\d+)\.txt$/i);
    if (m) ids.add(parseInt(m[1], 10));
  }
  return ids;
}

// LOCAL date parts, never toISOString() — a 20:00 run in UTC-5 would otherwise
// name the folder for tomorrow. `now` is injectable so tests need no clock freeze.
function todayStamp(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Claim a fresh batch folder: YYYY-MM-DD, then -2, -3, ... for extra runs the
// same day. mkdirSync is deliberately NON-recursive — that makes creation the
// atomic claim (existsSync-then-mkdir is TOCTOU-racy if `Sync Matches.bat` is
// double-clicked, and recursive:true would happily succeed on an existing folder
// and defeat the suffix loop entirely).
function createBatchDir(rootDir, stamp = todayStamp()) {
  // Make the export self-sufficient: main() happens to create the root first via
  // getExistingMatchIds, but relying on that ordering would hand a public caller a
  // raw ENOENT instead of the useful message below. Recursive here is fine — it is
  // only the per-batch mkdir that must stay non-recursive to be an atomic claim.
  fs.mkdirSync(rootDir, { recursive: true });
  for (let n = 1; n <= 99; n++) {
    const dir = path.join(rootDir, n === 1 ? stamp : `${stamp}-${n}`);
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not create a batch folder in ${rootDir}: ${stamp} and -2..-99 all exist`);
}

function printFooter(outputDir, log) {
  log(`\nMatches folder: ${outputDir}`);
  log('\nTo import into ExtremeGammon:');
  log('  File > Import > Select .txt files\n');
}

// Write via a temp file + rename so a crash or Ctrl-C mid-download never leaves a
// half-written matchN.txt that the next run would mistake for a complete file
// (rename is atomic on the same volume).
function atomicWrite(finalPath, data) {
  const tmp = `${finalPath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, finalPath);
}

// Both end-of-run summaries share the same boxed layout — only the title and
// the stat lines differ.
function printBanner(log, title, lines) {
  const rule = '========================================';
  log('\n');
  log(rule);
  log(`            ${title}`);
  log(rule);
  for (const line of lines) log(line);
  log(rule);
}

// A .mat body with at least one dice roll (` 1) 53: 8/3 6/3`). The 20 unpaired
// .txt in the corpus are 402-447 byte stubs where a player resigned before the
// first roll — ExtremeGammon cannot import those, and never will. The [1-6][1-6]
// token form (rather than \d\d:) rejects `02:`-style timestamps if a non-.mat
// body ever lands in the folder.
function hasDiceRolls(text) {
  return /(?:^|\s)[1-6][1-6]:(?=\s|$)/m.test(text);
}

/**
 * Which downloaded matches ExtremeGammon has already imported.
 *
 * XG writes a `match{id}.xg` next to each `match{id}.txt` it imports, so the
 * pairing is the import signal. Pairing is done PER DIRECTORY: a single global
 * set of .xg basenames would wrongly mark `matches/match6.txt` imported because
 * `matches/2026-08-01/match6.xg` exists.
 *
 * @returns {{ imported:number, needsImport:string[], stubs:string[], unreadable:string[] }}
 */
function scanImportStatus(rootDir) {
  const status = { imported: 0, needsImport: [], stubs: [], unreadable: [] };
  if (!fs.existsSync(rootDir)) return status;

  const files = walkMatchDir(rootDir);

  const xgByDir = new Map();
  for (const file of files) {
    const m = path.basename(file).match(/^match(\d+)\.xg$/i);
    if (!m) continue;
    const dir = path.dirname(file);
    let ids = xgByDir.get(dir);
    if (!ids) {
      ids = new Set();
      xgByDir.set(dir, ids);
    }
    ids.add(m[1]);
  }

  for (const file of files) {
    const m = path.basename(file).match(/^match(\d+)\.txt$/i);
    if (!m) continue;
    const siblings = xgByDir.get(path.dirname(file));
    if (siblings && siblings.has(m[1])) {
      status.imported++;
      continue;
    }
    // Only unpaired files are read (20 today, not 1,465). Per-file try/catch —
    // XG can hold a file open mid-import, and a status readout must never fail
    // an otherwise successful sync.
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      status.unreadable.push(file);
      continue;
    }
    if (hasDiceRolls(text)) status.needsImport.push(file);
    else status.stubs.push(file);
  }

  return status;
}

function printImportStatus(status, rootDir, log) {
  const lines = [
    `  Imported into XG:        ${status.imported}`,
    `  Not yet imported:        ${status.needsImport.length}`,
  ];
  if (status.stubs.length > 0) lines.push(`  Unimportable stubs:      ${status.stubs.length}`);
  if (status.unreadable.length > 0) lines.push(`  Unreadable:              ${status.unreadable.length}`);
  printBanner(log, 'IMPORT STATUS', lines);

  if (status.needsImport.length > 0) {
    const byFolder = new Map();
    for (const file of status.needsImport) {
      const rel = path.relative(rootDir, path.dirname(file)) || '.';
      byFolder.set(rel, (byFolder.get(rel) || 0) + 1);
    }
    const folders = [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    log('\n  Waiting to be imported (File > Import, then Ctrl+A in the folder):');
    for (const [folder, count] of folders.slice(0, 20)) {
      log(`    ${folder === '.' ? '(matches root)' : folder}  -  ${count} match(es)`);
    }
    if (folders.length > 20) log(`    +${folders.length - 20} more folder(s)`);
  } else {
    log('\n  Every importable match has already been imported into ExtremeGammon.');
  }

  if (status.stubs.length > 0) {
    log(`\n  ${status.stubs.length} file(s) have no dice rolls (a player resigned before the first`);
    log('  roll). ExtremeGammon cannot import those — nothing to do about them.');
  }
  if (status.unreadable.length > 0) {
    log(`\n  ${status.unreadable.length} file(s) could not be read (open in another program?).`);
  }
}

// Run `worker(item)` over `items` with at most `concurrency` in flight. Workers
// pull from a shared cursor; in single-threaded JS the cursor increment and the
// counters the workers touch are race-free.
async function runPool(items, concurrency, worker) {
  let cursor = 0;
  async function loop() {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, loop)
  );
}

/**
 * Sync missing matches: a full newest-first scan for everything not on disk,
 * then download those concurrently. A full scan (not an early-stop) is what makes
 * re-runs resume interrupted downloads and retry past failures. Pure consumer
 * logic over an injected client, so it runs offline with a fake client + temp dir.
 *
 * `resolveTargetDir` decides where this run's files land, and is called ONLY once
 * discovery has proven there is something to download — that laziness is what
 * keeps an up-to-date run from littering matches/ with empty folders. The CLI
 * passes a batch-folder factory; the identity default keeps the plain
 * "write into outputDir" path (and its tests) untouched, and keeps batching out
 * of the I/O-free core.
 *
 * @returns {Promise<{ downloaded:number, errors:number, total:number, missingIds:number[], failedIds:number[], targetDir:string|null }>}
 */
async function downloadNewMatches({
  client,
  outputDir,
  existingIds,
  log = console.log,
  concurrency = 4,
  resolveTargetDir = () => outputDir,
}) {
  log('\n[2/3] Fetching match list...');
  log(`     ${existingIds.size} matches already downloaded`);

  const profile = await client.getProfile();
  log(`     User: ${profile.userName}`);
  log(`     Total pages available: ${profile.totalPages}`);

  // Full newest-first scan: yield every match we don't already have (no early
  // stop), so gaps from past failures and interrupted runs are picked back up.
  const missingIds = [];
  for await (const analysis of findMissingMatches(client, { isKnown: id => existingIds.has(id) })) {
    missingIds.push(analysis.matchId);
    process.stdout.write(`\r     Scanning... (${missingIds.length} to download)`);
  }
  log('');
  log(`     Already saved: ${existingIds.size} | To download: ${missingIds.length}`);

  if (missingIds.length === 0) {
    printBanner(log, 'ALL UP TO DATE!', [
      `  Total matches saved:     ${existingIds.size}`,
    ]);
    return { downloaded: 0, errors: 0, total: existingIds.size, missingIds, failedIds: [], targetDir: null };
  }

  // Only now — discovery says there IS something to download, and nothing has
  // been written yet. Creating the batch folder any earlier leaves empty folders
  // behind on up-to-date runs.
  const targetDir = resolveTargetDir();

  log(`\n[3/3] Downloading ${missingIds.length} matches (${concurrency} at a time)...`);
  const startTime = Date.now();
  let downloaded = 0;
  let errors = 0;
  const failedIds = [];

  await runPool(missingIds, concurrency, async matchId => {
    try {
      const matchText = await client.fetchMat(matchId);
      atomicWrite(path.join(targetDir, `match${matchId}.txt`), matchText);
      downloaded++;
    } catch (err) {
      errors++;
      failedIds.push(matchId);
      console.error(`\n     Failed match ${matchId}: ${err.message}`);
    }
    const done = downloaded + errors;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? Math.round((missingIds.length - done) / rate) : 0;
    process.stdout.write(
      `\r     ${done}/${missingIds.length} (${errors} errors) - ETA: ${eta}s   `
    );
  });

  // Every fetch failed — reap the folder this run claimed so matches/ doesn't
  // collect empty dated husks. The `!== outputDir` guard is load-bearing: with
  // the identity default this would otherwise delete the caller's output dir.
  // Non-recursive rmdir, so a folder that somehow holds files is left alone.
  // path.resolve on both sides: a resolver returning an equivalent-but-differently
  // spelled path (relative vs absolute, trailing separator) must not slip past a
  // guard whose whole job is to protect the caller's directory.
  if (downloaded === 0 && path.resolve(targetDir) !== path.resolve(outputDir)) {
    try {
      fs.rmdirSync(targetDir);
    } catch {
      // Not empty or already gone — nothing worth failing the run over.
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const total = existingIds.size + downloaded;

  const summary = [
    `  Matches downloaded:      ${downloaded}`,
    `  Total matches saved:     ${total}`,
  ];
  if (errors > 0) summary.push(`  Failed downloads:        ${errors}`);
  summary.push(`  Time:                    ${totalTime}s`);
  printBanner(log, 'SYNC COMPLETE!', summary);

  if (failedIds.length > 0) {
    const shown = failedIds.slice(0, 20).join(', ');
    const more = failedIds.length > 20 ? `, +${failedIds.length - 20} more` : '';
    log(`\n  ${failedIds.length} match(es) failed (often transient server 500s):`);
    log(`    ${shown}${more}`);
    log('  Re-run to retry — matches already saved are skipped.');
  }

  return { downloaded, errors, total, missingIds, failedIds, targetDir };
}

async function main() {
  console.log('Backgammon Galaxy Match Sync');
  console.log('============================\n');

  const { getToken } = createBrowserAuth({
    sessionFile: CONFIG.sessionFile,
    loginUrl: CONFIG.loginUrl,
    log: console.log,
  });
  const client = createClient({ getToken, baseUrl: CONFIG.baseUrl });

  try {
    // The consumer owns the [n/3] step sequence; the auth module only reports
    // its own sub-steps (saved session / opening browser / logged in).
    console.log('[1/3] Authenticating...');
    await getToken();

    // A folder the walk couldn't enter is the one way this tool silently
    // re-downloads matches it already has, so say so rather than truncating quietly.
    const skipped = [];
    const existingIds = getExistingMatchIds(CONFIG.outputDir, skipped);
    if (skipped.length > 0) {
      console.log(`\n     NOTE: ${skipped.length} folder(s) under matches/ were not scanned`);
      console.log(`     (hidden/system names, or deeper than ${MAX_WALK_DEPTH} levels):`);
      for (const dir of skipped.slice(0, 5)) {
        console.log(`       ${path.relative(CONFIG.outputDir, dir)}`);
      }
      if (skipped.length > 5) console.log(`       +${skipped.length - 5} more`);
      console.log('     Any matches inside them will be downloaded again.');
    }

    const result = await downloadNewMatches({
      client,
      outputDir: CONFIG.outputDir,
      existingIds,
      concurrency: CONFIG.concurrency,
      // Lazily claim a dated folder for this run's downloads, so the new matches
      // are never mixed in with the thousands already imported.
      resolveTargetDir: () => createBatchDir(CONFIG.outputDir),
    });

    // Point at the batch folder when this run actually produced one — the flat
    // root is precisely the folder the user should NOT be importing from.
    const folder = result.downloaded > 0 && result.targetDir ? result.targetDir : CONFIG.outputDir;

    // Status BEFORE the footer: the footer says "File > Import", so a status
    // that contradicts it must not land two lines later.
    printImportStatus(scanImportStatus(CONFIG.outputDir), CONFIG.outputDir, console.log);
    printFooter(folder, console.log);

    // Open the matches folder if we actually downloaded something (Windows).
    if (result.downloaded > 0) {
      exec(`explorer "${folder}"`);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  downloadNewMatches,
  getExistingMatchIds,
  printFooter,
  todayStamp,
  createBatchDir,
  scanImportStatus,
  printImportStatus,
  hasDiceRolls,
};
