/**
 * Removes what this suite created and nothing else:
 *   - Alibi server processes recorded in .work/runs/<id>/pids (only if they still
 *     run server/src/index.ts from a QA target clone)
 *   - per-run data directories under .work/runs
 *   - with --all: the target clone(s) and generated reports
 * It never touches the original Alibi repository, Docker images, or containers
 * it did not record.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadQaConfig, QA_ROOT } from './lib/config.ts';
import { run } from './lib/exec.ts';

const all = process.argv.includes('--all');
const cfg = loadQaConfig();
const runs = join(cfg.workDir, 'runs');
let killed = 0;
if (existsSync(runs)) {
  for (const id of readdirSync(runs)) {
    const pids = join(runs, id, 'pids');
    if (!existsSync(pids)) continue;
    for (const f of readdirSync(pids)) {
      const rec = JSON.parse(readFileSync(join(pids, f), 'utf8'));
      const ps = await run('ps', ['-o', 'command=', '-p', String(rec.pid)]);
      if (ps.code === 0 && ps.stdout.includes('server/src/index.ts') && String(rec.targetDir).startsWith(cfg.workDir)) {
        try {
          process.kill(rec.pid, 'SIGKILL');
          killed++;
        } catch {
          // already gone
        }
      }
    }
  }
  rmSync(runs, { recursive: true, force: true });
}
console.log(`Killed ${killed} leftover Alibi server process(es); removed run data in ${runs}.`);
if (all) {
  for (const d of existsSync(cfg.workDir) ? readdirSync(cfg.workDir) : []) {
    if (d.startsWith('target-')) rmSync(join(cfg.workDir, d), { recursive: true, force: true });
  }
  rmSync(join(QA_ROOT, 'reports', 'out'), { recursive: true, force: true });
  rmSync(join(QA_ROOT, 'test-results'), { recursive: true, force: true });
  console.log('Removed target clone(s) and generated reports.');
}
