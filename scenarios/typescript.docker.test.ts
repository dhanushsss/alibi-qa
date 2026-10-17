/**
 * T1–T7 (TypeScript). Single-package TypeScript projects (Jest + ts-jest) investigated end
 * to end with REAL execution: npm install with lifecycle scripts disabled (network on), then
 * Jest or tsc offline, and fixes validated in fresh workspaces. Only the model is scripted.
 * Validated fixes are re-checked by QA's own Node sandbox from the persisted diff.
 * Needs node:20-bookworm-slim and the npm registry (install step).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { dockerSkipReason, qaEnv, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { describeFailures } from '../scripts/lib/integrity.ts';
import { overlayRules } from '../scripts/lib/model-scripts.ts';
import { independentValidate } from '../scripts/lib/sandbox.ts';

const skip = dockerSkipReason();
const TIMEOUT = 900_000;
const TSC = ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'];
let core: Stack & { stop: () => Promise<void> };
let loop: Stack & { stop: () => Promise<void> };

before(async () => {
  if (skip) return;
  core = await startStack('docker-ts', { runner: 'docker' });
  loop = await startStack('docker-ts-loop', { runner: 'docker', loop: {} });
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

/** Every docker experiment ran offline as uid 1000, after one npm install with lifecycle scripts disabled. */
function assertNodeSandbox(b: Bundle) {
  const ran = b.experiments.filter((e) => e.backend === 'docker' && e.environment);
  assert.ok(ran.length > 0);
  for (const e of ran) {
    assert.equal(e.environment.network, 'none');
    assert.equal(e.environment.user, '1000:1000');
    assert.equal(e.environment.readOnlyRoot, true);
    assert.ok(e.environment.dependencyInstall.length === 1 && e.environment.dependencyInstall[0].exitCode === 0);
    assert.equal(e.command[0], 'node');
    assert.ok(['node_modules/jest/bin/jest.js', 'node_modules/typescript/bin/tsc'].includes(e.command[1]));
  }
}

describe('T1: code regression in a ts-jest project — parent passes, failing commit fails, fix validated', { skip }, () => {
  let b: Bundle;
  test('[T1] both boundary tests fail at the refactor and pass at the parent', { timeout: TIMEOUT }, async () => {
    b = await investigate(core, 'qa-ts-regression', overlayRules('qa-ts-regression', { patch: ['patchCorrect'] }));
    const inv = b.investigation;
    assert.equal(inv.framework, 'jest');
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, 'src/discounts.test.ts');
    assert.deepEqual(reproduce.command.slice(-3), ['--runTestsByPath', '--', 'src/discounts.test.ts']);
    assert.equal(reproduce.status, 'failed');
    assert.deepEqual(reproduce.result.attempts[0].tests.failedNames, ['discountRate applies 10% at exactly $100.00', 'discountRate applies 15% from $250']);
    assert.equal(exp(b, 'repeat').result.failures, 3, 'deterministic');
    const parent = exp(b, 'compare_parent');
    assert.deepEqual([parent.result.passes, parent.result.failures], [3, 0]);
    assert.equal(inference(b, reproduce.id, 'H1'), 'supports');
    assert.equal(inference(b, parent.id, 'H1'), 'supports');
    assert.equal(inv.classification, 'code_regression');
    assertNodeSandbox(b);
    await assertIntegrity(b);
  });

  test('[T1] the model fix validates (targeted 3× + full suite) and is re-checked independently', { timeout: TIMEOUT }, async () => {
    const model = b.patches.find((p) => p.origin === 'model');
    assert.deepEqual(model.files, ['src/discounts.ts']);
    assert.equal(model.status, 'validated', model.validation?.summary);
    assert.equal(b.investigation.verdict, 'confirmed');
    const r = await independentValidate({ repoPath: repoOf(core, 'qa-ts-regression'), sha: b.investigation.commitSha, diff: model.diff, scratch: scratch() });
    assert.deepEqual([r.applied, r.before[0], r.after[0]], [true, 1, 0], r.output.slice(-800));
  });
});

describe('T5 + T6: a fix that fails validation is rejected; test-file edits are blocked', { skip }, () => {
  test('[T6] a first-attempt model patch that edits discounts.test.ts is rejected before it runs; the revert validates', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-ts-regression', overlayRules('qa-ts-regression', { patch: ['patchEditsTest'] }));
    assert.ok(!b.patches.some((p) => p.origin === 'model'));
    assert.ok(b.investigation.limitations.some((l: string) => /Edit to src\/discounts\.test\.ts is outside the files provided to the model: test files are read-only/.test(l)));
    assert.ok(!b.patches.some((p) => p.files.some((f: string) => /\.test\.ts$/.test(f))));
    const revert = b.patches.find((p) => p.origin === 'deterministic');
    assert.deepEqual(revert.files, ['src/discounts.ts']);
    assert.equal(revert.status, 'validated', revert.validation?.summary);
    await assertIntegrity(b);
  });

  test('[T5 + T6] ALIBI_LOOP=1: a wrong fix fails its targeted runs and is rejected; the retry that edits the test is blocked', { timeout: TIMEOUT }, async () => {
    const b = await investigate(loop, 'qa-ts-regression', overlayRules('qa-ts-regression', { patch: ['patchWrong'], retry: ['patchEditsTest'], loop: [{ hypothesis_updates: [], decision: 'conclude', action: null }] }));
    const wrong = b.patches.find((p) => p.origin === 'model');
    assert.equal(wrong.status, 'failed');
    assert.match(wrong.validation.summary, /^Targeted runs: 3\/3 runs failed/);
    assert.equal(loop.hub.nebius.callsFor('patch-retry').length, 1);
    assert.ok(b.investigation.limitations.some((l: string) => /Retry candidate was not usable: Edit to src\/discounts\.test\.ts .*test files are read-only/.test(l)));
    assert.equal(b.patches.find((p) => p.origin === 'deterministic').status, 'validated');
    assert.ok(!b.patches.some((p) => p.status === 'validated' && p.origin !== 'deterministic'));
    await assertIntegrity(b);
  });
});

describe('T2: type-check failure — tsc reproduces, the parent type-checks, a cast-only fix is rejected by the tests', { skip }, () => {
  test('[T2] TS2322 reproduces with tsc; a fix that only silences the compiler fails the Jest suite and is rejected', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-ts-typecheck', overlayRules('qa-ts-typecheck', { patch: ['patchCastOnly'] }));
    const inv = b.investigation;
    assert.equal(inv.framework, 'jest');
    assert.equal(inv.failureSignature, "jest: compilation error at receipt.ts:9 — TS2322: Type 'Money' is not assignable to type 'string'.");
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.testSelection, 'TypeScript type check (tsc --noEmit -p tsconfig.json)');
    assert.deepEqual(reproduce.command, TSC);
    assert.equal(reproduce.result.attempts[0].exitCode, 2);
    assert.equal(reproduce.result.attempts[0].tests, null);
    assert.match(reproduce.result.attempts[0].outputTail, /src\/receipt\.ts\(9,9\): error TS2322/);
    assert.equal(b.experiments.find((e) => e.kind === 'repeat').status, 'skipped');
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true]);
    const cast = b.patches.find((p) => p.origin === 'model');
    assert.equal(cast.status, 'failed', 'passing tsc is not enough');
    assert.equal(cast.validation.summary, 'Targeted runs passed but the regression suite failed.');
    const t = b.experiments.find((e) => e.id === cast.validation.targetedExperimentId);
    const suite = b.experiments.find((e) => e.id === cast.validation.suiteExperimentId);
    assert.deepEqual(t.command, TSC);
    assert.deepEqual(passed(t), [true, true, true]);
    assert.equal(suite.kind, 'regression_suite');
    assert.match(suite.result.attempts[0].outputTail, /\[object Object\]/);
    assert.equal(b.patches.find((p) => p.origin === 'deterministic').status, 'validated', 'the revert of money.ts passes tsc and Jest');
    assertNodeSandbox(b);
    await assertIntegrity(b);
  });

  test('[T2] a real fix passes tsc and the Jest suite and is re-checked independently', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-ts-typecheck', overlayRules('qa-ts-typecheck', { patch: ['patchCorrect'] }));
    const model = b.patches.find((p) => p.origin === 'model');
    assert.deepEqual(model.files, ['src/receipt.ts']);
    assert.equal(model.status, 'validated', model.validation?.summary);
    assert.notEqual(model.validation.suiteExperimentId, model.validation.targetedExperimentId, 'the suite ran after the type check');
    const r = await independentValidate({ repoPath: repoOf(core, 'qa-ts-typecheck'), sha: b.investigation.commitSha, diff: model.diff, scratch: scratch() });
    assert.deepEqual([r.applied, r.after[0]], [true, 0], r.output.slice(-800));
  });
});

describe('T3: flaky test — bounded seeded repeats observe the intermittency', { skip }, () => {
  test('[T3] repeated offline runs alternate as the leaked state predicts; the quarantine validates', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-ts-flaky', overlayRules('qa-ts-flaky'), 6);
    assert.deepEqual(passed(exp(b, 'reproduce')), [true]);
    const repeat = exp(b, 'repeat');
    assert.equal(repeat.result.attempts.length, 6);
    assert.deepEqual(passed(repeat), [false, true, false, true, false, true]);
    assert.ok(repeat.result.attempts.every((a: any) => typeof a.seed === 'number'), 'Jest seeds recorded');
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true, false, true]);
    assert.equal(b.investigation.classification, 'flaky_test');
    const q = b.patches.find((p) => p.strategy === 'quarantine');
    assert.equal(q.status, 'validated', q.validation?.summary);
    assert.deepEqual(q.files, ['src/session.test.ts']);
    assert.match(q.diff, /^\+test\.skip\('starts without an active session'/m);
    assertNodeSandbox(b);
    await assertIntegrity(b);
  });
});

describe('T4: dependency incompatibility — nanoid 5 is ESM-only; a wrong bump fails; the pin validates', { skip }, () => {
  test('[T4] the load error reproduces offline; nanoid 4 is rejected; the pin back to 3.3.7 validates', { timeout: TIMEOUT }, async () => {
    const b = await investigate(core, 'qa-ts-dependency', overlayRules('qa-ts-dependency', { patch: ['patchWrongDep'] }));
    const inv = b.investigation;
    assert.equal(inv.classification, 'dependency_regression');
    assert.ok(b.evidence.some((e) => e.title === 'Dependency change: nanoid 3.3.7 → 5.0.7'));
    const reproduce = exp(b, 'reproduce');
    assert.equal(reproduce.status, 'failed');
    assert.match(reproduce.result.attempts[0].outputTail, /Cannot use import statement outside a module/);
    assert.deepEqual(passed(exp(b, 'compare_parent')), [true, true, true]);
    const [first, second] = b.patches;
    assert.equal(first.origin, 'model');
    assert.deepEqual(first.files, ['package.json']);
    assert.equal(first.status, 'failed');
    assert.equal(second.title, 'Pin nanoid back to 3.3.7');
    assert.equal(second.status, 'validated', second.validation?.summary);
    assert.equal(inv.verdict, 'confirmed');
    const r = await independentValidate({ repoPath: repoOf(core, 'qa-ts-dependency'), sha: inv.commitSha, diff: second.diff, scratch: scratch() });
    assert.deepEqual([r.applied, r.before[0], r.after[0]], [true, 1, 0], r.output.slice(-800));
    await assertIntegrity(b);
  });
});

describe('T7: unsupported TypeScript layouts return an explicit, safe outcome', { skip }, () => {
  for (const [id, why] of [
    ['qa-ts-unsupported-workspaces', /Monorepos are not supported \(npm\/yarn workspaces/],
    ['qa-ts-unsupported-notransform', /Jest is not configured to compile TypeScript/],
  ] as const) {
    test(`[T7] ${id}: nothing is installed or run, and the reason is recorded`, { timeout: TIMEOUT }, async () => {
      const b = await investigate(core, id, overlayRules(id));
      const inv = b.investigation;
      assert.equal(inv.status, 'inconclusive');
      assert.equal(inv.framework, 'jest');
      assert.ok(b.experiments.every((e) => !e.result && !e.environment), 'no sandbox experiment ran');
      const reproduce = b.experiments.find((e) => e.kind === 'reproduce');
      assert.equal(reproduce.status, 'skipped');
      assert.match(reproduce.reason, /^Unsupported TypeScript project layout: /);
      assert.match(reproduce.reason, why);
      assert.equal(b.patches.length, 0);
      assert.notEqual(inv.verdict, 'confirmed');
      await assertIntegrity(b);
    });
  }
});
