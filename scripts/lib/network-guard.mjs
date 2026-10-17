/**
 * Preloaded into the Alibi server process under test (`node --import`).
 *
 * Wraps globalThis.fetch so the application can only reach loopback addresses
 * (the local provider mocks). Tavily's hard-coded endpoint is redirected to the
 * local mock. Every other outbound request is refused and logged, so a
 * misconfiguration can never turn into a paid or external API call.
 *
 * This does not modify Alibi's source; it only constrains the process it runs in.
 */
import { appendFileSync } from 'node:fs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const tavilyMock = process.env.QA_TAVILY_MOCK_URL;
const logFile = process.env.QA_GUARD_LOG;
const original = globalThis.fetch;

function urlOf(input) {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

globalThis.fetch = async function qaGuardedFetch(input, init) {
  const url = urlOf(input);
  if (LOOPBACK.has(url.hostname)) return original(input, init);
  if (url.hostname === 'api.tavily.com' && tavilyMock) {
    return original(`${tavilyMock}${url.pathname}${url.search}`, init);
  }
  const entry = { at: new Date().toISOString(), host: url.hostname, path: url.pathname };
  if (logFile) {
    try {
      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      // logging must never make the guard fail open
    }
  }
  throw new TypeError(`QA network guard: outbound request to ${url.hostname} blocked`);
};

process.stdout.write('[qa-network-guard] active\n');
