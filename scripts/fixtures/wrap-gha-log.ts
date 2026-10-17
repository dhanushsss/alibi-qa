/**
 * Fixture tool: wraps a raw CI output body (scenarios/overlays/<id>/ci-output.txt)
 * in GitHub Actions log format with fixed, deterministic timestamps and writes
 * scenarios/overlays/<id>/ci-log.txt. Bodies are hand-written, synthetic, and
 * contain no real repository, user, or secret data.
 *
 *   tsx scripts/fixtures/wrap-gha-log.ts <overlay-id> [--start 2026-10-15T09:00:00Z]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QA_ROOT } from '../lib/config.ts';

const id = process.argv[2];
if (!id) throw new Error('usage: wrap-gha-log.ts <overlay-id>');
const startArg = process.argv.indexOf('--start');
const start = Date.parse(startArg > 0 ? process.argv[startArg + 1] : '2026-10-15T09:00:00Z');
const dir = join(QA_ROOT, 'scenarios', 'overlays', id);
const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
const body = readFileSync(join(dir, 'ci-output.txt'), 'utf8').replace(/\n$/, '').split('\n');

const header = [
  "Current runner version: '2.329.0'",
  'Operating System',
  '  Ubuntu',
  '  24.04.3',
  '##[group]Run actions/checkout@v4',
  'with:',
  `  repository: ${scenario.repository}`,
  '  token: ***',
  '##[endgroup]',
  ...(scenario.framework === 'pytest'
    ? ['##[group]Run actions/setup-python@v5', 'Set up Python 3.12.7']
    : scenario.framework === 'go'
      ? ['##[group]Run actions/setup-go@v5', 'Set up Go 1.24.9']
      : ['##[group]Run actions/setup-node@v4', 'Set up Node.js 20']),
  '##[endgroup]',
  `##[group]Run ${scenario.ciCommand.join(' ')}`,
  scenario.ciCommand.join(' '),
  '##[endgroup]',
];
const footer = ['##[error]Process completed with exit code 1.'];
const lines = [...header, ...body, ...footer];
const ts = (i: number) => new Date(start + i * 37).toISOString().replace('Z', '0000Z');
writeFileSync(join(dir, 'ci-log.txt'), `${lines.map((l, i) => `${ts(i)} ${l}`).join('\n')}\n`);
console.log(`wrote ${join('scenarios/overlays', id, 'ci-log.txt')} (${lines.length} lines)`);
