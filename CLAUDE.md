# CLAUDE.md

## Project Overview

Node.js tool that downloads Backgammon Galaxy match history for ExtremeGammon analysis.

## How It Works

1. **Browser auth**: Opens Edge via Playwright, user signs in, script extracts `bg-app-token` cookie
2. **Match discovery**: Fetches `/stats/api/v2/analyses/list/{page}` to get all match IDs
3. **Skip existing**: Checks `./matches` for `match{id}.txt` files
4. **Download**: Fetches new matches from `/api/matches/{id}` with `Accept: application/vnd.galaxy+mat` header
5. **Save**: Writes each match as `match{id}.txt`

## Key API Details

- `Accept: application/json` → returns JSON metadata
- `Accept: application/vnd.galaxy+mat` → returns ExtremeGammon-compatible text format

## File Structure

```
sync.js         # Main script
matches/        # Downloaded match files
package.json
```

## Modification Notes

- **Rate limiting**: 200ms delay between requests prevents API throttling
- **File naming**: `match{id}.txt` pattern is how existing downloads are detected
- **Browser fallback**: Tries Edge first, falls back to Chromium
