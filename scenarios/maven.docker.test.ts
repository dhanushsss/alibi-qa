/**
 * A2 (Maven). Alibi's built-in maven-dependency scenario (Guava 20.0 → 21.0) with
 * REAL Maven execution in the sandbox: compile failure reproduced offline, parent
 * passes, and both the dependency pin (which must be installed before the build)
 * and a model-written migration are validated in fresh workspaces. Only the model
 * is scripted. Needs the Maven image and Maven Central (dependency install step).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { integrityFailures } from '../scripts/lib/evidence-path.ts';
import { dockerSkipReason, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { describeFailures } from '../scripts/lib/integrity.ts';
import { overlayRules } from '../scripts/lib/model-scripts.ts';
import { run } from '../scripts/lib/exec.ts';

const skip = dockerSkipReason();
let s: Stack & { stop: () => Promise<void> };
let b: Bundle;

describe('A2 (Maven): Guava upgrade breaks compilation', { skip }, () => {
  before(async () => {
    const img = await run('docker', ['image', 'inspect', 'maven:3.9-eclipse-temurin-17']);
    if (img.code !== 0) throw new Error('maven:3.9-eclipse-temurin-17 is not present locally (docker pull it first)');
    s = await startStack('docker-maven', { runner: 'docker', env: { ALIBI_RUNNER_INSTALL_TIMEOUT_SEC: '900' } });
    s.hub.nebius.script(overlayRules('maven-dependency', { patch: ['patchMigrate'] }));
    const r = await s.api.post('/api/investigations/demo', { scenarioId: 'maven-dependency', mode: 'live', repeat: 3 });
    assert.equal(r.status, 202, r.text);
    b = await waitForInvestigation(s.api, r.json.id, 1_500_000);
  });
  after(async () => s?.stop());

  test('[A2] the compile failure reproduces offline and the parent builds and passes', () => {
    assert.notEqual(b.investigation.status, 'failed', b.investigation.error);
    const reproduce = b.experiments.find((e) => e.kind === 'reproduce');
    assert.equal(reproduce.status, 'failed');
    assert.equal(reproduce.result.attempts[0].tests, null, 'build failed before tests ran');
    assert.equal(b.experiments.find((e) => e.kind === 'repeat').status, 'skipped', 'compile errors are deterministic');
    const parent = b.experiments.find((e) => e.kind === 'compare_parent');
    assert.equal(parent.result.failures, 0);
    assert.equal(parent.result.attempts[0].tests.passed, 5);
  });

  test('[A2] the Guava pin is installed before the build and validates', () => {
    const pin = b.patches.find((p) => p.strategy === 'dependency_pin');
    assert.ok(pin, 'pin candidate created');
    assert.equal(pin.status, 'validated', pin.validation?.summary);
    assert.match(pin.diff, /\+\s*<guava\.version>20\.0<\/guava\.version>/);
  });

  test('[A2] the model migration (MoreObjects) validates without editing tests', () => {
    const model = b.patches.find((p) => p.origin === 'model');
    assert.ok(model);
    assert.deepEqual(model.files, ['src/main/java/com/example/inventory/InventoryItem.java']);
    assert.equal(model.status, 'validated', model.validation?.summary);
  });

  test('[A2] verdict, outcome, and evidence integrity', async () => {
    assert.equal(b.investigation.classification, 'dependency_regression');
    assert.equal(b.investigation.verdict, 'confirmed');
    assert.equal(b.investigation.confidence.label, 'strong');
    assert.deepEqual(s.server.blockedRequests(), []);
    const bad = await integrityFailures(b);
    assert.equal(bad.length, 0, describeFailures(bad));
  });
});
