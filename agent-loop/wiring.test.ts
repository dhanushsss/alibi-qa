/**
 * C. Loop configuration and pipeline wiring without a sandbox:
 *  - ALIBI_LOOP parsing and hard caps (target's own config module)
 *  - ALIBI_LOOP off preserves single-pass behaviour (real server, same inputs, loop on vs off)
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { ghRun } from '../scripts/lib/gh-fixtures.ts';
import { qaEnv, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { MockHub } from '../scripts/lib/mocks/hub.ts';
import { widgetRules } from '../scripts/lib/model-scripts.ts';

let n = 0;
/** Loads the target's config module in isolation with the given environment. */
async function loadConfig(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('ALIBI_LOOP')) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const url = `${pathToFileURL(join(qaEnv().targetDir, 'server/src/config.ts')).href}?qa=${++n}`;
    return (await import(url)).loadConfig().agentLoop;
  } finally {
    process.env = saved;
  }
}

describe('C: loop configuration', () => {
  test('[C7] the loop is off unless ALIBI_LOOP is exactly "1" or "true"', async () => {
    for (const v of [undefined, '', '0', 'yes', 'TRUE', 'on', 'false']) assert.equal((await loadConfig({ ALIBI_LOOP: v })).enabled, false, `ALIBI_LOOP=${JSON.stringify(v)}`);
    assert.equal((await loadConfig({ ALIBI_LOOP: '1' })).enabled, true);
    assert.equal((await loadConfig({ ALIBI_LOOP: 'true' })).enabled, true);
  });

  test('[C7] hard caps cannot be raised through the environment', async () => {
    const c = await loadConfig({ ALIBI_LOOP_MAX_ITERATIONS: '99', ALIBI_LOOP_MAX_MODEL_CALLS: '50', ALIBI_LOOP_MAX_RUNS_PER_ACTION: '500', ALIBI_LOOP_MAX_SEARCHES: '9' });
    assert.deepEqual([c.maxIterations, c.maxModelCalls, c.maxRunsPerAction, c.maxSearches], [4, 4, 20, 3]);
  });

  test('[C7] defaults match the documentation and non-numeric values fall back to them', async () => {
    const d = await loadConfig({});
    assert.deepEqual(d, { enabled: false, maxIterations: 4, maxModelCalls: 4, maxTokens: 40000, maxMs: 480000, maxRuns: 30, maxRunsPerAction: 10, maxSearches: 2 });
    const junk = await loadConfig({ ALIBI_LOOP_MAX_RUNS: 'lots', ALIBI_LOOP_MAX_TOKENS: '1e9x' });
    assert.equal(junk.maxRuns, 30);
  });

  test('[C7] negative limits are never accepted', async () => {
    const c = await loadConfig({ ALIBI_LOOP_MAX_RUNS: '-5', ALIBI_LOOP_MAX_TOKENS: '-1' });
    assert.ok(c.maxRuns >= 0 && c.maxTokens >= 0, `maxRuns=${c.maxRuns}, maxTokens=${c.maxTokens}`);
  });
});

describe('C: ALIBI_LOOP off preserves single-pass behaviour', () => {
  const hub = new MockHub();
  let off: Stack & { stop: () => Promise<void> };
  let on: Stack & { stop: () => Promise<void> };
  let a: Bundle;
  let b: Bundle;
  before(async () => {
    await hub.start();
    off = await startStack('loop-off', {}, hub);
    on = await startStack('loop-on', { loop: {} }, hub);
  });
  after(async () => {
    await off?.stop();
    await on?.stop();
    await hub.stop();
  });

  async function investigate(s: Stack, run: ReturnType<typeof ghRun>) {
    hub.nebius.script(widgetRules({ verdict: 'inconclusive' }));
    const r = await s.api.post('/api/investigations/github', { runUrl: run.url, mode: 'live' });
    assert.equal(r.status, 202, r.text);
    return waitForInvestigation(s.api, r.json.id);
  }

  test('[C10] loop off: exactly the single-pass model calls, no agent outcome, no loop records', async () => {
    const run = ghRun();
    hub.github.addRun(run);
    a = await investigate(off, run);
    assert.deepEqual(a.modelCalls.map((c) => c.step), ['triage', 'verdict']);
    assert.equal(hub.nebius.callsFor('loop').length, 0);
    assert.equal(a.investigation.agent, undefined);
    assert.ok(!a.evidence.some((e) => /^Agent |^Outcome:/.test(e.title)));
  });

  test('[C10] loop on with nothing runnable: same hypotheses, verdict, and ledger apart from the loop records', async () => {
    const run = ghRun();
    hub.github.addRun(run);
    b = await investigate(on, run);
    const pick = (x: Bundle) => ({
      classification: x.investigation.classification,
      verdict: x.investigation.verdict,
      status: x.investigation.status,
      confidence: x.investigation.confidence,
      hypotheses: x.hypotheses.map((h) => [h.key, h.category, h.status]),
      experiments: x.experiments.map((e) => [e.kind, e.status]),
      steps: x.modelCalls.map((c) => c.step),
    });
    assert.deepEqual(pick(b), pick(a));
    const titles = (x: Bundle) => x.evidence.map((e) => e.title.replace(/[0-9a-f]{12}/g, '<sha>')).filter((t) => !/^Agent loop stopped|^Outcome:/.test(t));
    assert.deepEqual(titles(b), titles(a));
  });
});
