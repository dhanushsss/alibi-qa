/**
 * alibi-qa runner.
 *
 *   tsx scripts/run.ts --suite <all|api|agent-loop|security|scenarios|e2e> --tier <offline|docker|browser|all> [--keep]
 *
 * 1. identifies the Alibi repository and commit under test and verifies it
 * 2. fingerprints the original repository (read-only) before and after
 * 3. checks prerequisites for the selected tiers
 * 4. prepares a disposable clone (dependencies, web build, scenario overlays)
 * 5. runs the selected suites (node:test; Playwright for e2e)
 * 6. cleans up only processes, containers, and data directories this run created
 * 7. writes reports/out/<runId>/report.{md,json}
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadQaConfig, PROVIDER_SECRET_VARS, QA_ROOT, scrubbedEnv } from './lib/config.ts';
import { run } from './lib/exec.ts';
import { checkPrereqs, tierAvailable, type Tier } from './lib/prereqs.ts';
import { fingerprint, identifyTarget, prepareTarget, sameFingerprint, worktreeState } from './lib/target.ts';
import { generateReport } from './report.ts';

const SUITES = ['api', 'agent-loop', 'security', 'scenarios'] as const;
type Suite = (typeof SUITES)[number] | 'e2e' | 'all';

function args() {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(k);
    return i >= 0 && a[i + 1] ? a[i + 1] : d;
  };
  const suite = get('--suite', 'all') as Suite;
  const tier = get('--tier', 'offline') as Tier;
  if (![...SUITES, 'e2e', 'all'].includes(suite)) throw new Error(`Unknown --suite ${suite}`);
  if (!['offline', 'docker', 'browser', 'all'].includes(tier)) throw new Error(`Unknown --tier ${tier}`);
  const source = get('--source', '');
  if (source && source !== 'commit' && source !== 'worktree') throw new Error(`Unknown --source ${source}`);
  if (source) process.env.ALIBI_QA_SOURCE = source;
  return { suite, tier, keep: a.includes('--keep'), grep: get('--grep', '') };
}

function testFiles(suite: Suite, kind: 'offline' | 'docker'): string[] {
  const dirs = suite === 'all' ? [...SUITES] : suite === 'e2e' ? [] : [suite];
  const files: string[] = [];
  for (const d of dirs) {
    const dir = join(QA_ROOT, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.test.ts')) continue;
      const isDocker = f.endsWith('.docker.test.ts');
      if ((kind === 'docker') === isDocker) files.push(join(dir, f));
    }
  }
  return files;
}

function stream(cmd: string, argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((ok) => {
    const child = spawn(cmd, argv, { cwd: QA_ROOT, env, stdio: 'inherit' });
    child.on('close', (code) => ok(code ?? 1));
    child.on('error', () => ok(1));
  });
}

async function alibiContainers(): Promise<string[]> {
  const r = await run('docker', ['ps', '-a', '--filter', 'name=alibi-exp-', '--format', '{{.Names}}'], { timeoutMs: 20_000 });
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Kills only server processes this run recorded, after confirming they run from the target clone. */
async function killRecordedPids(runDir: string): Promise<string[]> {
  const dir = join(runDir, 'pids');
  if (!existsSync(dir)) return [];
  const killed: string[] = [];
  for (const f of readdirSync(dir)) {
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const ps = await run('ps', ['-o', 'command=', '-p', String(rec.pid)]);
    if (ps.code === 0 && ps.stdout.includes('server/src/index.ts')) {
      try {
        process.kill(rec.pid, 'SIGKILL');
        killed.push(String(rec.pid));
      } catch {
        // already gone
      }
    }
    rmSync(join(dir, f), { force: true });
  }
  return killed;
}

async function main() {
  const opt = args();
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const cfg = loadQaConfig();
  const runDir = join(cfg.workDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const log = (m: string) => console.log(`[alibi-qa] ${m}`);

  log(`run ${runId}: suite=${opt.suite} tier=${opt.tier}`);
  const scrubbedVars = PROVIDER_SECRET_VARS.filter((k) => process.env[k]);
  if (scrubbedVars.length) log(`provider variables present in your shell are NOT passed to any child process: ${scrubbedVars.join(', ')}`);

  // 1-2. target identity and original-repo fingerprint
  const target = await identifyTarget(cfg);
  log(`target ${target.repo} @ ${target.shortCommit} "${target.subject}"${target.repoHeadMatchesCommit ? '' : ` (repository HEAD is ${target.repoHead.slice(0, 7)}; testing ${target.shortCommit} in a clone)`}`);
  const before = await fingerprint(cfg.repo);
  if (cfg.source === 'commit') {
    const wt = await worktreeState(cfg.repo);
    if (!wt.clean) log(`WARNING: testing commit ${target.shortCommit} only; ${wt.changedFiles.length + wt.untracked.length} uncommitted change(s) in the repository are NOT under test (use --source worktree)`);
  }

  // 3. prerequisites
  const prereqs = await checkPrereqs(cfg, opt.tier);
  for (const p of prereqs) log(`${p.ok ? 'ok  ' : 'MISS'} ${p.name}: ${p.detail}`);
  const base = tierAvailable(prereqs, 'all');
  if (!base.ok) throw new Error(`Missing required prerequisites: ${base.detail}`);
  const docker = tierAvailable(prereqs, 'docker');
  const browser = tierAvailable(prereqs, 'browser');

  // 4. disposable clone
  const prepared = await prepareTarget(cfg, target, log);
  log(`code under test: ${prepared.revision} (source=${prepared.source}${prepared.changedFiles.length ? `; ${prepared.changedFiles.length} modified file(s)` : ''}${prepared.untrackedCopied.length ? `, ${prepared.untrackedCopied.length} untracked` : ''})`);
  log(`target clone ${relative(QA_ROOT, prepared.dir)} (${prepared.reused ? 'reused base' : 'prepared'}; overlays: ${prepared.overlays.join(', ') || 'none'})`);

  const containersBefore = opt.tier === 'docker' || opt.tier === 'all' ? await alibiContainers() : [];
  // White-box tests import target modules in the test process; their data dir must be run-scoped.
  const whiteboxData = join(runDir, 'servers', 'whitebox-data');
  mkdirSync(whiteboxData, { recursive: true });
  const testEnv = scrubbedEnv({
    ALIBI_DATA_DIR: whiteboxData,
    ALIBI_RUNNER: 'disabled',
    ALIBI_QA_TARGET_DIR: prepared.dir,
    ALIBI_QA_RUN_DIR: runDir,
    ALIBI_QA_RUN_ID: runId,
    ALIBI_QA_COMMIT: target.commit,
    ALIBI_QA_REVISION: prepared.revision,
    ALIBI_QA_DOCKER: docker.ok && opt.tier !== 'offline' ? '1' : '0',
    ALIBI_QA_DOCKER_DETAIL: docker.ok ? '' : docker.detail || 'Docker tier not selected',
    FORCE_COLOR: '0',
  });

  // 5. suites
  const phases: Array<{ name: string; kind: 'node' | 'playwright'; exitCode: number; resultsFile: string; files: string[] }> = [];
  const nodeTest = async (name: string, files: string[], concurrency: number) => {
    if (!files.length) return;
    const resultsFile = join(runDir, `${name}.jsonl`);
    const argv = ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${join(QA_ROOT, 'scripts/lib/reporter.mjs')}`, `--test-reporter-destination=${resultsFile}`];
    if (opt.grep) argv.push(`--test-name-pattern=${opt.grep}`);
    log(`running ${name}: ${files.map((f) => relative(QA_ROOT, f)).join(', ')}`);
    const exitCode = await stream(process.execPath, [...argv, ...files], testEnv);
    phases.push({ name, kind: 'node', exitCode, resultsFile, files: files.map((f) => relative(QA_ROOT, f)) });
  };

  try {
    if (opt.tier === 'offline' || opt.tier === 'all') await nodeTest('offline', testFiles(opt.suite, 'offline'), 3);
    if (opt.tier === 'docker' || opt.tier === 'all') await nodeTest('docker', testFiles(opt.suite, 'docker'), 1);
    // Browser tests run for --suite e2e, or for --suite all with --tier all/browser.
    const wantE2E = opt.suite === 'e2e' || (opt.suite === 'all' && (opt.tier === 'all' || opt.tier === 'browser'));
    if (wantE2E) {
      const resultsFile = join(runDir, 'playwright.json');
      if (!browser.ok) {
        log(`e2e skipped: ${browser.detail}`);
        writeFileSync(resultsFile, JSON.stringify({ skippedSuite: true, reason: browser.detail }));
        phases.push({ name: 'e2e', kind: 'playwright', exitCode: 0, resultsFile, files: [] });
      } else {
        log('running e2e (Playwright)');
        const exitCode = await stream(join(QA_ROOT, 'node_modules', '.bin', 'playwright'), ['test', '--config', 'e2e/playwright.config.ts'], { ...testEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile });
        phases.push({ name: 'e2e', kind: 'playwright', exitCode, resultsFile, files: ['e2e/*.spec.ts'] });
      }
    }
  } finally {
    // 6. cleanup: only what this run created
    const killed = await killRecordedPids(runDir);
    if (killed.length) log(`killed leftover server processes: ${killed.join(', ')}`);
    let removedContainers: string[] = [];
    if (opt.tier === 'docker' || opt.tier === 'all') {
      // Alibi's sandbox containers carry no label: remove only names that appeared during this run.
      // (Do not run two Docker-tier QA runs at once; they cannot tell each other's containers apart.)
      const known = new Set(containersBefore);
      removedContainers = (await alibiContainers()).filter((n) => !known.has(n));
      // QA's own independent-validation containers are labelled with this run's id.
      const own = await run('docker', ['ps', '-a', '--filter', `label=alibi-qa-run=${runId}`, '--format', '{{.Names}}'], { timeoutMs: 20_000 });
      removedContainers.push(...own.stdout.split('\n').filter(Boolean));
      for (const n of removedContainers) await run('docker', ['rm', '-f', n], { timeoutMs: 30_000 });
      if (removedContainers.length) log(`removed sandbox containers left by this run: ${removedContainers.join(', ')}`);
    }
    const keep = opt.keep || cfg.keep;
    if (!keep) {
      rmSync(join(runDir, 'servers'), { recursive: true, force: true });
      rmSync(join(runDir, 'scratch'), { recursive: true, force: true });
    }

    const after = await fingerprint(cfg.repo);
    const unchanged = sameFingerprint(before, after);
    log(unchanged ? 'original repository unchanged (HEAD, refs, status, stash)' : 'WARNING: original repository fingerprint changed during the run');

    const manifest = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      suite: opt.suite,
      tier: opt.tier,
      grep: opt.grep || null,
      target: { repo: target.repo, commit: target.commit, subject: target.subject, author: target.author, committedAt: target.committedAt, repoHead: target.repoHead, remotes: target.remotes.length },
      clone: { dir: relative(QA_ROOT, prepared.dir), deps: prepared.deps, reused: prepared.reused, overlays: prepared.overlays },
      underTest: { source: prepared.source, revision: prepared.revision, baseCommit: prepared.commit, changedFiles: prepared.changedFiles, untrackedCopied: prepared.untrackedCopied, untrackedSkipped: prepared.untrackedSkipped },
      prereqs,
      dockerTier: docker,
      browserTier: browser,
      phases,
      cleanup: { killedPids: killed, removedContainers, keptData: keep },
      originalRepo: { unchanged, before: { head: before.head, statusEntries: before.status.length, stash: before.stashCount }, after: { head: after.head, statusEntries: after.status.length, stash: after.stashCount } },
      scrubbedShellVars: scrubbedVars,
    };
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const report = generateReport(runDir);
    log(`report: ${relative(QA_ROOT, report.md)}`);
    log(`summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped, ${report.summary.todo} todo/probe`);
    process.exitCode = report.summary.failed > 0 || !unchanged ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`[alibi-qa] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
