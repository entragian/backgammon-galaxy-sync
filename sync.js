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
const { createClient, findNewMatches } = require('./index');
const { createBrowserAuth } = require('./lib/browser-auth');

const BASE_URL = 'play.backgammongalaxy.com';

const CONFIG = {
  outputDir: path.join(__dirname, 'matches'),
  baseUrl: BASE_URL,
  loginUrl: `https://${BASE_URL}/`,
  sessionFile: path.join(__dirname, '.session.json'),
};

function getExistingMatchIds(outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    return new Set();
  }
  const ids = new Set();
  for (const file of fs.readdirSync(outputDir)) {
    const m = file.match(/^match(\d+)\.txt$/);
    if (m) ids.add(parseInt(m[1], 10));
  }
  return ids;
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

/**
 * Discover and download new matches. Pure consumer logic over an injected
 * client, so it can be exercised offline with a fake client + temp dir.
 *
 * @returns {Promise<{ downloaded: number, errors: number, total: number, newMatchIds: number[] }>}
 */
async function downloadNewMatches({ client, outputDir, existingIds, log = console.log }) {
  log('\n[2/3] Fetching match list...');
  log(`     ${existingIds.size} matches already downloaded`);

  const profile = await client.getProfile();
  log(`     User: ${profile.userName}`);
  log(`     Total pages available: ${profile.totalPages}`);

  // Newest-first scan via the library's discovery helper: it yields new matches
  // and stops at the first one we already have (everything older is on disk).
  const newMatchIds = [];
  for await (const analysis of findNewMatches(client, { isKnown: id => existingIds.has(id) })) {
    newMatchIds.push(analysis.matchId);
    process.stdout.write(`\r     Scanning... (${newMatchIds.length} new matches found)`);
  }
  log('');
  log(`     Already saved: ${existingIds.size} | New: ${newMatchIds.length}`);

  if (newMatchIds.length === 0) {
    printBanner(log, 'ALL UP TO DATE!', [
      `  Total matches saved:     ${existingIds.size}`,
    ]);
    printFooter(outputDir, log);
    return { downloaded: 0, errors: 0, total: existingIds.size, newMatchIds };
  }

  log(`\n[3/3] Downloading ${newMatchIds.length} new matches...`);
  const startTime = Date.now();
  let downloaded = 0;
  let errors = 0;

  for (const matchId of newMatchIds) {
    try {
      const matchText = await client.fetchMat(matchId);
      atomicWrite(path.join(outputDir, `match${matchId}.txt`), matchText);
      downloaded++;

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = downloaded / elapsed;
      const remaining = newMatchIds.length - downloaded;
      const eta = Math.round(remaining / rate);
      process.stdout.write(
        `\r     ${downloaded}/${newMatchIds.length} (${errors} errors) - ETA: ${eta}s   `
      );
    } catch (err) {
      errors++;
      console.error(`\n     Failed match ${matchId}: ${err.message}`);
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const total = existingIds.size + downloaded;

  const summary = [
    `  New matches downloaded:  ${downloaded}`,
    `  Total matches saved:     ${total}`,
  ];
  if (errors > 0) summary.push(`  Failed downloads:        ${errors}`);
  summary.push(`  Time:                    ${totalTime}s`);
  printBanner(log, 'SYNC COMPLETE!', summary);
  printFooter(outputDir, log);

  return { downloaded, errors, total, newMatchIds };
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

    const existingIds = getExistingMatchIds(CONFIG.outputDir);
    const result = await downloadNewMatches({
      client,
      outputDir: CONFIG.outputDir,
      existingIds,
    });

    // Open the matches folder if we actually downloaded something (Windows).
    if (result.downloaded > 0) {
      exec(`explorer "${CONFIG.outputDir}"`);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadNewMatches, getExistingMatchIds, printFooter };
