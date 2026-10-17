/**
 * F. Sandbox isolation, observed from inside Alibi's real Docker sandbox.
 * The qa-sandbox-probe fixture only OBSERVES its environment (user,
 * capabilities, writable paths, mounts, network reachability, environment
 * variable names) and prints a JSON report; it runs no exploit or destructive
 * code. Alibi reproduces it, and the report is read from the persisted output.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dockerSkipReason, startStack, waitForInvestigation, type Bundle, type Stack } from '../scripts/lib/harness.ts';
import { overlayRules } from '../scripts/lib/model-scripts.ts';
import { run } from '../scripts/lib/exec.ts';

const skip = dockerSkipReason();
let s: Stack & { stop: () => Promise<void> };
let b: Bundle;
let probe: any;

describe('F: sandbox isolation probe', { skip }, () => {
  before(async () => {
    s = await startStack('docker-sandbox-probe', { runner: 'docker' });
    s.hub.nebius.script(overlayRules('qa-sandbox-probe'));
    const r = await s.api.post('/api/investigations/demo', { scenarioId: 'qa-sandbox-probe', mode: 'live' });
    assert.equal(r.status, 202, r.text);
    b = await waitForInvestigation(s.api, r.json.id, 900_000);
    const reproduce = b.experiments.find((e) => e.kind === 'reproduce');
    const line = /QA_PROBE_RESULT (\{.*\})/.exec(reproduce?.result?.attempts?.[0]?.outputTail ?? '');
    probe = line ? JSON.parse(line[1]) : null;
  });
  after(async () => s?.stop());

  test('[F9] the probe ran inside the sandbox and reported', () => {
    assert.ok(probe, 'QA_PROBE_RESULT not found in the recorded sandbox output');
  });
  test('[F9] tests run as a non-root user with no capabilities and no-new-privileges', () => {
    assert.equal(probe.uid, 1000);
    assert.equal(probe.capEff, '0000000000000000');
    assert.equal(probe.noNewPrivs, '1');
  });
  test('[F9] the root filesystem is read-only; only /tmp and the workspace are writable', () => {
    assert.equal(probe.rootFsWrite, 'EROFS');
    assert.equal(probe.etcWrite, 'EROFS');
    assert.equal(probe.tmpWrite, 'written');
    assert.equal(probe.workWrite, 'written');
  });
  test('[F9] no network during test runs (TCP and DNS both fail)', () => {
    assert.notEqual(probe.tcpExternal, 'connected');
    assert.notEqual(probe.dnsExternal, 'resolved');
  });
  test('[F9] the Docker socket and host home directories are not mounted', () => {
    assert.equal(probe.dockerSocket, false);
    assert.equal(probe.hostUsersDir, false);
  });
  test('[F9] host environment (credentials and the QA canary) does not reach the sandbox', () => {
    assert.equal(probe.envValuesWithQaMarkers, 0);
    for (const k of ['NEBIUS_API_KEY', 'TAVILY_API_KEY', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'QA_HOST_CANARY', 'ALIBI_DATA_DIR']) assert.ok(!probe.envNames.includes(k), `${k} visible in the sandbox`);
  });
  test('[F9] dependency lifecycle scripts do not run during install (--ignore-scripts)', () => {
    assert.equal(probe.preinstallRan, false);
  });
  test('[F9] memory and process limits are applied', () => {
    assert.equal(probe.memoryMax, String(1536 * 1024 * 1024));
    assert.equal(probe.pidsMax, '512');
  });
  test('[F9] no sandbox container outlives the investigation', async () => {
    const r = await run('docker', ['ps', '-a', '--filter', 'name=alibi-exp-', '--format', '{{.Names}}']);
    assert.equal(r.stdout.trim(), '', `left behind: ${r.stdout}`);
  });
});
