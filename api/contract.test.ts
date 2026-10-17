/**
 * D. API contract and error handling against a real Alibi server.
 * Providers are local mocks; the sandbox runner is disabled.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, test } from 'node:test';
import { MOCK_SECRETS } from '../scripts/lib/alibi-server.ts';
import { useStack } from '../scripts/lib/harness.ts';

const stack = useStack('api-contract');

function assertErrorShape(body: any, status: number) {
  assert.equal(typeof body?.error, 'string', `status ${status}: error body must have a string "error"`);
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  assert.deepEqual(keys.filter((k) => !['error', 'hint'].includes(k)), [], `status ${status}: unexpected keys ${keys}`);
  assert.doesNotMatch(JSON.stringify(body), /at \w+ \(|node_modules|\/server\/src\//, 'error responses must not leak stack traces or source paths');
}

describe('health and status', () => {
  test('[D1] /api/health reports ok and queue depth', async () => {
    const r = await stack.api.get('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, queue: 0 });
  });

  test('[D1] /api/status describes integrations from the mock catalog without exposing credentials', async () => {
    const r = await stack.api.get('/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.nebius.configured, true);
    assert.equal(r.json.nebius.models.triage, 'qa-mock/nemotron-3-lightning');
    assert.equal(r.json.nebius.models.reasoning, 'qa-mock/nemotron-3-super');
    assert.equal(r.json.nebius.models.deep, 'qa-mock/nemotron-3-ultra');
    assert.equal(r.json.runner.ok, false, 'runner is disabled in this suite');
    assert.equal(r.json.github.webhookSecret, true, 'reports that a secret exists...');
    for (const secret of Object.values(MOCK_SECRETS)) assert.ok(!r.text.includes(secret), '...but never its value');
  });

  test('[D1] scenario listing includes the three built-in scenarios with expectations', async () => {
    const r = await stack.api.get('/api/scenarios');
    assert.equal(r.status, 200);
    const ids = r.json.map((s: any) => s.id);
    for (const id of ['flaky-jest', 'maven-dependency', 'code-regression']) assert.ok(ids.includes(id), `missing ${id}`);
    const exp = await stack.api.get('/api/scenarios/code-regression/expected');
    assert.equal(exp.json.classification, 'code_regression');
  });
});

describe('request validation', () => {
  const cases: Array<[string, unknown, number, RegExp]> = [
    ['missing scenarioId', {}, 400, /Invalid request/],
    ['unknown mode', { scenarioId: 'code-regression', mode: 'turbo' }, 400, /Invalid request/],
    ['repeat below minimum', { scenarioId: 'code-regression', repeat: 1 }, 400, /Invalid request/],
    ['repeat above maximum', { scenarioId: 'code-regression', repeat: 31 }, 400, /Invalid request/],
    ['repeat not a number', { scenarioId: 'code-regression', repeat: 'many' }, 400, /Invalid request/],
    ['scenarioId too long', { scenarioId: 'x'.repeat(61) }, 400, /Invalid request/],
    ['unknown scenario', { scenarioId: 'does-not-exist' }, 404, /Unknown scenario/],
    ['path traversal in scenarioId', { scenarioId: '../../../etc/passwd' }, 404, /Unknown scenario/],
  ];
  for (const [name, body, status, msg] of cases) {
    test(`[D2] POST /api/investigations/demo rejects ${name} with ${status}`, async () => {
      const r = await stack.api.post('/api/investigations/demo', body);
      assert.equal(r.status, status, r.text);
      assert.match(r.json.error, msg);
      assertErrorShape(r.json, r.status);
    });
  }

  test('[D2] validation errors name the offending field in the hint', async () => {
    const r = await stack.api.post('/api/investigations/demo', { scenarioId: 'code-regression', repeat: 99 });
    assert.equal(r.status, 400);
    assert.match(r.json.hint, /repeat/);
  });

  test('[D2] malformed JSON is a 400, not a 500', async () => {
    const r = await stack.api.req('POST', '/api/investigations/demo', '{"scenarioId": "code-regr', { 'content-type': 'application/json' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Invalid JSON body');
  });

  test('[D2] GitHub intake rejects non-URLs and URLs that are not Actions runs', async () => {
    const notUrl = await stack.api.post('/api/investigations/github', { runUrl: 'not a url' });
    assert.equal(notUrl.status, 400);
    const notRun = await stack.api.post('/api/investigations/github', { runUrl: 'https://github.com/qa-org/widget-service/pull/12' });
    assert.equal(notRun.status, 400);
    assert.match(notRun.json.error, /Actions run URL/);
    const otherHost = await stack.api.post('/api/investigations/github', { runUrl: 'https://evil.example/qa-org/x/actions/runs/1' });
    assert.equal(otherHost.status, 400);
    assert.equal(stack.hub.github.requests.length, 0, 'invalid URLs must not reach the GitHub API');
  });

  test('[D2] query parameters are validated', async () => {
    assert.equal((await stack.api.get('/api/investigations?classification=bogus')).status, 400);
    assert.equal((await stack.api.get(`/api/investigations?q=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await stack.api.get('/api/investigations?verdict=certain')).status, 400);
  });

  test('[D2] settings: valid values persist, invalid values are rejected and not persisted', async () => {
    const ok = await stack.api.put('/api/settings', { repeatDefault: 7, defaultMode: 'heuristic' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.repeatDefault, 7);
    const bad = await stack.api.put('/api/settings', { repeatDefault: 500 });
    assert.equal(bad.status, 400);
    const now = await stack.api.get('/api/settings');
    assert.equal(now.json.repeatDefault, 7);
    assert.equal(now.json.defaultMode, 'heuristic');
    await stack.api.put('/api/settings', { repeatDefault: 3, defaultMode: 'auto' });
  });

  test('[D2] repository allow-list validates owner/repo names', async () => {
    assert.equal((await stack.api.post('/api/repositories', { fullName: 'not a repo' })).status, 400);
    assert.equal((await stack.api.post('/api/repositories', { fullName: '../../x' })).status, 400);
    const ok = await stack.api.post('/api/repositories', { fullName: 'qa-org/allowed' });
    assert.equal(ok.status, 201);
    assert.ok(ok.json.some((r: any) => r.fullName === 'qa-org/allowed'));
    assert.equal((await stack.api.del('/api/repositories/qa-org/allowed')).status, 204);
  });
});

describe('not-found handling', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/does-not-exist'],
    ['GET', '/api/investigations/inv_missing'],
    ['GET', '/api/investigations/inv_missing/log'],
    ['POST', '/api/investigations/inv_missing/rerun'],
    ['DELETE', '/api/investigations/inv_missing'],
    ['GET', '/api/patches/patch_missing.diff'],
    ['POST', '/api/patches/patch_missing/validate'],
    ['GET', '/api/scenarios/nope/expected'],
  ];
  for (const [method, path] of routes) {
    test(`[D3] ${method} ${path} → 404 JSON`, async () => {
      const r = await stack.api.req(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
      assert.equal(r.status, 404, r.text);
      assertErrorShape(r.json, 404);
    });
  }

  test('[D3] unknown non-API paths serve the web app (client-side routing)', async () => {
    const r = await stack.api.get('/investigations/inv_missing');
    assert.equal(r.status, 200);
    assert.match(r.text, /<div id="root">/);
  });
});

describe('request size limits', () => {
  test('[D4] bodies over the 5 MiB limit are rejected with 413 before being processed', async () => {
    // Fastify answers 413 as soon as the declared length exceeds the limit and closes the
    // socket, so use a raw client that records the early response instead of fetch.
    // Only the declared length is sent; the server must refuse on the header alone, before any body arrives.
    const length = 5 * 1024 * 1024 + 64;
    const status = await new Promise<number | string>((resolve) => {
      const u = new URL('/api/investigations/demo', stack.api.base);
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': length } }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      });
      req.on('error', (e) => resolve(`error before response: ${(e as NodeJS.ErrnoException).code}`));
      req.flushHeaders();
    });
    assert.equal(status, 413);
    assert.equal((await stack.api.get('/api/health')).status, 200, 'server keeps serving after an oversized request');
    assert.equal((await stack.api.get('/api/investigations')).json.length, 0, 'nothing was created');
  });
});

describe('configuration-dependent endpoints', () => {
  test('[D5] Tavily test reports 412 when Tavily is not configured', async () => {
    const r = await stack.api.post('/api/integrations/tavily/test');
    assert.equal(r.status, 412);
    assert.match(r.json.error, /TAVILY_API_KEY/);
  });

  test('[D5] runner test reports the disabled runner', async () => {
    const r = await stack.api.post('/api/integrations/runner/test');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.match(r.json.detail, /disabled/);
  });

  test('[D5] GitHub test uses the token against the configured API only', async () => {
    const r = await stack.api.post('/api/integrations/github/test');
    assert.equal(r.status, 200);
    assert.equal(r.json.login, 'qa-mock-user');
    assert.ok(stack.hub.github.requests.some((q) => q.path === '/user' && q.hasAuth));
  });
});
