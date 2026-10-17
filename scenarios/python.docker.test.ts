/**
 * P1–P6 (pytest). Python projects investigated end to end with REAL execution:
 * Alibi builds the QA overlay repositories with git, installs dependencies with
 * pip in its pinned Python sandbox (network only during install), runs pytest
 * offline, and validates fixes in fresh workspaces. Only the model is scripted.
 * Validated fixes are re-checked by QA's own pytest sandbox from the persisted diff.
 * Needs the pinned Python image and PyPI (dependency install step).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadQaConfig } from '../scripts/lib/config.ts';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { run } from '../scripts/lib/exec.ts';
import { dockerSkipReason, qaEnv, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { describeFailures } from '../scripts/lib/integrity.ts';
import { overlayRules } from '../scripts/lib/model-scripts.ts';
import { independentValidatePytest } from '../scripts/lib/sandbox.ts';

const skip = dockerSkipReason();
const TIMEOUT = 900_000;
const IMAGE = loadQaConfig().docker.pythonImage;
let core: Stack & { stop: () => Promise<void> };
let loop: Stack & { stop: () => Promise<void> };

before(async () => {
  if (skip) return;
  const img = await run('docker', ['image', 'inspect', IMAGE]);
  if (img.code !== 0) throw new Error(`${IMAGE} is not present locally (docker pull it first)`);
  core = await startStack('docker-python', { runner: 'docker' });
  loop = await startStack('docker-python-loop', { runner: 'docker', loop: {} });
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
const passed = (e: any) => e.result.attempts.map((a: any) => a.passed);

async function assertIntegrity(b: Bundle) {
  const bad = await integrityFailures(b);
  assert.equal(bad.length, 0, describeFailures(bad));
}

/** Every docker experiment ran the pinned Python image offline, as uid 1000, with pip only in the install step. */
function assertPythonSandbox(b: Bundle) {
  const ran = b.experiments.filter((e) => e.backend === 'docker' && e.environment);
  assert.ok(ran.length > 0);
  for (const e of ran) {
    assert.equal(e.environment.image, IMAGE);
    assert.equal(e.environment.network, 'none');
    assert.equal(e.environment.user, '1000:1000');
    assert.equal(e.environment.readOnlyRoot, true);
    assert.ok(e.environment.dependencyInstall.length === 2 && e.environment.dependencyInstall.every((i: any) => i.exitCode === 0), 'venv + pip install');
    assert.deepEqual(e.command.slice(0, 3), ['/work/.alibi/venv/bin/python', '-m', 'pytest']);
  }
}

describe('P1: code regression — parent passes, failing commit fails, fix validated', { skip }, () => {
  let b: Bundle;
  test('[P1] the failing commit fails and the parent passes, reported as pytest node ids', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-py-regression', overlayRules('qa-py-regression', { patch: ['patchCorrect'] }));
    const inv = b.investigation;
    assert.equal(inv.framework, 'pytest');
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, 'tests/test_rates.py::test_small_parcel_up_to_and_including_1kg');
    assert.equal(reproduce.command.at(-1), 'tests/test_rates.py::test_small_parcel_up_to_and_including_1kg');
    assert.equal(reproduce.command.at(-2), '--', 'the node id is positional');
    assert.equal(reproduce.status, 'failed');
    assert.equal(reproduce.result.attempts[0].exitCode, 1);
    assert.deepEqual(reproduce.result.attempts[0].tests, { total: 1, passed: 0, failed: 1, failedNames: ['tests/test_rates.py::test_small_parcel_up_to_and_including_1kg'] });
    assert.match(reproduce.result.attempts[0].outputTail, /E\s+assert 899 == 499/, 'assertion output retained');
    assert.equal(exp(b, 'repeat').result.failures, 3, 'deterministic');
    const parent = exp(b, 'compare_parent');
    assert.equal(parent.commitSha, inv.parentSha);
    assert.deepEqual([parent.result.passes, parent.result.failures], [3, 0]);
    assert.equal(inference(b, reproduce.id, 'H1'), 'supports');
    assert.equal(inference(b, parent.id, 'H1'), 'supports');
    assert.equal(inference(b, exp(b, 'repeat').id, 'H2'), 'contradicts');
    assert.equal(inv.classification, 'code_regression');
    assert.match(inv.failureSignature, /^pytest: tests\/test_rates\.py › test_small_parcel_up_to_and_including_1kg — assert 899 == 499/);
    assertPythonSandbox(b);
    await assertIntegrity(b);
  });

  test('[P1] the model fix validates in a fresh sandbox (targeted 3× + full suite) and the verdict is confirmed', { timeout: TIMEOUT }, async () => {
    const model = b.patches.find((p) => p.origin === 'model');
    assert.deepEqual(model.files, ['shipping/rates.py']);
    assert.equal(model.status, 'validated', model.validation?.summary);
    const t = b.experiments.find((e) => e.id === model.validation.targetedExperimentId);
    const suite = b.experiments.find((e) => e.id === model.validation.suiteExperimentId);
    assert.deepEqual(passed(t), [true, true, true]);
    assert.equal(suite.kind, 'regression_suite');
    assert.deepEqual(suite.result.attempts[0].tests, { total: 5, passed: 5, failed: 0, failedNames: [] });
    assert.equal(b.investigation.verdict, 'confirmed');
    const r = await independentValidatePytest({ repoPath: repoOf(core, 'qa-py-regression'), sha: b.investigation.commitSha, diff: model.diff, scratch: scratch(), image: IMAGE });
    assert.deepEqual([r.applied, r.before[0], r.after[0]], [true, 1, 0], r.output.slice(-800));
  });
});

describe('P4 + P5: a fix that fails validation is rejected; test-file edits are blocked on the first attempt', { skip }, () => {
  test('[P5] a first-attempt model patch that edits the test is rejected before it runs; the revert validates', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-py-regression', overlayRules('qa-py-regression', { patch: ['patchEditsTest'] }));
    assert.ok(!b.patches.some((p) => p.origin === 'model'), 'no patch was created from the test edit');
    assert.ok(b.investigation.limitations.some((l: string) => /Edit to tests\/test_rates\.py is outside the files provided to the model: test files are read-only/.test(l)));
    assert.ok(b.evidence.some((e) => /^Candidate rejected: Targeted fix/.test(e.title) && e.provenance.type === 'policy'));
    assert.ok(!b.patches.some((p) => p.files.some((f: string) => f.startsWith('tests/'))), 'no persisted patch touches tests');
    const revert = b.patches.find((p) => p.origin === 'deterministic');
    assert.deepEqual(revert.files, ['shipping/rates.py']);
    assert.equal(revert.status, 'validated', revert.validation?.summary);
    assert.equal(core.hub.nebius.callsFor('patch-retry').length, 0, 'loop off: no retry');
    await assertIntegrity(b);
  });

  test('[P4 + P5] ALIBI_LOOP=1: a wrong fix fails the regression suite and is rejected; the retry that edits the test is blocked', { timeout: TIMEOUT }, async () => {
    const b = await investigate(loop, 'qa-py-regression', overlayRules('qa-py-regression', { patch: ['patchWrong'], retry: ['patchEditsTest'], loop: [{ hypothesis_updates: [], decision: 'conclude', action: null }] }));
    const wrong = b.patches.find((p) => p.origin === 'model');
    assert.equal(wrong.status, 'failed', 'the inclusive-bounds patch breaks the 20 kg rate');
    assert.equal(wrong.validation.summary, 'Targeted runs passed but the regression suite failed.');
    const suite = b.experiments.find((e) => e.id === wrong.validation.suiteExperimentId);
    assert.deepEqual(suite.result.attempts[0].tests.failedNames, ['tests/test_rates.py::TestLargeParcels::test_large_rate[20]']);
    assert.equal(loop.hub.nebius.callsFor('patch-retry').length, 1, 'exactly one retry');
    assert.ok(!b.patches.some((p) => /^Retry:/.test(p.title)), 'the retry never became a patch');
    assert.ok(b.investigation.limitations.some((l: string) => /Retry candidate was not usable: Edit to tests\/test_rates\.py .*test files are read-only/.test(l)));
    assert.equal(b.investigation.agent.patchRetries, 1);
    const revert = b.patches.find((p) => p.origin === 'deterministic');
    assert.equal(revert.status, 'validated');
    assert.ok(!b.patches.some((p) => p.status === 'validated' && p.origin !== 'deterministic'), 'the rejected fix is never reported as validated');
    await assertIntegrity(b);
  });
});

describe('P2: flaky test — bounded repeats observe the intermittency', { skip }, () => {
  let b: Bundle;
  test('[P2] repeated offline runs alternate exactly as the leaked state predicts', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-py-flaky', overlayRules('qa-py-flaky'), 6);
    // Oracle: within one checkout, run k fails iff a previous run left .session-cache behind (k even).
    const reproduce = exp(b, 'reproduce');
    assert.deepEqual(passed(reproduce), [true], 'run 1 in a fresh checkout passes');
    const repeat = exp(b, 'repeat');
    assert.equal(repeat.plannedAttempts, 6);
    assert.equal(repeat.result.attempts.length, 6, 'bounded: exactly the requested repeats');
    assert.deepEqual(passed(repeat), [false, true, false, true, false, true]);
    assert.ok(repeat.result.attempts.every((a: any) => a.seed === undefined), 'pytest runs carry no seed');
    assert.match(repeat.reason, /pytest has no seed option/);
    const fr = repeat.result.failureRate;
    assert.deepEqual([fr.n, fr.rate], [6, 0.5]);
    assert.ok(fr.low < fr.rate && fr.rate < fr.high);
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true, false, true], 'the parent is just as flaky');
    assert.equal(b.investigation.classification, 'flaky_test');
    assertPythonSandbox(b);
    await assertIntegrity(b);
  });

  test('[P2] the quarantine adds a pytest skip marker to only the flaky test and validates over repeated runs', { timeout: TIMEOUT }, async () => {
    const q = b.patches.find((p) => p.strategy === 'quarantine');
    assert.ok(q, 'quarantine candidate created');
    assert.equal(q.status, 'validated', q.validation?.summary);
    assert.deepEqual(q.files, ['tests/test_sessions.py']);
    assert.match(q.diff, /^\+import pytest$/m);
    assert.match(q.diff, /^\+@pytest\.mark\.skip\(reason="Quarantined by Zerqis \(investigation inv_[\w-]+\): failed 3\/6 /m);
    assert.equal((q.diff.match(/@pytest\.mark\.skip/g) ?? []).length, 1);
    const t = b.experiments.find((e) => e.id === q.validation.targetedExperimentId);
    assert.equal(t.result.attempts.length, 6);
    assert.ok(t.result.attempts.every((a: any) => a.passed && a.tests.total === 1), 'the remaining test runs each time; the flaky one is skipped');
    const r = await independentValidatePytest({ repoPath: repoOf(core, 'qa-py-flaky'), sha: b.investigation.commitSha, diff: q.diff, scratch: scratch(), image: IMAGE, runs: 2 });
    assert.deepEqual([r.before, r.after], [[0, 1], [0, 0]], r.output.slice(-600));
  });
});

describe('P3: dependency incompatibility — a wrong version fails, the version change back validates', { skip }, () => {
  let b: Bundle;
  test('[P3] the import error reproduces offline; the model version change fails; the pin validates', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-py-dependency', overlayRules('qa-py-dependency', { patch: ['patchWrongDep'] }));
    const inv = b.investigation;
    assert.equal(inv.classification, 'dependency_regression');
    assert.ok(b.evidence.some((e) => e.title === 'Dependency change: packaging 21.3 → 24.1'));
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, 'tests/test_tags.py');
    assert.equal(reproduce.result.attempts[0].exitCode, 2, 'pytest: interrupted by a collection error');
    assert.deepEqual(reproduce.result.attempts[0].tests.failedNames, ['tests/test_tags.py: collection error']);
    assert.match(reproduce.result.attempts[0].outputTail, /cannot import name 'LegacyVersion'/);
    assert.deepEqual([exp(b, 'compare_parent').result.failures, exp(b, 'compare_parent').result.passes], [0, 3]);
    const [first, second] = b.patches;
    assert.equal(first.origin, 'model');
    assert.deepEqual(first.files, ['requirements.txt']);
    assert.equal(first.status, 'failed', 'packaging 22.0 also lacks LegacyVersion');
    assert.match(first.validation.summary, /Targeted runs: 3\/3 runs failed/);
    assert.equal(second.strategy, 'dependency_pin');
    assert.equal(second.title, 'Pin packaging back to 21.3');
    assert.match(second.diff, /^-packaging==24\.1\n\+packaging==21\.3$/m);
    assert.equal(second.status, 'validated', second.validation?.summary);
    const seq = (title: string) => b.evidence.find((e) => e.title === title)?.seq ?? -1;
    assert.ok(seq(`Candidate failed validation: ${first.title}`) < seq(`Candidate validated: ${second.title}`));
    assert.equal(inv.remediationType, 'dependency_pin');
    assert.equal(inv.verdict, 'confirmed');
    assertPythonSandbox(b);
    await assertIntegrity(b);
  });

  test('[P3] QA independently confirms the version change', { timeout: TIMEOUT }, async () => {
    const pin = b.patches.find((p) => p.strategy === 'dependency_pin');
    const r = await independentValidatePytest({ repoPath: repoOf(core, 'qa-py-dependency'), sha: b.investigation.commitSha, diff: pin.diff, scratch: scratch(), image: IMAGE });
    assert.deepEqual([r.applied, r.before[0], r.after[0]], [true, 2, 0], r.output.slice(-600));
  });
});

describe('P6: unsupported Python layouts return an explicit, safe outcome', { skip }, () => {
  for (const [id, why] of [
    ['qa-py-unsupported-poetry', /Dependencies are declared with Poetry, which Zerqis does not install/],
    ['qa-py-unsupported-vcs', /requirements\.txt line 2: URL, VCS, and local-path requirements are not allowed/],
  ] as const) {
    test(`[P6] ${id}: nothing is installed or run, and the reason is recorded`, { timeout: TIMEOUT }, async () => {
      const b = await investigate(core, id, overlayRules(id));
      const inv = b.investigation;
      assert.equal(inv.status, 'inconclusive', 'no discriminating experiment could run');
      assert.equal(inv.framework, 'pytest');
      assert.ok(b.experiments.every((e) => e.status === 'skipped' || e.backend !== 'docker'), 'no sandbox experiment ran');
      assert.ok(b.experiments.every((e) => !e.result && !e.environment));
      const reproduce = b.experiments.find((e) => e.kind === 'reproduce');
      assert.equal(reproduce.status, 'skipped');
      assert.match(reproduce.reason, /^Unsupported Python project layout: /);
      assert.match(reproduce.reason, why);
      assert.match(reproduce.reason, /No dependencies were installed and no tests were run/);
      assert.ok(inv.limitations.some((l: string) => why.test(l)));
      assert.ok(b.evidence.some((e) => e.title === 'No experiments executed' && why.test(e.detail)));
      assert.equal(b.patches.length, 0);
      assert.notEqual(inv.verdict, 'confirmed', 'no claim beyond log and diff analysis');
      assert.equal(core.hub.nebius.unscripted().length, 0);
      await assertIntegrity(b);
    });
  }
});
