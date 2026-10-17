/**
 * A5. Inconclusive diagnosis: the model is scripted to over-claim, but no
 * discriminating experiment can run (sandbox disabled). Alibi must cap the
 * verdict from its evidence rubric, not from the model's self-report.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { ghRun } from '../scripts/lib/gh-fixtures.ts';
import { startStack, useStack, waitForInvestigation, type Stack } from '../scripts/lib/harness.ts';
import { checkBundle, describeFailures } from '../scripts/lib/integrity.ts';
import { widget, widgetRules } from '../scripts/lib/model-scripts.ts';

const stack = useStack('scenario-inconclusive');

async function investigate(s: Stack, verdict: 'confirmed' | 'probable' | 'inconclusive') {
  const rules = widgetRules({ verdict: verdict === 'inconclusive' ? 'inconclusive' : 'confirmed' });
  if (verdict === 'probable') rules[1] = { stage: 'verdict', replies: [{ json: { ...widget().verdictConfirmed, verdict: 'probable' } }] };
  s.hub.nebius.script(rules);
  const run = ghRun();
  s.hub.github.addRun(run);
  const r = await s.api.post('/api/investigations/github', { runUrl: run.url, mode: 'live' });
  assert.equal(r.status, 202, r.text);
  return waitForInvestigation(s.api, r.json.id);
}

describe('A5 inconclusive diagnosis', () => {
  test('[A5] a model "probable" verdict with no executed experiment is capped to inconclusive', async () => {
    const b = await investigate(stack, 'probable');
    assert.equal(b.investigation.confidence.label, 'none');
    assert.equal(b.investigation.verdict, 'inconclusive');
    assert.equal(b.investigation.status, 'inconclusive');
  });

  test('[A5] a model "confirmed" verdict with no executed experiment is capped to inconclusive', async () => {
    const b = await investigate(stack, 'confirmed');
    const inv = b.investigation;
    assert.equal(inv.mode, 'live');
    assert.equal(inv.confidence.label, 'none', 'no experiment ran, so the rubric has no evidence');
    assert.equal(
      inv.verdict,
      'inconclusive',
      `with "none" evidence the verdict must be inconclusive, but a model claim of "confirmed" ended as "${inv.verdict}" (status ${inv.status}). ` +
        'reconcileVerdict() caps confirmed→probable before the "no discriminating experiment → inconclusive" rule is reached, so over-claiming yields a stronger verdict than claiming "probable".',
    );
    assert.equal(inv.status, 'inconclusive');
    assert.ok(inv.confidence.basis.includes('No reproduction experiment completed.'));
    const weighed = b.evidence.find((e) => e.title.startsWith('Verdict after experiments'));
    assert.match(weighed.title, /inconclusive/);
    assert.match(weighed.detail, /Zerqis policy: No discriminating experiment completed/);
    const last = inv.verdictHistory.at(-1);
    assert.equal(last.verdict, 'inconclusive');
    assert.match(last.note, /Capped at inconclusive/);
    const reproduce = b.experiments.find((e) => e.kind === 'reproduce');
    assert.equal(reproduce.status, 'skipped');
    assert.match(reproduce.reason, /Sandbox runner unavailable/);
    assert.equal(b.patches.length, 0);
    assert.equal(inv.agent, undefined, 'single-pass mode records no agent outcome');
    const bad = await integrityFailures(b);
    assert.equal(bad.length, 0, describeFailures(bad));
  });

  test('[A5] a model-inconclusive verdict stays inconclusive and recommends running experiments', async () => {
    const b = await investigate(stack, 'inconclusive');
    assert.equal(b.investigation.status, 'inconclusive');
    assert.equal(b.investigation.classification, 'unknown');
    assert.match(b.investigation.recommendedAction, /sandbox/);
  });

  test('[A5] with ALIBI_LOOP=1 and no sandbox the diagnosis is BLOCKED, the fix NONE, and no loop call is made', async () => {
    const s = await startStack('scenario-inconclusive-loop', { loop: {} });
    try {
      const b = await investigate(s, 'confirmed');
      const a = b.investigation.agent;
      assert.ok(a, 'agent outcome recorded when the loop is enabled');
      assert.equal(a.diagnosis, 'BLOCKED', `no sandbox run happened, yet diagnosis is ${a.diagnosis} (verdict ${b.investigation.verdict}, evidence ${b.investigation.confidence.label})`);
      assert.equal(a.fix, 'NONE');
      assert.equal(a.stopReason, 'no_allowed_action');
      assert.equal(a.modelCalls, 0);
      assert.equal(s.hub.nebius.callsFor('loop').length, 0);
      assert.ok(b.evidence.some((e) => e.title === 'Outcome: diagnosis BLOCKED · fix NONE'));
      const bad = await integrityFailures(b);
      assert.equal(bad.length, 0, describeFailures(bad));
    } finally {
      await s.stop();
    }
  });

  test('[A5] a hypothesis is only "supported" when an experiment supports it', async () => {
    const b = await investigate(stack, 'confirmed');
    const strict = checkBundle(b).find((c) => c.id === 'hypothesis.supported-backed-by-experiment')!;
    assert.ok(strict.ok, strict.detail);
  });
});
