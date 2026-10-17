/**
 * D. Persistence, duplicate submissions, restarts, concurrency, timeouts,
 * provider outages, missing configuration, and cleanup — against real Alibi
 * server processes and their SQLite databases. Providers are local mocks.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ghRun } from '../scripts/lib/gh-fixtures.ts';
import { dbRows, startStack, useStack, waitFor, waitForInvestigation, type Stack } from '../scripts/lib/harness.ts';
import { widgetRules } from '../scripts/lib/model-scripts.ts';

const stack = useStack('api-reliability');

async function startRun(s: Stack, run = ghRun()) {
  s.hub.github.addRun(run);
  const r = await s.api.post('/api/investigations/github', { runUrl: run.url });
  assert.ok(r.status === 202 || r.status === 200, `intake failed: ${r.status} ${r.text}`);
  return { run, id: r.json.id as string, res: r };
}

describe('persistence', () => {
  test('[D6] GitHub intake persists the investigation, its log, and its ledger, and reaches a terminal state', async () => {
    stack.hub.nebius.script(widgetRules());
    const { run, id, res } = await startRun(stack);
    assert.equal(res.status, 202);
    assert.equal(res.json.duplicate, false);
    const b = await waitForInvestigation(stack.api, id);
    assert.ok(['completed', 'inconclusive'].includes(b.investigation.status), b.investigation.status);

    const [row] = dbRows(stack.server.dbPath, 'SELECT status, dedupe_key, repository, source FROM investigations WHERE id = ?', id);
    assert.equal(row.status, b.investigation.status);
    assert.equal(row.dedupe_key, `gh:qa-org/widget-service:${run.runId}:1`);
    assert.equal(row.source, 'github');
    const [{ n: evidence }] = dbRows(stack.server.dbPath, 'SELECT COUNT(*) AS n FROM evidence WHERE investigation_id = ?', id);
    assert.equal(evidence, b.evidence.length, 'API ledger and DB ledger have the same number of records');
    const [log] = dbRows(stack.server.dbPath, 'SELECT line_count FROM ci_logs WHERE investigation_id = ?', id);
    const apiLog = await stack.api.get(`/api/investigations/${id}/log`);
    assert.equal(apiLog.json.totalLines, log.line_count);
    assert.equal(stack.hub.nebius.unscripted().length, 0, 'the pipeline made only the scripted model calls');
  });

  test('[D6] data survives a server restart unchanged', async () => {
    const s = await startStack('api-restart');
    try {
      s.hub.nebius.script(widgetRules());
      const { id } = await startRun(s);
      const before = await waitForInvestigation(s.api, id);
      const restarted = await s.server.restart();
      try {
        const after = (await fetch(`${restarted.url}/api/investigations/${id}`).then((r) => r.json())) as any;
        assert.deepEqual(after.investigation, before.investigation);
        assert.deepEqual(after.evidence.map((e: any) => e.id), before.evidence.map((e: any) => e.id));
        assert.deepEqual(after.hypotheses, before.hypotheses);
      } finally {
        await restarted.stop();
      }
    } finally {
      await s.stop();
    }
  });

  test('[D7] an investigation interrupted by a crash is marked failed on restart and can be re-run', async () => {
    const s = await startStack('api-interrupt');
    try {
      s.hub.nebius.script([{ stage: 'triage', replies: [{ delayMs: 60_000, then: { json: {} } }] }]);
      const { id } = await startRun(s);
      await waitFor(async () => s.hub.nebius.callsFor('triage').length > 0, { timeoutMs: 20_000, what: 'triage call in flight' });
      await s.server.kill(); // SIGKILL mid-investigation
      const restarted = await s.server.restart();
      try {
        const b = (await fetch(`${restarted.url}/api/investigations/${id}`).then((r) => r.json())) as any;
        assert.equal(b.investigation.status, 'failed');
        assert.equal(b.investigation.stage, 'Interrupted');
        assert.match(b.investigation.error, /restarted while this investigation was in progress/);
        s.hub.nebius.script(widgetRules());
        const rerun = await fetch(`${restarted.url}/api/investigations/${id}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(rerun.status, 202);
        const fresh = (await rerun.json()) as any;
        assert.notEqual(fresh.id, id, 'a re-run is a new investigation');
      } finally {
        await restarted.stop();
      }
    } finally {
      await s.stop();
    }
  });
});

describe('duplicate submissions', () => {
  test('[D8] submitting the same run twice returns the existing investigation', async () => {
    stack.hub.nebius.script(widgetRules());
    const run = ghRun();
    const first = await startRun(stack, run);
    const second = await stack.api.post('/api/investigations/github', { runUrl: run.url });
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.id, first.id);
    await waitForInvestigation(stack.api, first.id);
  });

  test('[D8] concurrent identical submissions create exactly one investigation', async () => {
    stack.hub.nebius.script(widgetRules());
    const run = ghRun();
    stack.hub.github.addRun(run);
    const responses = await Promise.all(Array.from({ length: 6 }, () => stack.api.post('/api/investigations/github', { runUrl: run.url })));
    for (const r of responses) assert.ok(r.status === 200 || r.status === 202, `${r.status} ${r.text}`);
    const ids = new Set(responses.map((r) => r.json.id));
    assert.equal(ids.size, 1, `expected one investigation id, got ${[...ids].join(', ')}`);
    assert.equal(responses.filter((r) => r.json.duplicate === false).length, 1, 'exactly one response is the original');
    const [{ n }] = dbRows(stack.server.dbPath, 'SELECT COUNT(*) AS n FROM investigations WHERE dedupe_key = ?', `gh:qa-org/widget-service:${run.runId}:1`);
    assert.equal(n, 1);
    await waitForInvestigation(stack.api, [...ids][0]);
  });
});

describe('queue and concurrency', () => {
  test('[D9] with ALIBI_CONCURRENCY=1 at most one investigation runs at a time and the rest queue in order', async () => {
    const s = await startStack('api-concurrency', { concurrency: 1 });
    try {
      const w = widgetRules();
      s.hub.nebius.script([{ stage: 'triage', replies: [{ delayMs: 700, then: (w[0].replies[0]) }], repeatLast: true }, { ...w[1], repeatLast: true }]);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await startRun(s)).id);
      const third = await s.api.get(`/api/investigations/${ids[2]}`);
      assert.ok(third.json.queuePosition >= 0, 'the last submission is queued');
      let maxRunning = 0;
      await waitFor(
        async () => {
          const list = (await s.api.get('/api/investigations')).json as any[];
          const mine = list.filter((i) => ids.includes(i.id));
          maxRunning = Math.max(maxRunning, mine.filter((i) => i.status === 'running').length);
          return mine.every((i) => ['completed', 'inconclusive', 'failed'].includes(i.status));
        },
        { timeoutMs: 60_000, intervalMs: 50, what: 'all queued investigations to finish' },
      );
      assert.ok(maxRunning <= 1, `observed ${maxRunning} investigations running at once`);
      const order = s.hub.nebius.callsFor('triage').map((c) => /commit: ([0-9a-f]{40})/.exec(c.user)?.[1]);
      const shas = await Promise.all(ids.map(async (id) => (await s.api.get(`/api/investigations/${id}`)).json.investigation.commitSha));
      assert.deepEqual(order, shas, 'investigations ran in submission order');
    } finally {
      await s.stop();
    }
  });
});

describe('provider failures', () => {
  test('[D10] a hanging model times out and the stage falls back to labeled heuristics', async () => {
    const s = await startStack('api-timeout', { env: { NEBIUS_TIMEOUT_MS: '1200', NEBIUS_MAX_RETRIES: '1' } });
    try {
      s.hub.nebius.script([{ stage: 'triage', replies: [{ hang: true }], repeatLast: true }, { stage: 'verdict', replies: [{ hang: true }], repeatLast: true }]);
      const t0 = Date.now();
      const { id } = await startRun(s);
      const b = await waitForInvestigation(s.api, id, 45_000);
      assert.ok(Date.now() - t0 < 45_000);
      const calls = b.modelCalls.filter((c) => c.step === 'triage' || c.step === 'verdict');
      assert.equal(calls.length, 2);
      for (const c of calls) {
        assert.equal(c.status, 'error');
        assert.match(c.error, /timed out after 1200 ms/);
        assert.equal(c.attempts, 2, 'one retry, then give up');
      }
      assert.equal(b.investigation.modelsUsed.triage, 'heuristic (no model)');
      assert.ok(b.hypotheses.every((h) => h.origin === 'heuristic'));
      assert.ok(b.investigation.limitations.some((l: string) => /triage model call failed/.test(l)));
    } finally {
      await s.stop();
    }
  });

  test('[D10] HTTP 503 from the provider is retried, then recorded as an error with heuristic fallback', async () => {
    stack.hub.nebius.script([{ stage: 'triage', replies: [{ status: 503 }], repeatLast: true }, { stage: 'verdict', replies: [{ status: 503 }], repeatLast: true }]);
    const { id } = await startRun(stack);
    const b = await waitForInvestigation(stack.api, id, 30_000);
    const triage = b.modelCalls.find((c) => c.step === 'triage');
    assert.equal(triage.status, 'error');
    assert.match(triage.error, /HTTP 503/);
    assert.equal(triage.attempts, 2);
    assert.ok(['completed', 'inconclusive'].includes(b.investigation.status));
  });

  test('[D10] HTTP 429 with Retry-After is retried and the call then succeeds', async () => {
    const w = widgetRules();
    stack.hub.nebius.script([{ stage: 'triage', replies: [{ status: 429, headers: { 'retry-after': '1' } }, w[0].replies[0]] }, w[1]]);
    const { id } = await startRun(stack);
    const b = await waitForInvestigation(stack.api, id, 30_000);
    const triage = b.modelCalls.find((c) => c.step === 'triage');
    assert.equal(triage.status, 'ok');
    assert.equal(triage.attempts, 2);
    const [a, bCall] = stack.hub.nebius.callsFor('triage');
    assert.ok(bCall.at - a.at >= 900, 'Retry-After was honored');
  });

  test('[D10] HTTP 401 is not retried', async () => {
    stack.hub.nebius.script([{ stage: 'triage', replies: [{ status: 401, body: { error: { message: 'invalid api key' } } }], repeatLast: true }, { stage: 'verdict', replies: [{ status: 401 }], repeatLast: true }]);
    const { id } = await startRun(stack);
    const b = await waitForInvestigation(stack.api, id, 30_000);
    const triage = b.modelCalls.find((c) => c.step === 'triage');
    assert.equal(triage.attempts, 1);
    assert.match(triage.error, /HTTP 401/);
    assert.equal(stack.hub.nebius.callsFor('triage').length, 1);
  });

  test('[D10] malformed model output gets one repair round, then falls back without crashing', async () => {
    stack.hub.nebius.script([
      { stage: 'triage', replies: [{ content: 'I believe this is a regression in rounding.' }, { content: '{"summary": "unterminated' }] },
      { stage: 'verdict', replies: [{ json: { verdict: 'certain', hypotheses: 'none' } }], repeatLast: true },
    ]);
    const { id } = await startRun(stack);
    const b = await waitForInvestigation(stack.api, id, 30_000);
    const triage = b.modelCalls.find((c) => c.step === 'triage');
    const verdict = b.modelCalls.find((c) => c.step === 'verdict');
    assert.equal(triage.status, 'invalid');
    assert.equal(verdict.status, 'invalid');
    assert.equal(stack.hub.nebius.callsFor('triage').length, 2, 'original request plus one repair round');
    assert.equal(stack.hub.nebius.callsFor('triage')[1].messageCount, 4, 'the repair round includes the invalid reply and a correction request');
    assert.ok(b.hypotheses.length > 0 && b.hypotheses.every((h) => h.origin === 'heuristic'));
  });

  test('[D10] the per-investigation model-call budget is enforced', async () => {
    const s = await startStack('api-budget', { env: { ALIBI_MAX_MODEL_CALLS: '1' } });
    try {
      s.hub.nebius.script(widgetRules());
      const { id } = await startRun(s);
      const b = await waitForInvestigation(s.api, id);
      assert.equal(s.hub.nebius.calls.length, 1, 'only one chat completion was sent');
      const verdict = b.modelCalls.find((c) => c.step === 'verdict');
      assert.match(verdict.error, /budget \(1\) exhausted/);
    } finally {
      await s.stop();
    }
  });

  test('[D10] a GitHub API outage at intake returns 502 and creates nothing', async () => {
    const run = ghRun({ runError: 500 });
    stack.hub.github.addRun(run);
    const before = (await stack.api.get('/api/investigations')).json.length;
    const r = await stack.api.post('/api/investigations/github', { runUrl: run.url });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /GitHub 500/);
    assert.equal((await stack.api.get('/api/investigations')).json.length, before);
    assert.equal(stack.hub.github.requests.filter((q) => q.path.endsWith(`/runs/${run.runId}`)).length, 3, 'two retries before giving up');
  });

  test('[D10] runs that are still in progress or did not fail are refused with 409', async () => {
    const running = ghRun({ status: 'in_progress' });
    const green = ghRun({ conclusion: 'success' });
    stack.hub.github.addRun(running);
    stack.hub.github.addRun(green);
    const a = await stack.api.post('/api/investigations/github', { runUrl: running.url });
    const b = await stack.api.post('/api/investigations/github', { runUrl: green.url });
    assert.equal(a.status, 409);
    assert.equal(b.status, 409);
  });
});

describe('missing configuration', () => {
  let bare: Stack & { stop: () => Promise<void> };
  after(async () => bare?.stop());

  test('[D11] without GitHub, Nebius, or a webhook secret every dependent endpoint fails clearly', async () => {
    bare = await startStack('api-bare', { nebius: 'none', github: false, webhookSecret: false });
    const gh = await bare.api.post('/api/investigations/github', { runUrl: 'https://github.com/qa-org/widget-service/actions/runs/1' });
    assert.equal(gh.status, 412);
    assert.match(gh.json.hint, /GITHUB_TOKEN/);
    assert.equal((await bare.api.post('/api/webhooks/github', { zen: 'x' })).status, 503);
    assert.equal((await bare.api.post('/api/integrations/nebius/test')).status, 412);
    assert.equal((await bare.api.post('/api/integrations/github/test')).status, 412);
    const status = await bare.api.get('/api/status');
    assert.equal(status.json.nebius.configured, false);
    assert.equal(status.json.nebius.models, null);
    assert.equal(bare.hub.nebius.modelListCalls, 0, 'no provider traffic without a key');
  });

  test('[D11] live mode without a key degrades to heuristics and says so', async () => {
    const r = await bare.api.post('/api/investigations/demo', { scenarioId: 'code-regression', mode: 'live' });
    assert.equal(r.status, 202);
    const b = await waitForInvestigation(bare.api, r.json.id);
    assert.equal(b.investigation.mode, 'heuristic');
    assert.ok(b.investigation.limitations.some((l: string) => /Live mode was requested but NEBIUS_API_KEY is not configured/.test(l)));
    assert.equal(b.modelCalls.length, 0);
  });

  test('[D11] replay mode without a recording degrades to heuristics and says so', async () => {
    const r = await bare.api.post('/api/investigations/demo', { scenarioId: 'code-regression', mode: 'replay' });
    const b = await waitForInvestigation(bare.api, r.json.id);
    assert.equal(b.investigation.mode, 'heuristic');
    assert.ok(b.investigation.limitations.some((l: string) => /No recorded model outputs exist/.test(l)));
  });
});

describe('cleanup', () => {
  test('[D12] deleting an investigation removes it and every dependent record', async () => {
    stack.hub.nebius.script(widgetRules());
    const { id } = await startRun(stack);
    await waitForInvestigation(stack.api, id);
    assert.equal((await stack.api.del(`/api/investigations/${id}`)).status, 204);
    assert.equal((await stack.api.get(`/api/investigations/${id}`)).status, 404);
    for (const table of ['investigations', 'hypotheses', 'experiments', 'evidence', 'sources', 'patches', 'ci_logs']) {
      const col = table === 'investigations' ? 'id' : 'investigation_id';
      const [{ n }] = dbRows(stack.server.dbPath, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, id);
      assert.equal(n, 0, `${table} still has rows for the deleted investigation`);
    }
  });

  test('[D12] model-call records of a deleted investigation are also removed', async () => {
    stack.hub.nebius.script(widgetRules());
    const { id } = await startRun(stack);
    await waitForInvestigation(stack.api, id);
    await stack.api.del(`/api/investigations/${id}`);
    const [{ n }] = dbRows(stack.server.dbPath, 'SELECT COUNT(*) AS n FROM model_calls WHERE investigation_id = ?', id);
    assert.equal(n, 0, `${n} model_calls rows remain for the deleted investigation`);
  });

  test('[D12] a running investigation cannot be deleted', async () => {
    stack.hub.nebius.script([{ stage: 'triage', replies: [{ delayMs: 2500, then: widgetRules()[0].replies[0] }] }, widgetRules()[1]]);
    const { id } = await startRun(stack);
    await waitFor(async () => (await stack.api.get(`/api/investigations/${id}`)).json.investigation.status === 'running', { timeoutMs: 10_000, what: 'running state' });
    const r = await stack.api.del(`/api/investigations/${id}`);
    assert.equal(r.status, 409);
    await waitForInvestigation(stack.api, id);
  });

  test('[D12] per-investigation workspaces are removed when the investigation ends', async () => {
    const list = (await stack.api.get('/api/investigations')).json as any[];
    for (const inv of list) assert.equal(existsSync(join(stack.server.dataDir, 'workspaces', inv.id)), false, `workspace left behind for ${inv.id}`);
  });
});
