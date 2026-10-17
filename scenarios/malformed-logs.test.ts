/**
 * A4. Malformed or incomplete CI logs, through real GitHub-run intake (mocked
 * GitHub API) and the real pipeline. Sandbox disabled: no code is executed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { ghRun, type RunOptions } from '../scripts/lib/gh-fixtures.ts';
import { fixtureText, useStack, waitForInvestigation } from '../scripts/lib/harness.ts';
import { describeFailures } from '../scripts/lib/integrity.ts';
import { widgetRules } from '../scripts/lib/model-scripts.ts';

const stack = useStack('scenario-malformed');

/** Deterministic pseudo-random bytes (LCG) rendered as a string with NULs, control chars, and invalid UTF-8. */
function binaryGarbage(n: number): string {
  let x = 1234567;
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes.toString('utf8');
}

function hugeLog(lines: number, failAt: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i++) {
    if (i === failAt) out.push('FAIL test/rounding.test.js', '  ● roundCurrency › rounds half up to two decimals', '    Expected: 10.13', '    Received: 10.12');
    else out.push(`2026-10-14T08:00:00.0000000Z [build] compiling module ${i} of ${lines} … ok`);
  }
  out.push('Tests:       1 failed, 4 passed, 5 total', '##[error]Process completed with exit code 1.');
  return out.join('\n');
}

async function investigate(opts: RunOptions, mode = 'heuristic') {
  const run = ghRun(opts);
  stack.hub.github.addRun(run);
  const r = await stack.api.post('/api/investigations/github', { runUrl: run.url, mode });
  assert.equal(r.status, 202, r.text);
  return waitForInvestigation(stack.api, r.json.id, 60_000);
}

describe('A4 malformed and incomplete logs complete safely', () => {
  const cases: Array<[string, RunOptions]> = [
    ['an empty log', { log: '' }],
    ['a log truncated mid-line with no summary', { log: fixtureText('logs/truncated.log') }],
    ['CRLF line endings, ANSI colours, and no test-framework output', { log: fixtureText('logs/ansi-crlf-infra.log'), framework: 'unknown', diff: null }],
    ['binary garbage with NUL bytes and invalid UTF-8', { log: binaryGarbage(20_000) }],
    ['an out-of-memory kill with no test output', { log: fixtureText('logs/oom-no-tests.log') }],
    ['a single 1 MB line', { log: `prefix ${'x'.repeat(1024 * 1024)} suffix` }],
  ];
  for (const [name, opts] of cases) {
    test(`[A4] ${name}`, async () => {
      const b = await investigate(opts);
      const inv = b.investigation;
      assert.equal(inv.status, 'inconclusive', `status ${inv.status}${inv.error ? `: ${inv.error}` : ''}`);
      assert.equal(inv.verdict, 'inconclusive', 'without executed experiments the verdict must stay inconclusive');
      assert.equal(typeof inv.failureSignature, 'string');
      assert.ok(b.hypotheses.length >= 1, 'heuristics still propose hypotheses');
      assert.ok(b.experiments.every((e) => e.status === 'skipped'), 'nothing executes with the sandbox disabled');
      assert.equal(b.patches.length, 0);
      const log = await stack.api.get(`/api/investigations/${inv.id}/log`);
      assert.equal(log.status, 200);
      assert.equal(log.json.totalLines, inv.logStats.totalLines);
      const bad = await integrityFailures(b);
      assert.equal(bad.length, 0, describeFailures(bad));
    });
  }

  test('[A4] a 60,000-line log: excerpts stay within budget and citations keep original line numbers', async () => {
    const failAt = 58_000;
    const b = await investigate({ log: hugeLog(60_000, failAt) });
    const s = b.investigation.logStats;
    assert.equal(s.totalLines, 60_000 + 5);
    assert.ok(s.sentChars <= 60_000, `sent ${s.sentChars} chars to the model stage, budget 60000`);
    const fact = b.evidence.find((e) => e.title.startsWith('Failing test:'));
    assert.ok(fact, 'failing test extracted from deep inside the log');
    assert.ok(fact.provenance.lines[0] >= failAt && fact.provenance.lines[0] <= failAt + 2, `provenance line ${fact.provenance.lines[0]} should point at ~${failAt + 1}`);
    const lines = await stack.api.get(`/api/investigations/${b.investigation.id}/log?from=${fact.provenance.lines[0]}&to=${fact.provenance.lines[0] + 1}`);
    assert.match(lines.json.lines.join('\n'), /roundCurrency/);
  });

  test('[A4] model citations that do not appear in a truncated log are marked unverified and never drawn as evidence', async () => {
    stack.hub.nebius.script(widgetRules({ verdict: 'confirmed' }));
    const b = await investigate({ log: fixtureText('logs/truncated.log') }, 'live');
    const h1 = b.hypotheses.find((h) => h.key === 'H1');
    assert.ok(h1.supporting.length === 2 && h1.supporting.every((q: any) => q.verified === false), JSON.stringify(h1.supporting));
    const rec = b.evidence.find((e) => e.kind === 'model_hypothesis' && e.hypothesisKey === 'H1');
    assert.match(rec.detail, /\[not found in log\]/);
    assert.match(rec.detail, /2 cited quote\(s\) could not be found/);
    const bad = await integrityFailures(b);
    assert.equal(bad.length, 0, describeFailures(bad));
  });
});

describe('A4 unusable runs fail clearly instead of hanging', () => {
  test('[A4] expired logs (HTTP 410) → failed with the reason recorded in the ledger', async () => {
    const b = await investigate({ logStatus: 410 });
    assert.equal(b.investigation.status, 'failed');
    assert.match(b.investigation.error, /Could not download logs for job "test \(node 20\)".*expired/);
    assert.ok(b.evidence.some((e) => e.title === 'Investigation stopped'));
  });

  test('[A4] a failed run with no jobs → failed with an explanation', async () => {
    const b = await investigate({ jobs: [] });
    assert.equal(b.investigation.status, 'failed');
    assert.match(b.investigation.error, /has no jobs/);
  });

  test('[A4] a failed run whose jobs all succeeded → failed with the observed conclusions', async () => {
    const b = await investigate({ jobs: [{ id: 1, name: 'build', conclusion: 'success' }, { id: 2, name: 'test', conclusion: 'cancelled' }] });
    assert.equal(b.investigation.status, 'failed');
    assert.match(b.investigation.error, /None of the run's 2 job\(s\) concluded "failure" \(conclusions: success, cancelled\)/);
  });
});
