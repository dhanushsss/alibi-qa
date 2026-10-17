/**
 * A1–A3, A6–A8 and B. Core product scenarios with REAL execution: the Alibi
 * server builds the QA overlay repositories with git, runs every experiment and
 * every fix validation in its Docker sandbox, and persists the results. Only
 * the model is scripted. Successful fixes are re-validated independently by
 * QA's own sandbox from the persisted diff.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { QA_ROOT } from '../scripts/lib/config.ts';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { dockerSkipReason, qaEnv, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { describeFailures } from '../scripts/lib/integrity.ts';
import { overlayRules } from '../scripts/lib/model-scripts.ts';
import { independentValidate } from '../scripts/lib/sandbox.ts';

const skip = dockerSkipReason();
const TIMEOUT = 900_000;
let core: Stack & { stop: () => Promise<void> };
let loop: Stack & { stop: () => Promise<void> };

before(async () => {
  if (skip) return;
  core = await startStack('docker-core', { runner: 'docker' });
  loop = await startStack('docker-core-loop', { runner: 'docker', loop: {} });
});
after(async () => {
  await core?.stop();
  await loop?.stop();
});

async function investigate(s: Stack, id: string, rules: ReturnType<typeof overlayRules>, repeat = 3): Promise<Bundle> {
  s.hub.nebius.script(rules);
  const r = await s.api.post('/api/investigations/demo', { scenarioId: id, mode: 'live', repeat });
  assert.equal(r.status, 202, r.text);
  const b = await waitForInvestigation(s.api, r.json.id, TIMEOUT);
  assert.notEqual(b.investigation.status, 'failed', `investigation failed: ${b.investigation.error}`);
  assert.deepEqual(s.hub.nebius.unscripted().map((c) => c.stage), [], 'the pipeline asked the model for something the scenario did not script');
  assert.deepEqual(s.server.blockedRequests(), [], 'no outbound request may leave the server under test');
  return b;
}

const exp = (b: Bundle, kind: string) => b.experiments.find((e) => e.kind === kind && e.status !== 'skipped');
const inference = (b: Bundle, expId: string, key: string) => b.evidence.find((e) => e.kind === 'inference' && e.experimentId === expId && e.hypothesisKey === key)?.effect;
const repoOf = (s: Stack, id: string) => join(s.server.dataDir, 'demo-repos', id);
const scratch = () => join(qaEnv().runDir, 'scratch');

async function assertIntegrity(b: Bundle) {
  const bad = await integrityFailures(b);
  assert.equal(bad.length, 0, describeFailures(bad));
}

describe('A1 + A8: code regression, fix validated in a fresh sandbox', { skip }, () => {
  let b: Bundle;
  test('[A1] the failing revision fails and the parent passes, in real sandbox runs', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-code-regression', overlayRules('qa-code-regression', { patch: ['patchCorrect'] }));
    const inv = b.investigation;
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.status, 'failed');
    assert.equal(reproduce.environment.network, 'none');
    assert.notEqual(reproduce.result.attempts[0].exitCode, 0);
    assert.deepEqual(reproduce.result.attempts[0].tests.failedNames.sort(), [
      'shippingCents charges the large rate at exactly 20 kg',
      'shippingCents charges the small-parcel rate up to and including 1 kg',
    ]);
    const repeat = exp(b, 'repeat');
    assert.equal(repeat.result.failures, 3, 'deterministic: fails every repeated run');
    const parent = exp(b, 'compare_parent');
    assert.equal(parent.commitSha, inv.parentSha);
    assert.equal(parent.result.failures, 0);
    assert.equal(parent.result.passes, 3);
    assert.equal(inference(b, reproduce.id, 'H1'), 'supports');
    assert.equal(inference(b, parent.id, 'H1'), 'supports');
    assert.equal(inference(b, repeat.id, 'H2'), 'contradicts', 'deterministic failure contradicts the flaky hypothesis');
    assert.equal(b.hypotheses.find((h) => h.key === 'H2').status, 'refuted');
    assert.equal(inv.classification, 'code_regression');
    await assertIntegrity(b);
  });

  test('[A8] the model fix is validated in a fresh sandbox, the verdict is confirmed only after that', { timeout: TIMEOUT }, async () => {
    assert.ok(b, 'depends on the previous test');
    const model = b.patches.find((p) => p.origin === 'model');
    assert.equal(model.status, 'validated');
    assert.deepEqual(model.files, ['src/shipping.js']);
    const t = b.experiments.find((e) => e.id === model.validation.targetedExperimentId);
    const suite = b.experiments.find((e) => e.id === model.validation.suiteExperimentId);
    assert.equal(t.kind, 'validate_patch');
    assert.equal(t.patchId, model.id);
    assert.ok(t.result.attempts.length === 3 && t.result.attempts.every((a: any) => a.exitCode === 0));
    assert.equal(suite.kind, 'regression_suite');
    assert.equal(suite.status, 'passed');
    assert.ok(Date.parse(t.startedAt) > Date.parse(exp(b, 'compare_parent').finishedAt), 'validation ran after the diagnostic experiments');
    const history = b.investigation.verdictHistory.map((v: any) => v.verdict);
    assert.deepEqual(history, [null, 'probable', 'confirmed'], 'probable after experiments, confirmed only once a fix validated');
    assert.equal(b.investigation.confidence.label, 'strong');
    assert.equal(b.investigation.remediationType, 'code_patch');
  });

  test('[A8] QA independently confirms the persisted fix: fails before, passes after, in its own sandbox', { timeout: TIMEOUT }, async () => {
    const model = b.patches.find((p) => p.origin === 'model');
    const r = await independentValidate({ repoPath: repoOf(core, 'qa-code-regression'), sha: b.investigation.commitSha, diff: model.diff, scratch: scratch() });
    assert.equal(r.applied, true);
    assert.notEqual(r.before[0], 0, 'the failing commit fails without the patch');
    assert.equal(r.after[0], 0, `the patched commit passes the full suite:\n${r.output.slice(-800)}`);
  });
});

describe('A2: dependency incompatibility — failed patch, then a valid dependency correction', { skip }, () => {
  let b: Bundle;
  test('[A2] the model patch fails validation and the deterministic pin validates', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-dependency-incompat', overlayRules('qa-dependency-incompat', { patch: ['patchWrongDep'] }));
    const inv = b.investigation;
    assert.equal(inv.classification, 'dependency_regression');
    assert.ok(b.evidence.some((e) => e.title === 'Dependency change: uuid 3.4.0 → 9.0.1'));
    assert.equal(exp(b, 'compare_parent').result.failures, 0);
    const [first, second] = b.patches;
    assert.equal(first.origin, 'model');
    assert.equal(first.status, 'failed', 'uuid 8.3.2 still lacks the deep import');
    assert.match(first.validation.summary, /Targeted runs: 3\/3 runs failed/);
    assert.equal(second.strategy, 'dependency_pin');
    assert.equal(second.title, 'Pin uuid back to 3.4.0');
    assert.equal(
      second.status,
      'validated',
      `the pin back to uuid 3.4.0 was rejected (${second.validation?.summary}). validatePatch() prepares the fresh workspace — clone and npm install — before applying the patch, ` +
        'so an npm dependency pin is tested against the dependencies of the failing commit. The next test checks the pin independently.',
    );
    const seq = (title: string) => b.evidence.find((e) => e.title === title)?.seq ?? -1;
    assert.ok(seq(`Candidate failed validation: ${first.title}`) < seq(`Candidate validated: ${second.title}`), 'ledger order: failed patch, then the valid correction');
    assert.equal(inv.remediationType, 'dependency_pin');
    assert.equal(inv.verdict, 'confirmed');
    await assertIntegrity(b);
  });

  test('[C10] with ALIBI_LOOP off a failed model fix is not retried', () => {
    assert.equal(core.hub.nebius.callsFor('patch-retry').length, 0);
    assert.equal(b.investigation.agent, undefined);
    assert.ok(!b.patches.some((p) => /^Retry:/.test(p.title)));
  });

  test('[A2] QA independently confirms the pin', { timeout: TIMEOUT }, async () => {
    const pin = b.patches.find((p) => p.strategy === 'dependency_pin');
    const r = await independentValidate({ repoPath: repoOf(core, 'qa-dependency-incompat'), sha: b.investigation.commitSha, diff: pin.diff, scratch: scratch() });
    assert.deepEqual([r.applied, r.before[0] !== 0, r.after[0]], [true, true, 0], r.output.slice(-600));
  });
});

describe('A3: flaky test — intermittent failures with replayable seeds', { skip }, () => {
  const require = createRequire(join(QA_ROOT, 'scenarios/overlays/qa-flaky/commits/01-base/package.json'));
  const { mulberry32, plan } = require('./src/batcher.js');
  /** Oracle: the fixture's own code decides which seeds fail. */
  const fails = (seed: number) => plan(['a', 'b', 'c'], { random: mulberry32(seed) }).map((n: any) => n.id).join('') !== 'abc';
  let b: Bundle;

  test('[A3] repeated runs observe exactly the failures the seeds predict', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-flaky', overlayRules('qa-flaky'), 6);
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.result.attempts[0].seed, 4242000, 'reproduced with the exact CI seed');
    assert.equal(reproduce.status, 'failed');
    const repeat = exp(b, 'repeat');
    const observed = repeat.result.attempts.map((a: any) => [a.seed, a.passed]);
    const expected = repeat.result.attempts.map((a: any) => [a.seed, !fails(a.seed)]);
    assert.deepEqual(observed, expected);
    assert.ok(repeat.result.failures > 0 && repeat.result.passes > 0, 'intermittent');
    const fr = repeat.result.failureRate;
    assert.equal(fr.n, 6);
    assert.equal(fr.rate, repeat.result.failures / 6);
    assert.ok(fr.low < fr.rate && fr.rate < fr.high, 'Wilson interval brackets the observed rate');
    const parent = exp(b, 'compare_parent');
    assert.deepEqual(parent.result.attempts.map((a: any) => a.passed), parent.result.attempts.map((a: any) => !fails(a.seed)));
    assert.equal(inference(b, repeat.id, 'H1'), 'supports');
    assert.equal(inference(b, repeat.id, 'H2'), 'contradicts');
    assert.equal(b.investigation.classification, 'flaky_test');
    assert.ok(b.investigation.limitations.some((l: string) => /Flake rate measured over 6 runs/.test(l)));
    await assertIntegrity(b);
  });

  test('[A3] the quarantine skips only the flaky test and validates over the same seeds', { timeout: TIMEOUT }, async () => {
    const q = b.patches.find((p) => p.strategy === 'quarantine');
    assert.equal(q.status, 'validated');
    assert.match(q.diff, /\+\s+test\.skip\('delivers notifications in submission order'/);
    assert.match(q.diff, /Quarantined by Zerqis/);
    assert.doesNotMatch(q.diff, /schedules every notification exactly once'.*skip|test\.skip\('schedules/);
    const t = b.experiments.find((e) => e.id === q.validation.targetedExperimentId);
    assert.equal(t.result.attempts.length, 6);
    assert.ok(t.result.attempts.every((a: any) => a.passed));
    const r = await independentValidate({ repoPath: repoOf(core, 'qa-flaky'), sha: b.investigation.commitSha, diff: q.diff, scratch: scratch(), seeds: [4242000, 65537] });
    assert.deepEqual([r.before[0] !== 0, r.after], [true, [0, 0]]);
  });
});

describe('A6: confirmed diagnosis with no validated fix', { skip }, () => {
  test('[A6] a confirmed flaky diagnosis with no possible quarantine reports fix NONE and never claims a fix', { timeout: TIMEOUT }, async () => {
    const b = await investigate(loop, 'qa-flaky-dynamic', overlayRules('qa-flaky-dynamic', { loop: [{ hypothesis_updates: [], decision: 'conclude', action: null, conclusion: 'baseline is sufficient' }] }), 6);
    const inv = b.investigation;
    assert.equal(inv.verdict, 'confirmed');
    assert.equal(inv.confidence.label, 'strong');
    assert.equal(b.patches.length, 0, 'the table-driven test title cannot be quarantined');
    assert.equal(inv.agent.diagnosis, 'CONFIRMED');
    assert.equal(inv.agent.fix, 'NONE');
    assert.ok(b.evidence.some((e) => e.title === 'Outcome: diagnosis CONFIRMED · fix NONE'));
    assert.ok(!b.evidence.some((e) => /^Candidate validated/.test(e.title)));
    assert.ok(!inv.confidence.basis.some((x: string) => /Remediation validated|candidate fix passed/.test(x)));
    await assertIntegrity(b);
  });
});

describe('A7: every remediation candidate rejected', { skip }, () => {
  let b: Bundle;
  test('[A7] model fix, its single retry, and the revert all fail validation → fix REJECTED', { timeout: TIMEOUT }, async () => {
    b = await investigate(loop, 'qa-all-rejected', overlayRules('qa-all-rejected', { patch: ['patchWrong'], retry: ['retryWrong'], loop: [{ hypothesis_updates: [], decision: 'conclude', action: null }] }));
    const inv = b.investigation;
    assert.equal(b.patches.length, 3);
    assert.ok(b.patches.every((p) => p.status === 'failed'), JSON.stringify(b.patches.map((p) => [p.title, p.status])));
    const revert = b.patches.find((p) => p.origin === 'deterministic');
    assert.equal(revert.validation.summary, 'Targeted runs passed but the regression suite failed.');
    assert.equal(inv.agent.fix, 'REJECTED');
    assert.equal(inv.agent.patchRetries, 1);
    assert.notEqual(inv.verdict, 'confirmed', 'a code regression is not confirmed without a validated fix');
    assert.equal(inv.agent.diagnosis, inv.verdict === 'probable' ? 'PROBABLE' : 'INCONCLUSIVE');
    assert.ok(inv.limitations.some((l: string) => /Fix validation: 0 of 3 candidates validated/.test(l)));
    await assertIntegrity(b);
  });

  test('[C8] the retry received the actual failure output of the failed candidate, not the CI log', () => {
    const [retry] = loop.hub.nebius.callsFor('patch-retry');
    assert.ok(retry, 'one retry call');
    const section = retry.user.split('## Actual failing output from that validation run')[1] ?? '';
    assert.match(section, /Received: "\$19\.50"/, 'output produced by running the padEnd candidate in the sandbox');
    assert.match(retry.user, /padEnd\(2, '0'\)/, 'the failed diff is included');
    assert.equal(loop.hub.nebius.callsFor('patch-retry').length, 1, 'retry is limited to one');
  });
});
