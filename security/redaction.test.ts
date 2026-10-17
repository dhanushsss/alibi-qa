/**
 * F. Secret redaction, end to end. A CI log carrying synthetic credentials is
 * investigated by a real server; every place the data can surface is then
 * searched for the raw values: API responses, the raw SQLite/WAL bytes, prompts
 * sent to the model, and the server's own log output.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { MOCK_SECRETS } from '../scripts/lib/alibi-server.ts';
import { ghRun, secretBearingLog, secretCanaries } from '../scripts/lib/gh-fixtures.ts';
import { importTarget, useStack, waitForInvestigation, type Bundle } from '../scripts/lib/harness.ts';
import { widgetRules } from '../scripts/lib/model-scripts.ts';

const stack = useStack('security-redaction');
const canaries = secretCanaries();
let bundle: Bundle;
let id: string;

function leaks(haystack: string): string[] {
  return Object.entries(canaries)
    .filter(([, v]) => haystack.includes(v))
    .map(([k]) => k);
}

describe('F: secrets in CI logs never leave redaction', () => {
  before(async () => {
    stack.hub.nebius.script(widgetRules());
    const run = ghRun({ log: secretBearingLog(canaries) });
    stack.hub.github.addRun(run);
    const r = await stack.api.post('/api/investigations/github', { runUrl: run.url, mode: 'live' });
    assert.equal(r.status, 202, r.text);
    id = r.json.id;
    bundle = await waitForInvestigation(stack.api, id);
  });

  test('[F1] the server log contains no secret and no provider credential', () => {
    // Runs before any test sends a secret in a URL (request URLs are logged).
    const log = stack.server.logText();
    assert.deepEqual(leaks(log), []);
    for (const v of Object.values(MOCK_SECRETS)) assert.ok(!log.includes(v), 'server log must not contain configured credentials');
  });

  test('[F1] the ledger reports how many secrets were redacted', () => {
    const n = bundle.investigation.logStats.redactions;
    const rec = bundle.evidence.find((e) => /^Redacted \d+ secret-like value\(s\) from the log$/.test(e.title));
    assert.ok(
      n >= 10 && rec,
      `the log contained ${Object.keys(canaries).length - 3} secret-like values but logStats.redactions=${n} and the ledger says "${rec?.title ?? 'nothing'}". ` +
        'GitHub logs are already redacted inside GitHubClient.jobLog(), so the pipeline counts only what is left on the second pass.',
    );
  });

  test('[F1] the investigation bundle contains no secret', async () => {
    const r = await stack.api.get(`/api/investigations/${id}`);
    assert.deepEqual(leaks(r.text), []);
  });

  test('[F1] the stored CI log served by the API contains no secret but keeps the failure', async () => {
    const r = await stack.api.get(`/api/investigations/${id}/log`);
    assert.deepEqual(leaks(r.text), []);
    assert.match(r.text, /REDACTED/);
    assert.match(r.text, /roundCurrency/);
  });

  test('[F1] prompts sent to the model contain no secret', () => {
    const calls = stack.hub.nebius.calls;
    assert.ok(calls.length >= 2);
    for (const c of calls) assert.deepEqual(leaks(`${c.system}\n${c.user}`), [], `stage ${c.stage}`);
  });

  test('[F1] the raw database files contain no secret', () => {
    const db = stack.server.dbPath;
    for (const f of [db, `${db}-wal`]) {
      if (!existsSync(f)) continue;
      const bytes = readFileSync(f);
      assert.deepEqual(leaks(bytes.toString('latin1')), [], f.split('/').pop());
    }
  });

  test('[F1] secrets cannot be found through search', async () => {
    for (const v of [canaries.githubClassic, canaries.awsKeyId, canaries.npm]) {
      const r = await stack.api.get(`/api/investigations?q=${encodeURIComponent(v)}`);
      assert.deepEqual(r.json, []);
    }
  });

  test('[F1] the GitHub token is sent to the API but not forwarded to the log download redirect', () => {
    const api = stack.hub.github.requests.filter((r) => r.path.startsWith('/repos/'));
    assert.ok(api.length > 0 && api.every((r) => r.hasAuth));
    const redirect = stack.hub.github.requests.filter((r) => r.path.startsWith('/__logs/'));
    assert.equal(redirect.length, 1);
    assert.equal(redirect[0].authOnRedirect, false);
  });

  test('[F1] provider credentials never appear in status, settings, or model-call responses', async () => {
    for (const path of ['/api/status', '/api/settings', '/api/model-calls', '/api/overview', `/api/investigations/${id}`]) {
      const r = await stack.api.get(path);
      for (const v of Object.values(MOCK_SECRETS)) assert.ok(!r.text.includes(v), `${path} exposes a credential`);
    }
  });
});

describe('F: redaction patterns (target module)', () => {
  let redact: (t: string) => { text: string; count: number };
  before(async () => {
    redact = (await importTarget('server/src/analysis/redact.ts')).redactSecrets;
  });

  for (const [name, value] of Object.entries(canaries)) {
    if (name === 'privateKeyBody' || name === 'urlPassword' || name === 'bearer' || name === 'assignment') continue;
    test(`[F1] a bare ${name} credential is redacted`, () => {
      const out = redact(`token in output: ${value} end`);
      assert.ok(!out.text.includes(value), out.text);
      assert.ok(out.count >= 1);
    });
  }

  test('[F1] ordinary log text is not redacted', () => {
    const text = 'Tests: 1 failed, 4 passed\nExpected: 10.13\nRun TOKEN_COUNT=4 tests (ok)\nsha 3b18e51d9f2a4c6e8b0a1c3e5f7a9b1d3e5f7a9b';
    const out = redact(text);
    assert.equal(out.count, 0, out.text);
  });

  const formats: Array<[string, string]> = [
    ['a Google API key (AIza…)', ['AI', 'za', 'SyQAFAKEqafake0123456789qafakeQAFAKE'].join('')],
    ['a Stripe-style live key (sk_live_…)', ['sk', '_live_', 'qafake0123456789qafake01'].join('')],
    ['an Azure storage AccountKey', `DefaultEndpointsProtocol=https;AccountName=qa;${['Account', 'Key='].join('')}qaFAKE0123456789qaFAKE0123456789==`],
  ];
  for (const [name, value] of formats) {
    test(`[F1] ${name} is redacted`, () => {
      const secret = value.split('Key=').pop()!;
      assert.ok(!redact(`x ${value} y`).text.includes(secret), 'left in clear text');
    });
  }
});
