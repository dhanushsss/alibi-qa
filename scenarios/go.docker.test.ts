/**
 * G1–G7 (Go). Go modules investigated end to end with REAL execution: the server builds
 * the QA overlay repositories with git, downloads modules from the public proxy in its
 * pinned Go sandbox (network only during `go mod download`), runs `go test -json` /
 * `go build` offline, and validates fixes in fresh workspaces. Only the model is scripted.
 * Validated fixes are re-checked by QA's own Go sandbox from the persisted diff.
 * Needs the pinned Go image and proxy.golang.org (dependency download step).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadQaConfig, QA_ROOT } from '../scripts/lib/config.ts';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { run } from '../scripts/lib/exec.ts';
import { dockerSkipReason, qaEnv, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { describeFailures } from '../scripts/lib/integrity.ts';
import { overlayRules } from '../scripts/lib/model-scripts.ts';
import { independentValidateGo } from '../scripts/lib/sandbox.ts';

const skip = dockerSkipReason();
const TIMEOUT = 900_000;
const IMAGE = loadQaConfig().docker.goImage;
const VERSIONS = JSON.parse(readFileSync(join(QA_ROOT, 'scenarios/overlays/qa-go-dependency/versions.json'), 'utf8'));
let core: Stack & { stop: () => Promise<void> };
let loop: Stack & { stop: () => Promise<void> };

before(async () => {
  if (skip) return;
  const img = await run('docker', ['image', 'inspect', IMAGE]);
  if (img.code !== 0) throw new Error(`${IMAGE} is not present locally (docker pull it first)`);
  core = await startStack('docker-go', { runner: 'docker' });
  loop = await startStack('docker-go-loop', { runner: 'docker', loop: {} });
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

/** Every docker experiment ran the pinned Go image offline, as uid 1000, after one `go mod download`. */
function assertGoSandbox(b: Bundle) {
  const ran = b.experiments.filter((e) => e.backend === 'docker' && e.environment);
  assert.ok(ran.length > 0);
  for (const e of ran) {
    assert.equal(e.environment.image, IMAGE);
    assert.equal(e.environment.network, 'none');
    assert.equal(e.environment.user, '1000:1000');
    assert.equal(e.environment.readOnlyRoot, true);
    assert.ok(e.environment.dependencyInstall.length === 1 && e.environment.dependencyInstall[0].exitCode === 0, 'one go mod download, successful');
    assert.equal(e.command[0], 'go');
    assert.ok(['test', 'build'].includes(e.command[1]));
  }
}

describe('G1: code regression — parent passes, failing commit fails, fix validated', { skip }, () => {
  let b: Bundle;
  test('[G1] the failing subtest reproduces offline and the parent passes; results come from go test -json', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-go-regression', overlayRules('qa-go-regression', { patch: ['patchCorrect'] }));
    const inv = b.investigation;
    assert.equal(inv.framework, 'go');
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, './... › TestShippingCents/exactly_1kg');
    assert.deepEqual(reproduce.command.slice(-3), ['-run', '^TestShippingCents$/^exactly_1kg$', './...'], 'log-derived name becomes a validated, anchored -run pattern');
    assert.equal(reproduce.status, 'failed');
    assert.deepEqual(reproduce.result.attempts[0].tests, { total: 1, passed: 0, failed: 1, failedNames: ['example.com/qa/shipping/rates TestShippingCents/exactly_1kg'] });
    assert.match(reproduce.result.attempts[0].outputTail, /ShippingCents\(1\) = 899, want 499/);
    const repeat = exp(b, 'repeat');
    assert.equal(repeat.result.failures, 3, 'deterministic');
    assert.ok(repeat.result.attempts.every((a: any) => typeof a.seed === 'number'), 'each repeat is replayable');
    assert.ok(repeat.command.some((c: string) => /^-shuffle=\d+$/.test(c)));
    const parent = exp(b, 'compare_parent');
    assert.equal(parent.commitSha, inv.parentSha);
    assert.deepEqual([parent.result.passes, parent.result.failures], [3, 0]);
    assert.equal(inference(b, reproduce.id, 'H1'), 'supports');
    assert.equal(inference(b, parent.id, 'H1'), 'supports');
    assert.equal(inference(b, repeat.id, 'H2'), 'contradicts');
    assert.equal(inv.classification, 'code_regression');
    assert.match(inv.failureSignature, /^go: TestShippingCents\/exactly_1kg — rates_test\.go:24: ShippingCents\(1\) = 899, want 499/);
    assertGoSandbox(b);
    await assertIntegrity(b);
  });

  test('[G1] the model fix validates in a fresh sandbox (targeted 3× + go test ./...) and is re-checked independently', { timeout: TIMEOUT }, async () => {
    const model = b.patches.find((p) => p.origin === 'model');
    assert.deepEqual(model.files, ['rates/rates.go']);
    assert.equal(model.status, 'validated', model.validation?.summary);
    const t = b.experiments.find((e) => e.id === model.validation.targetedExperimentId);
    const suite = b.experiments.find((e) => e.id === model.validation.suiteExperimentId);
    assert.deepEqual(passed(t), [true, true, true]);
    assert.equal(suite.kind, 'regression_suite');
    assert.deepEqual(suite.command.slice(-1), ['./...']);
    assert.deepEqual(suite.result.attempts[0].tests, { total: 6, passed: 6, failed: 0, failedNames: [] });
    assert.equal(b.investigation.verdict, 'confirmed');
    const r = await independentValidateGo({ repoPath: repoOf(core, 'qa-go-regression'), sha: b.investigation.commitSha, diff: model.diff, scratch: scratch(), image: IMAGE });
    assert.deepEqual([r.applied, r.before[0], r.after[0]], [true, 1, 0], r.output.slice(-800));
  });
});

describe('G5 + G6: a fix that fails validation is rejected; test-file edits are blocked', { skip }, () => {
  test('[G6] a first-attempt model patch that edits rates_test.go is rejected before it runs; the revert validates', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-go-regression', overlayRules('qa-go-regression', { patch: ['patchEditsTest'] }));
    assert.ok(!b.patches.some((p) => p.origin === 'model'), 'no patch was created from the test edit');
    assert.ok(b.investigation.limitations.some((l: string) => /Edit to rates\/rates_test\.go is outside the files provided to the model: test files are read-only/.test(l)));
    assert.ok(!b.patches.some((p) => p.files.some((f: string) => f.endsWith('_test.go'))), 'no persisted patch touches a _test.go file');
    const revert = b.patches.find((p) => p.origin === 'deterministic');
    assert.deepEqual(revert.files, ['rates/rates.go']);
    assert.equal(revert.status, 'validated', revert.validation?.summary);
    assert.equal(core.hub.nebius.callsFor('patch-retry').length, 0, 'loop off: no retry');
    await assertIntegrity(b);
  });

  test('[G5 + G6] ALIBI_LOOP=1: a wrong fix fails the regression suite and is rejected; the retry that edits the test is blocked', { timeout: TIMEOUT }, async () => {
    const b = await investigate(loop, 'qa-go-regression', overlayRules('qa-go-regression', { patch: ['patchWrong'], retry: ['patchEditsTest'], loop: [{ hypothesis_updates: [], decision: 'conclude', action: null }] }));
    const wrong = b.patches.find((p) => p.origin === 'model');
    assert.equal(wrong.status, 'failed', 'inclusive bounds break the 20 kg rate');
    assert.equal(wrong.validation.summary, 'Targeted runs passed but the regression suite failed.');
    const suite = b.experiments.find((e) => e.id === wrong.validation.suiteExperimentId);
    assert.deepEqual(suite.result.attempts[0].tests.failedNames, ['example.com/qa/shipping/rates TestShippingCents/exactly_20kg']);
    assert.equal(loop.hub.nebius.callsFor('patch-retry').length, 1, 'exactly one retry');
    assert.ok(!b.patches.some((p) => /^Retry:/.test(p.title)), 'the retry never became a patch');
    assert.ok(b.investigation.limitations.some((l: string) => /Retry candidate was not usable: Edit to rates\/rates_test\.go .*test files are read-only/.test(l)));
    assert.equal(b.investigation.agent.patchRetries, 1);
    assert.equal(b.patches.find((p) => p.origin === 'deterministic').status, 'validated');
    assert.ok(!b.patches.some((p) => p.status === 'validated' && p.origin !== 'deterministic'), 'the rejected fix is never reported as validated');
    await assertIntegrity(b);
  });
});

describe('G2: compiler failure — go build reproduces, the parent builds, the fix passes build and tests', { skip }, () => {
  test('[G2] the undefined symbol reproduces with go build; repeats are skipped; the fix also runs go test ./...', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-go-build', overlayRules('qa-go-build', { patch: ['patchCorrect'] }));
    const inv = b.investigation;
    assert.equal(inv.framework, 'go');
    assert.match(inv.failureSignature, /^go: compilation error at report\.go:12 — undefined: stock\.Available/);
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, 'Go build (go build ./...)');
    assert.deepEqual(reproduce.command, ['go', 'build', './...']);
    assert.equal(reproduce.status, 'failed');
    assert.equal(reproduce.result.attempts[0].tests, null, 'a build has no test counts');
    assert.match(reproduce.result.attempts[0].outputTail, /report\/report\.go:12:\d+: undefined: stock\.Available/);
    assert.equal(b.experiments.find((e) => e.kind === 'repeat').status, 'skipped', 'compile errors are deterministic');
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true]);
    const model = b.patches.find((p) => p.origin === 'model');
    assert.deepEqual(model.files, ['report/report.go']);
    assert.equal(model.status, 'validated', model.validation?.summary);
    const t = b.experiments.find((e) => e.id === model.validation.targetedExperimentId);
    const suite = b.experiments.find((e) => e.id === model.validation.suiteExperimentId);
    assert.deepEqual(t.command, ['go', 'build', './...']);
    assert.notEqual(suite.id, t.id, 'a build check is followed by the test suite');
    assert.equal(suite.kind, 'regression_suite');
    assert.equal(suite.result.attempts[0].tests.failed, 0);
    assert.equal(inv.classification, 'code_regression');
    assertGoSandbox(b);
    await assertIntegrity(b);
  });
});

describe('G3: flaky test — bounded repeats with -shuffle seeds observe the intermittency', { skip }, () => {
  let b: Bundle;
  test('[G3] repeated offline runs alternate exactly as the leaked state predicts', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-go-flaky', overlayRules('qa-go-flaky'), 6);
    assert.deepEqual(passed(exp(b, 'reproduce')), [true], 'run 1 in a fresh checkout passes');
    const repeat = exp(b, 'repeat');
    assert.equal(repeat.plannedAttempts, 6);
    assert.equal(repeat.result.attempts.length, 6, 'bounded: exactly the requested repeats');
    assert.deepEqual(passed(repeat), [false, true, false, true, false, true]);
    assert.deepEqual(repeat.result.attempts.map((a: any) => a.seed), [1, 2, 3, 4, 5, 6].map((i) => i * 65537), 'replayable shuffle seeds');
    assert.match(repeat.reason, /-shuffle seed for test order; the seed does not fix timing or math\/rand/);
    assert.deepEqual([repeat.result.failureRate.n, repeat.result.failureRate.rate], [6, 0.5]);
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true, false, true], 'the parent is just as flaky');
    assert.equal(b.investigation.classification, 'flaky_test');
    assertGoSandbox(b);
    await assertIntegrity(b);
  });

  test('[G3] the quarantine adds t.Skip to only the flaky test and validates over repeated runs', { timeout: TIMEOUT }, async () => {
    const q = b.patches.find((p) => p.strategy === 'quarantine');
    assert.ok(q, 'quarantine candidate created (test file found by its declaration)');
    assert.equal(q.status, 'validated', q.validation?.summary);
    assert.deepEqual(q.files, ['session/session_test.go']);
    assert.match(q.diff, /^\+\tt\.Skip\("Quarantined by \w+ \(investigation inv_[\w-]+\): failed 3\/6 /m);
    assert.equal((q.diff.match(/t\.Skip\(/g) ?? []).length, 1);
    const t = b.experiments.find((e) => e.id === q.validation.targetedExperimentId);
    assert.equal(t.result.attempts.length, 6);
    assert.ok(t.result.attempts.every((a: any) => a.passed));
    const r = await independentValidateGo({ repoPath: repoOf(core, 'qa-go-flaky'), sha: b.investigation.commitSha, diff: q.diff, scratch: scratch(), image: IMAGE, runs: 2 });
    assert.deepEqual([r.before, r.after], [[0, 1], [0, 0]], r.output.slice(-600));
  });
});

describe('G4: dependency incompatibility — a newer version fails, the pin back (go.mod + go.sum) validates', { skip }, () => {
  test('[G4] the build failure reproduces offline; the model bump is rejected; the pin validates and is re-checked independently', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-go-dependency', overlayRules('qa-go-dependency', { patch: ['patchWrongDep'] }));
    const inv = b.investigation;
    assert.equal(inv.classification, 'dependency_regression');
    assert.ok(b.evidence.some((e) => e.title === `Dependency change: golang.org/x/exp ${VERSIONS.old} → ${VERSIONS.new}`));
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, 'all packages (go test ./...)', 'tests did not build, so go test ./... reproduces');
    assert.equal(reproduce.result.attempts[0].tests, null);
    assert.match(reproduce.result.attempts[0].outputTail, /does not match inferred type func\(a Task, b Task\) int/);
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true]);
    const [first, second] = b.patches;
    assert.equal(first.origin, 'model');
    assert.deepEqual([...first.files].sort(), ['go.mod', 'go.sum']);
    assert.equal(first.status, 'failed', 'the newer x/exp still has the cmp signature');
    assert.equal(second.strategy, 'dependency_pin');
    assert.equal(second.title, `Pin golang.org/x/exp back to ${VERSIONS.old}`);
    assert.deepEqual([...second.files].sort(), ['go.mod', 'go.sum']);
    assert.equal(second.status, 'validated', second.validation?.summary);
    assert.equal(inv.verdict, 'confirmed');
    assertGoSandbox(b);
    const r = await independentValidateGo({ repoPath: repoOf(core, 'qa-go-dependency'), sha: inv.commitSha, diff: second.diff, scratch: scratch(), image: IMAGE });
    assert.deepEqual([r.applied, r.before[0], r.after[0]], [true, 1, 0], r.output.slice(-800));
    await assertIntegrity(b);
  });
});

describe('G7: unsupported Go layouts return an explicit, safe outcome', { skip }, () => {
  for (const [id, why] of [
    ['qa-go-unsupported-work', /Go workspaces \(go\.work\) are not supported/],
    ['qa-go-unsupported-replace', /go\.mod replaces a module with a local path \(\.\.\/shared\)/],
  ] as const) {
    test(`[G7] ${id}: nothing is installed or run, and the reason is recorded`, { timeout: TIMEOUT }, async () => {
      const b = await investigate(core, id, overlayRules(id));
      const inv = b.investigation;
      assert.equal(inv.status, 'inconclusive', 'no discriminating experiment could run');
      assert.equal(inv.framework, 'go');
      assert.ok(b.experiments.every((e) => !e.result && !e.environment), 'no sandbox experiment ran');
      const reproduce = b.experiments.find((e) => e.kind === 'reproduce');
      assert.equal(reproduce.status, 'skipped');
      assert.match(reproduce.reason, /^Unsupported Go project layout: /);
      assert.match(reproduce.reason, why);
      assert.match(reproduce.reason, /No dependencies were installed and no tests were run/);
      assert.ok(inv.limitations.some((l: string) => why.test(l)));
      assert.equal(b.patches.length, 0);
      assert.notEqual(inv.verdict, 'confirmed', 'no claim beyond log and diff analysis');
      await assertIntegrity(b);
    });
  }
});
