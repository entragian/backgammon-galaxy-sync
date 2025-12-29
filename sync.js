/**
 * Backgammon Galaxy Match Sync
 *
 * Opens a browser for you to sign in, then automatically downloads all new matches.
 *
 * Setup: npm install playwright
 * Usage: node sync.js
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const CONFIG = {
  outputDir: path.join(__dirname, 'matches'),
  delay: 200,
  baseUrl: 'play.backgammongalaxy.com',
  loginUrl: 'https://play.backgammongalaxy.com/',
  sessionFile: path.join(__dirname, '.session.json')
};

const delay = ms => new Promise(r => setTimeout(r, ms));

function httpsGet(hostname, urlPath, headers, retries = 3) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path: urlPath,
      method: 'GET',
      headers: {
        ...headers,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        if (res.statusCode >= 500 && retries > 0) {
          // Server error - retry
          await delay(1000);
          resolve(httpsGet(hostname, urlPath, headers, retries - 1));
        } else if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', async err => {
      if (retries > 0) {
        await delay(1000);
        resolve(httpsGet(hostname, urlPath, headers, retries - 1));
      } else {
        reject(new Error(`Network error: ${err.message}`));
      }
    });
    req.end();
  });
}

async function fetchJSON(urlPath, token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  };
  const data = await httpsGet(CONFIG.baseUrl, urlPath, headers);
  return JSON.parse(data);
}

async function fetchMatchText(matchId, token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.galaxy+mat'
  };
  return await httpsGet(CONFIG.baseUrl, `/api/matches/${matchId}`, headers);
}

function getExistingMatchIds(outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    return new Set();
  }
  const files = fs.readdirSync(outputDir);
  const ids = new Set();
  for (const file of files) {
    const match = file.match(/^match(\d+)\.txt$/);
    if (match) {
      ids.add(parseInt(match[1], 10));
    }
  }
  return ids;
}

async function waitForLogin(context) {
  console.log('\n   Waiting for you to sign in...');
  console.log('   (Script continues automatically once logged in)\n');

  while (true) {
    const cookies = await context.cookies();
    const tokenCookie = cookies.find(c => c.name === 'bg-app-token');
    if (tokenCookie) {
      return tokenCookie.value;
    }
    await delay(1000);
  }
}

async function downloadMatches(token) {
  console.log('\n[2/3] Fetching match list...');

  const existingIds = getExistingMatchIds(CONFIG.outputDir);
  console.log(`     ${existingIds.size} matches already downloaded`);

  const firstPage = await fetchJSON('/stats/api/v2/analyses/list/1', token);

  if (!firstPage.userName) {
    throw new Error('Could not fetch user data. Token may be invalid.');
  }

  const totalPages = firstPage.totalPages;
  const userName = firstPage.userName;

  console.log(`     User: ${userName}`);
  console.log(`     Total pages available: ${totalPages}`);

  const newMatchIds = [];
  let page = 1;

  while (page <= totalPages) {
    const data = await fetchJSON(`/stats/api/v2/analyses/list/${page}`, token);
    const pageNewIds = data.analyses
      .map(a => a.matchId)
      .filter(id => !existingIds.has(id));

    newMatchIds.push(...pageNewIds);
    process.stdout.write(`\r     Scanning page ${page}/${totalPages} (${newMatchIds.length} new matches found)`);

    if (pageNewIds.length === 0) {
      // No new matches on this page - all subsequent pages are older
      console.log(' - stopping (no new matches on page)');
      break;
    }

    page++;
    await delay(CONFIG.delay);
  }

  if (page > totalPages) {
    console.log();
  }

  console.log(`\n     Already saved: ${existingIds.size} | New: ${newMatchIds.length}`);

  if (newMatchIds.length === 0) {
    console.log('\n');
    console.log('========================================');
    console.log('            ALL UP TO DATE!');
    console.log('========================================');
    console.log(`  Total matches saved:     ${existingIds.size}`);
    console.log('========================================');
    console.log(`\nMatches folder: ${CONFIG.outputDir}`);
    console.log('\nTo import into ExtremeGammon:');
    console.log('  File > Import > Select .txt files\n');
    return;
  }

  console.log(`\n[3/3] Downloading ${newMatchIds.length} new matches...`);
  const startTime = Date.now();
  let downloaded = 0;
  let errors = 0;

  for (const matchId of newMatchIds) {
    try {
      const matchText = await fetchMatchText(matchId, token);
      const filePath = path.join(CONFIG.outputDir, `match${matchId}.txt`);
      fs.writeFileSync(filePath, matchText);
      downloaded++;

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = downloaded / elapsed;
      const remaining = newMatchIds.length - downloaded;
      const eta = Math.round(remaining / rate);

      process.stdout.write(`\r     ${downloaded}/${newMatchIds.length} (${errors} errors) - ETA: ${eta}s   `);
    } catch (err) {
      errors++;
      console.error(`\n     Failed match ${matchId}: ${err.message}`);
    }

    await delay(CONFIG.delay);
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const totalMatches = existingIds.size + downloaded;

  console.log('\n');
  console.log('========================================');
  console.log('            SYNC COMPLETE!');
  console.log('========================================');
  console.log(`  New matches downloaded:  ${downloaded}`);
  console.log(`  Total matches saved:     ${totalMatches}`);
  if (errors > 0) {
    console.log(`  Failed downloads:        ${errors}`);
  }
  console.log(`  Time:                    ${totalTime}s`);
  console.log('========================================');
  console.log(`\nMatches folder: ${CONFIG.outputDir}`);
  console.log('\nTo import into ExtremeGammon:');
  console.log('  File > Import > Select .txt files\n');

  // Open the matches folder
  if (downloaded > 0) {
    exec(`explorer "${CONFIG.outputDir}"`);
  }
}

async function launchBrowser() {
  // Try Edge first, fall back to default Chromium
  try {
    return await chromium.launch({
      headless: false,
      channel: 'msedge'
    });
  } catch {
    console.log('     Edge not found, using Chromium...');
    return await chromium.launch({ headless: false });
  }
}

async function getTokenFromSession() {
  // Try to use saved session
  if (!fs.existsSync(CONFIG.sessionFile)) {
    return null;
  }

  try {
    const session = JSON.parse(fs.readFileSync(CONFIG.sessionFile, 'utf8'));
    const tokenCookie = session.cookies?.find(c => c.name === 'bg-app-token');
    if (tokenCookie) {
      // Check if token is expired (cookies have expires field in seconds)
      const expiresAt = tokenCookie.expires * 1000;
      if (expiresAt > Date.now()) {
        return tokenCookie.value;
      }
    }
  } catch {
    // Invalid session file, ignore
  }
  return null;
}

async function getTokenViaBrowser() {
  console.log('[1/3] Opening browser...');

  let browser;
  try {
    browser = await launchBrowser();

    // Load saved session if exists
    const contextOptions = {};
    if (fs.existsSync(CONFIG.sessionFile)) {
      contextOptions.storageState = CONFIG.sessionFile;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });

    const cookies = await context.cookies();
    let token = cookies.find(c => c.name === 'bg-app-token')?.value;

    if (!token) {
      token = await waitForLogin(context);
    }

    // Save session for next time
    await context.storageState({ path: CONFIG.sessionFile });
    console.log('     Logged in! (session saved)');

    await browser.close();
    console.log('     Browser closed.');

    return token;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function main() {
  console.log('Backgammon Galaxy Match Sync');
  console.log('============================\n');

  try {
    // Try saved session first
    let token = await getTokenFromSession();

    if (token) {
      console.log('[1/3] Using saved session...');
    } else {
      token = await getTokenViaBrowser();
    }

    await delay(500);
    await downloadMatches(token);
  } catch (err) {
    // If API fails with saved token, might be expired - try browser login
    if (err.message.includes('401') || err.message.includes('invalid')) {
      console.log('\n     Session expired, re-authenticating...\n');
      fs.unlinkSync(CONFIG.sessionFile);
      const token = await getTokenViaBrowser();
      await delay(500);
      await downloadMatches(token);
    } else {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  }
}

main();
