# Backgammon Galaxy Match Sync

Download your match history from [Backgammon Galaxy](https://play.backgammongalaxy.com) for analysis in ExtremeGammon.

## Quick Start

1. **First time only**: Double-click `SETUP.bat`
   - Installs Node.js if needed
   - Downloads dependencies

2. **To sync matches**: Double-click `Sync Matches.bat`
   - Opens browser for login (first time only)
   - Downloads new matches automatically
   - Opens the matches folder when done

## What It Does

- Opens Edge browser, you sign in once
- Saves your session (no login needed next time)
- Downloads only NEW matches (skips ones you already have)
- Saves each match as a `.txt` file ready for ExtremeGammon

## Importing to ExtremeGammon

1. Open ExtremeGammon
2. File > Import
3. Select the `.txt` files from the `matches` folder

## Sharing With Family

To share this with family members:

1. Copy the entire `xggammonHelper` folder to their computer
2. Have them double-click `SETUP.bat` (one time)
3. Then they can use `Sync Matches.bat` anytime

**Requirements:**
- Windows 10/11
- Microsoft Edge (pre-installed on Windows)
- Node.js (SETUP.bat will prompt to install)

## Troubleshooting

**"Node.js is not installed"**
- Go to https://nodejs.org
- Download and install the LTS version
- Run SETUP.bat again

**"Session expired"**
- The script will automatically open the browser for re-login

**Browser doesn't open**
- Make sure Microsoft Edge is installed
- The script falls back to Chromium if Edge isn't available
