/**
 * Backgammon Galaxy — core library entry point.
 *
 * Pure data layer: requiring this NEVER pulls in Playwright. Bring your own token
 * via createClient({ getToken }), or use the optional browser sign-in add-on:
 *
 *   const { createClient, findNewMatches } = require('backgammon-galaxy');
 *   const { createBrowserAuth }            = require('backgammon-galaxy/auth'); // needs playwright
 */

const {
  createClient,
  AuthError,
  HttpError,
  NetworkError,
  RateLimitError,
} = require('./lib/client');
const { findNewMatches } = require('./lib/discovery');

module.exports = {
  createClient,
  findNewMatches,
  AuthError,
  HttpError,
  NetworkError,
  RateLimitError,
};
