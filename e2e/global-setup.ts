/**
 * Starts the mock hub and one Alibi server (sandbox disabled) and seeds it
 * with real investigations produced offline: a Replay-mode run of the
 * built-in code-regression scenario (QA-authored replay) and a heuristic run
 * of flaky-jest. Returns a teardown that stops both.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AlibiServer } from '../scripts/lib/alibi-server.ts';
import { QA_ROOT } from '../scripts/lib/config.ts';
import { Api, qaEnv, waitForInvestigation } from '../scripts/lib/harness.ts';
import { MockHub } from '../scripts/lib/mocks/hub.ts';

export default async function globalSetup() {
  const env = qaEnv();
  const hub = await new MockHub().start();
  const server = new AlibiServer({ name: 'e2e', targetDir: env.targetDir, runDir: env.runDir, hub });
  mkdirSync(join(server.dataDir, 'replays'), { recursive: true });
  copyFileSync(join(QA_ROOT, 'fixtures', 'replays', 'code-regression.json'), join(server.dataDir, 'replays', 'code-regression.json'));
  await server.start();
  const api = new Api(server.url);
  const seeded: string[] = [];
  for (const [scenarioId, mode] of [['code-regression', 'replay'], ['flaky-jest', 'heuristic']] as const) {
    const r = await api.post('/api/investigations/demo', { scenarioId, mode });
    if (r.status !== 202) throw new Error(`seeding ${scenarioId} failed: ${r.status} ${r.text}`);
    await waitForInvestigation(api, r.json.id);
    seeded.push(r.json.id);
  }
  process.env.E2E_BASE_URL = server.url;
  process.env.E2E_SEEDED = seeded.join(',');
  return async () => {
    await server.stop();
    await hub.stop();
  };
}
