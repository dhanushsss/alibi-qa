/**
 * Sanitizes text before it is written to a report or printed: removes secret-
 * like values, the suite's own fake credentials, and the developer's home path.
 * Plain JS so the node:test reporter can load it without a TypeScript loader.
 */
import { homedir } from 'node:os';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '[REDACTED]'],
  [/\btvly-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\bsk[-_][A-Za-z0-9_-]{20,}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@'],
  [/\b(Authorization:\s*(?:Bearer|token|Basic)\s+)[^\s'"]+/gi, '$1[REDACTED]'],
  [/\b((?:[A-Z0-9_]*_)?(?:API_?KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s'"]{4,})/gi, '$1[REDACTED]'],
  [/qa-mock-[a-z]+-(?:key|token|secret)-[0-9a-f]+/g, '[QA-MOCK-SECRET]'],
  [/qa-host-canary-[0-9a-f]+/g, '[QA-CANARY]'],
  [/qa-fake-[a-z-]+-[0-9a-f]{4}/g, '[QA-CANARY]'],
];

/** @param {unknown} text @returns {string} */
export function sanitize(text) {
  let out = String(text ?? '');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  const home = homedir();
  if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}

/** @template T @param {T} value @returns {T} */
export function sanitizeDeep(value) {
  return JSON.parse(sanitize(JSON.stringify(value)));
}
