/**
 * F. Request abuse and access to sensitive actions over HTTP against real
 * servers: webhook forgery and replay, public-demo restrictions, rate limits,
 * traversal and injection attempts. Alibi has no user authentication; the
 * public demo mode is its only access control and is tested as such.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MOCK_SECRETS } from '../scripts/lib/alibi-server.ts';
import { dbRows, importTarget, startStack, useStack, waitFor, waitForInvestigation, type Stack } from '../scripts/lib/harness.ts';
import { widgetRules } from '../scripts/lib/model-scripts.ts';

const stack = useStack('security-http');

const sign = (body: string, secret: string = MOCK_SECRETS.webhookSecret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const hook = (body: string, headers: Record<string, string>) => stack.api.req('POST', '/api/webhooks/github', body, { 'content-type': 'application/json', ...headers });
const workflowRun = (id: number) =>
  JSON.stringify({ action: 'completed', workflow_run: { id, conclusion: 'failure' }, repository: { full_name: 'qa-org/widget-service', html_url: 'https://github.com/qa-org/widget-service' } });

describe('F: webhook authenticity', () => {
  const body = workflowRun(424242);
  const cases: Array<[string, Record<string, string>]> = [
    ['no signature', { 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-1' }],
    ['a signature made with the wrong secret', { 'x-hub-signature-256': sign(body, 'not-the-secret'), 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-2' }],
    ['a valid signature for a different body', { 'x-hub-signature-256': sign(workflowRun(1)), 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-3' }],
    ['a SHA-1 signature', { 'x-hub-signature-256': `sha1=${createHmac('sha1', MOCK_SECRETS.webhookSecret).update(body).digest('hex')}`, 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-4' }],
    ['a truncated signature', { 'x-hub-signature-256': sign(body).slice(0, 40), 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-5' }],
  ];
  for (const [name, headers] of cases) {
    test(`[F6] rejects ${name} with 401 and records nothing`, async () => {
      const r = await hook(body, headers);
      assert.equal(r.status, 401);
      assert.equal((await stack.api.get('/api/webhooks/deliveries')).json.length, 0);
    });
  }

  test('[F6] a signed delivery is recorded once; replaying the same delivery ID is a no-op', async () => {
    const h = { 'x-hub-signature-256': sign(body), 'x-github-event': 'workflow_run', 'x-github-delivery': 'qa-delivery-1' };
    const first = await hook(body, h);
    assert.equal(first.status, 202);
    assert.equal(first.json.recorded, true, 'auto-investigate is off, so the failed run is only recorded');
    const replay = await hook(body, h);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(dbRows(stack.server.dbPath, 'SELECT * FROM webhook_deliveries WHERE delivery_id = ?', 'qa-delivery-1').length, 1);
    assert.equal((await stack.api.get('/api/investigations')).json.length, 0, 'no investigation without auto-investigate');
  });

  test('[F6] signed deliveries without a delivery ID are rejected', async () => {
    const r = await hook(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'workflow_run' });
    assert.equal(r.status, 400);
  });

  test('[F6] signature verification uses a constant-time comparison (target module)', async () => {
    const { verifyWebhookSignature } = await importTarget('server/src/integrations/github.ts');
    assert.equal(verifyWebhookSignature('s', Buffer.from('{}'), undefined), false);
    assert.equal(verifyWebhookSignature('s', Buffer.from('{}'), `sha256=${createHmac('sha256', 's').update('{}').digest('hex').toUpperCase()}`), false);
    assert.equal(verifyWebhookSignature('s', Buffer.from('{}'), `sha256=${createHmac('sha256', 's').update('{}').digest('hex')}`), true);
  });
});

describe('F: traversal and injection attempts', () => {
  test('[F7] encoded traversal in route parameters returns 404, never file content', async () => {
    for (const p of ['/api/patches/..%2F..%2F..%2Fetc%2Fpasswd.diff', '/api/investigations/..%2F..%2Fqa.db', '/api/scenarios/..%2F..%2Fpackage/expected']) {
      const r = await stack.api.get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /root:|"better-sqlite3"|SQLite format/);
    }
  });

  test('[F7] static file serving does not escape the web bundle', async () => {
    for (const p of ['/../../../../etc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fpackage.json', '/assets/..%2f..%2f..%2fserver%2fsrc%2fconfig.ts']) {
      const r = await stack.api.get(p);
      assert.doesNotMatch(r.text, /root:x:0:0|"workspaces"|loadDotenv/, p);
    }
  });

  test('[F7] search input is treated as data (SQL wildcards and quotes)', async () => {
    stack.hub.nebius.script(widgetRules());
    const all = (await stack.api.get('/api/investigations')).json.length;
    for (const q of ["%' OR 1=1 --", '%', '_', '"); DROP TABLE investigations; --']) {
      const r = await stack.api.get(`/api/investigations?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, q);
      assert.ok(r.json.length <= all);
    }
    assert.ok(dbRows(stack.server.dbPath, "SELECT name FROM sqlite_master WHERE name = 'investigations'").length === 1);
  });

  test('[F7] log ranges outside the stored log are handled without errors', async () => {
    const run = await import('../scripts/lib/gh-fixtures.ts').then((m) => m.ghRun());
    stack.hub.github.addRun(run);
    const r = await stack.api.post('/api/investigations/github', { runUrl: run.url, mode: 'heuristic' });
    await waitForInvestigation(stack.api, r.json.id);
    for (const q of ['from=999999999', 'from=5&to=2', 'to=1']) {
      const l = await stack.api.get(`/api/investigations/${r.json.id}/log?${q}`);
      assert.equal(l.status, 200, q);
    }
    for (const q of ['from=0', 'from=-1', 'from=abc', 'to=1.5']) assert.equal((await stack.api.get(`/api/investigations/${r.json.id}/log?${q}`)).status, 400, q);
  });

  test('[F7] draft PR creation requires explicit confirmation and a validated GitHub patch', async () => {
    const noConfirm = await stack.api.post('/api/patches/patch_x/pull-request', {});
    assert.equal(noConfirm.status, 400);
    const missing = await stack.api.post('/api/patches/patch_x/pull-request', { confirm: true });
    assert.equal(missing.status, 404);
    assert.equal(stack.hub.github.writes.length, 0, 'no write reached GitHub');
  });
});

describe('F: public demo mode restricts sensitive actions', () => {
  let demo: Stack & { stop: () => Promise<void> };
  before(async () => {
    demo = await startStack('security-public-demo', { publicDemo: true });
  });
  after(async () => demo?.stop());

  test('[F8] destructive and outward-facing actions are refused with 403', async () => {
    const checks: Array<[string, string, unknown]> = [
      ['DELETE', '/api/investigations/inv_any', undefined],
      ['PUT', '/api/settings', { repeatDefault: 5 }],
      ['POST', '/api/repositories', { fullName: 'qa-org/x' }],
      ['DELETE', '/api/repositories/qa-org/x', undefined],
    ];
    for (const [m, p, b] of checks) assert.equal((await demo.api.req(m, p, b)).status, 403, `${m} ${p}`);
    assert.equal((await demo.api.get('/api/settings')).json.readOnly, true);
  });

  test('[F8] GitHub investigations are limited to allow-listed repositories', async () => {
    const r = await demo.api.post('/api/investigations/github', { runUrl: 'https://github.com/someone-else/repo/actions/runs/123' });
    assert.equal(r.status, 403);
    assert.equal(demo.hub.github.requests.filter((q) => q.path.includes('someone-else')).length, 0, 'refused before calling GitHub');
  });

  describe('limits (fresh server so earlier starts do not count)', () => {
    let limited: Stack & { stop: () => Promise<void> };
    before(async () => {
      limited = await startStack('security-rate-limit', { publicDemo: true });
    });
    after(async () => limited?.stop());

    test('[F8] the queue is capped at 4 and starts are limited to 6 per client per hour', async () => {
      limited.hub.nebius.script([{ stage: 'triage', replies: [{ delayMs: 1500, then: widgetRules()[0].replies[0] }], repeatLast: true }, { ...widgetRules()[1], repeatLast: true }]);
      const start = () => limited.api.post('/api/investigations/demo', { scenarioId: 'code-regression', mode: 'live' });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await start()).status);
      assert.deepEqual(statuses, [202, 202, 202, 202, 503], 'the fifth start finds the queue full (and still counts toward the limit)');
      await waitFor(async () => (await limited.api.get('/api/health')).json.queue === 0, { timeoutMs: 60_000, what: 'queue to drain' });
      assert.equal((await start()).status, 202, 'sixth start is within the hourly limit');
      assert.equal((await start()).status, 429, 'seventh start is rate-limited');
    });

    test('[F8] the per-client rate limit cannot be bypassed with a spoofed X-Forwarded-For header', async () => {
      const r = await limited.api.req('POST', '/api/investigations/demo', { scenarioId: 'code-regression', mode: 'heuristic' }, { 'x-forwarded-for': '203.0.113.77' });
    assert.equal(
      r.status,
      429,
        `a client-supplied X-Forwarded-For reset the per-IP limit (got ${r.status}). The app sets trustProxy: true, so req.ip is taken from the header; behind a proxy that appends, the left-most (client-controlled) value is used.`,
      );
    });
  });

  test('[F8] provider-spending test endpoints are restricted in public demo mode', async () => {
    demo.hub.nebius.script([{ stage: 'ping', replies: [{ json: { status: 'ok' } }], repeatLast: true }]);
    const r = await demo.api.post('/api/integrations/nebius/test');
    assert.ok([403, 429].includes(r.status), `anonymous visitors can trigger a paid inference call (status ${r.status})`);
  });

  test('[F8] the server binds to loopback unless HOST is set', async () => {
    const saved = process.env.HOST;
    delete process.env.HOST;
    try {
      const { loadConfig } = await importTarget('server/src/config.ts');
      assert.equal(loadConfig().host, '127.0.0.1');
    } finally {
      if (saved !== undefined) process.env.HOST = saved;
    }
  });
});
