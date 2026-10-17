/**
 * Target handling: verifies the Alibi repository and commit under test, takes
 * read-only fingerprints of the original repository, and prepares a disposable
 * clone (dependencies, web build, QA scenario overlays) in the workspace.
 *
 * The original repository is only ever read. Git reads use GIT_OPTIONAL_LOCKS=0
 * so even `git status` does not refresh the original index file.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { QA_ROOT, scrubbedEnv, type QaConfig } from './config.ts';
import { mustRun, run } from './exec.ts';

const READ_ENV = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });

/** Read-only git against the ORIGINAL repository. */
function readGit(repo: string, args: string[]) {
  return mustRun('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env: READ_ENV(), timeoutMs: 60_000 });
}

/** Git inside the disposable clone. */
function cloneGit(dir: string, args: string[]) {
  return mustRun('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', ...args], { cwd: dir, env: READ_ENV(), timeoutMs: 300_000 });
}

export interface TargetInfo {
  repo: string;
  commit: string;
  shortCommit: string;
  subject: string;
  author: string;
  committedAt: string;
  repoHead: string;
  repoHeadMatchesCommit: boolean;
  remotes: string[];
}

export async function identifyTarget(cfg: QaConfig): Promise<TargetInfo> {
  if (!existsSync(join(cfg.repo, '.git'))) throw new Error(`Alibi repository not found at ${cfg.repo} (set ALIBI_QA_REPO).`);
  const full = (await readGit(cfg.repo, ['rev-parse', '--verify', `${cfg.commit}^{commit}`])).trim();
  const [subject, author, committedAt] = (await readGit(cfg.repo, ['log', '-1', '--format=%s%x00%an%x00%cI', full])).trim().split('\0');
  const head = (await readGit(cfg.repo, ['rev-parse', 'HEAD'])).trim();
  const remotes = (await readGit(cfg.repo, ['remote'])).trim().split('\n').filter(Boolean);
  if (cfg.expectedSubject && subject !== cfg.expectedSubject) {
    throw new Error(`Commit ${cfg.commit} has subject "${subject}", expected "${cfg.expectedSubject}". Refusing to test an unexpected version.`);
  }
  return { repo: cfg.repo, commit: full, shortCommit: full.slice(0, 7), subject, author, committedAt, repoHead: head, repoHeadMatchesCommit: head === full, remotes };
}

export interface RepoFingerprint {
  head: string;
  refsHash: string;
  statusHash: string;
  status: string[];
  stashCount: number;
}

/** Read-only snapshot used to prove the original repository was not changed by a run. */
export async function fingerprint(repo: string): Promise<RepoFingerprint> {
  const head = (await readGit(repo, ['rev-parse', 'HEAD'])).trim();
  const refs = await readGit(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const status = (await readGit(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean);
  const stash = (await run('git', ['stash', 'list'], { cwd: repo, env: READ_ENV() })).stdout.split('\n').filter(Boolean).length;
  const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  return { head, refsHash: h(refs), statusHash: h(status.join('\n')), status, stashCount: stash };
}

export function sameFingerprint(a: RepoFingerprint, b: RepoFingerprint): boolean {
  return a.head === b.head && a.refsHash === b.refsHash && a.statusHash === b.statusHash && a.stashCount === b.stashCount;
}

export interface PreparedTarget {
  dir: string;
  commit: string;
  /** What is under test: the commit alone, or the commit plus the working-tree changes. */
  source: 'commit' | 'worktree';
  /** Exact identity of the code under test, e.g. "669c6c0" or "669c6c0+wt.1a2b3c4d5e6f". */
  revision: string;
  changedFiles: string[];
  untrackedCopied: string[];
  untrackedSkipped: string[];
  deps: QaConfig['deps'];
  lockHash: string;
  overlays: string[];
  preparedAt: string;
  reused: boolean;
}

export interface WorktreeState {
  clean: boolean;
  diff: string;
  changedFiles: string[];
  untracked: string[];
  skipped: string[];
  hash: string;
}

/** Untracked files that are never copied into the clone (screenshots, media, archives, databases). */
const SKIP_UNTRACKED = /\.(png|jpe?g|gif|webp|bmp|ico|svg|mp4|webm|mov|zip|tgz|gz|db|sqlite|db-wal|db-shm)$/i;

/** Read-only snapshot of uncommitted changes in the original repository. */
export async function worktreeState(repo: string): Promise<WorktreeState> {
  const diff = await readGit(repo, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff']);
  const changedFiles = (await readGit(repo, ['diff', 'HEAD', '--name-only'])).split('\n').filter(Boolean);
  const all = (await readGit(repo, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const untracked = all.filter((f) => !SKIP_UNTRACKED.test(f) && !/(^|\/)\.env/.test(f));
  const skipped = all.filter((f) => !untracked.includes(f));
  const h = createHash('sha256').update(diff);
  for (const f of untracked) h.update(`\0${f}\0`).update(readFileSync(join(repo, f)));
  return { clean: !diff && untracked.length === 0, diff, changedFiles, untracked, skipped, hash: h.digest('hex').slice(0, 12) };
}

export function targetDir(cfg: QaConfig, commit: string) {
  return join(cfg.workDir, `target-${commit.slice(0, 12)}`);
}

/**
 * Prepares the disposable clone of the code under test:
 *  - "commit":   the configured commit exactly;
 *  - "worktree": the configured commit (which must be the repository HEAD) plus the
 *                repository's uncommitted changes and untracked, non-media files.
 * The base clone and its dependencies are reused; the clone is reset to the base
 * commit on every run, changes are re-applied, and the web bundle is rebuilt whenever
 * the revision changes, so a stale build is never tested.
 */
export async function prepareTarget(cfg: QaConfig, info: TargetInfo, log: (m: string) => void = () => {}): Promise<PreparedTarget> {
  const dir = targetDir(cfg, info.commit);
  const marker = join(dir, '.qa-prepared.json');
  const source = cfg.source;
  let wt: WorktreeState | null = null;
  if (source === 'worktree') {
    if (!info.repoHeadMatchesCommit) throw new Error(`source=worktree needs the repository HEAD (${info.repoHead.slice(0, 7)}) to be the configured commit ${info.shortCommit}. Update qa.config.json "commit" or use --source commit.`);
    wt = await worktreeState(cfg.repo);
  }
  const revision = wt && !wt.clean ? `${info.shortCommit}+wt.${wt.hash}` : info.shortCommit;
  const lockContent = wt ? readFileSync(join(cfg.repo, 'package-lock.json'), 'utf8') : await readGit(cfg.repo, ['show', `${info.commit}:package-lock.json`]);
  const lockHash = createHash('sha256').update(lockContent).digest('hex');

  const prev = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
  const reused = Boolean(prev && prev.commit === info.commit && prev.lockHash === lockHash && prev.deps === cfg.deps);

  if (!reused) {
    log(`Cloning ${info.shortCommit} into ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(cfg.workDir, { recursive: true });
    // --no-hardlinks: the clone shares no inodes with the original object store.
    await mustRun('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', cfg.repo, dir], { env: READ_ENV(), timeoutMs: 300_000 });
    await cloneGit(dir, ['checkout', '--quiet', '--detach', info.commit]);
    // The clone must never be able to push back into the original repository.
    await cloneGit(dir, ['remote', 'remove', 'origin']);
  }

  // Reset the disposable clone to the base commit (ignored files — node_modules, builds — are kept).
  // Destructive git commands run only inside the QA workspace, never in the original repository.
  if (!resolve(dir).startsWith(resolve(cfg.workDir) + sep) || resolve(dir) === resolve(cfg.repo)) throw new Error(`Refusing to reset ${dir}: not a QA clone`);
  await cloneGit(dir, ['reset', '--quiet', '--hard', info.commit]);
  await cloneGit(dir, ['clean', '-fdq']);
  if (wt && !wt.clean) {
    log(`Applying working-tree changes: ${wt.changedFiles.length} modified, ${wt.untracked.length} untracked file(s)${wt.skipped.length ? `; not copied: ${wt.skipped.length} media/database file(s)` : ''}`);
    if (wt.diff) {
      const patchFile = join(cfg.workDir, `worktree-${wt.hash}.patch`);
      writeFileSync(patchFile, wt.diff);
      try {
        await cloneGit(dir, ['apply', '--binary', '--whitespace=nowarn', patchFile]);
      } finally {
        rmSync(patchFile, { force: true });
      }
    }
    for (const f of wt.untracked) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(cfg.repo, f), join(dir, f));
    }
  }

  if (!reused) {
    if (cfg.deps === 'copy') {
      const srcLock = join(cfg.repo, 'package-lock.json');
      const srcInstalled = join(cfg.repo, 'node_modules', '.package-lock.json');
      if (!existsSync(srcInstalled) || !existsSync(srcLock) || readFileSync(srcLock, 'utf8') !== lockContent) {
        throw new Error('ALIBI_QA_DEPS=copy requires the source repository to have node_modules installed from the same package-lock.json as the code under test. Use ALIBI_QA_DEPS=npm-ci (network) instead.');
      }
      log('Copying node_modules (copy-on-write where supported)');
      for (const sub of ['', 'server', 'web']) {
        const from = join(cfg.repo, sub, 'node_modules');
        if (!existsSync(from)) continue;
        const to = join(dir, sub, 'node_modules');
        // APFS clonefile (-c) is near-instant and shares no writable state; fall back to a plain copy.
        const r = await run('cp', ['-cR', from, to]);
        if (r.code !== 0) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      }
    } else {
      log('Installing dependencies with npm ci (network)');
      await mustRun('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, env: scrubbedEnv(), timeoutMs: 600_000 });
    }
  }

  if (!reused || prev?.builtRevision !== revision || !existsSync(join(dir, 'web', 'dist', 'index.html'))) {
    log(`Building the web bundle for ${revision}`);
    await mustRun('npm', ['run', 'build', '-w', 'web'], { cwd: dir, env: scrubbedEnv({ NODE_ENV: 'production' }), timeoutMs: 300_000 });
  }

  const overlays = installOverlays(dir);
  await verifyCloneIntegrity(dir, info.commit, wt && !wt.clean ? wt : null);
  const prepared: PreparedTarget = {
    dir, commit: info.commit, source, revision,
    changedFiles: wt?.changedFiles ?? [], untrackedCopied: wt?.untracked ?? [], untrackedSkipped: wt?.skipped ?? [],
    deps: cfg.deps, lockHash, overlays, preparedAt: new Date().toISOString(), reused,
  };
  writeFileSync(marker, JSON.stringify({ ...prepared, builtRevision: revision }, null, 2));
  return prepared;
}

const OVERLAY_SRC = join(QA_ROOT, 'scenarios', 'overlays');

/** Copies QA scenario overlays into <clone>/fixtures/scenarios/qa-*; removes stale ones first. */
function installOverlays(dir: string): string[] {
  const dest = join(dir, 'fixtures', 'scenarios');
  for (const d of readdirSync(dest)) if (d.startsWith('qa-')) rmSync(join(dest, d), { recursive: true, force: true });
  if (!existsSync(OVERLAY_SRC)) return [];
  const ids = readdirSync(OVERLAY_SRC).filter((d) => d.startsWith('qa-') && statSync(join(OVERLAY_SRC, d)).isDirectory());
  for (const id of ids) cpSync(join(OVERLAY_SRC, id), join(dest, id), { recursive: true });
  return ids;
}

/**
 * The clone must be exactly the code under test: HEAD is the base commit; tracked
 * changes are exactly the working-tree diff (or none); and the only untracked
 * content is copied working-tree files, QA overlays, and the preparation marker.
 */
export async function verifyCloneIntegrity(dir: string, commit: string, wt: WorktreeState | null = null): Promise<void> {
  const head = (await cloneGit(dir, ['rev-parse', 'HEAD'])).trim();
  if (head !== commit) throw new Error(`Clone HEAD ${head} does not match commit under test ${commit}`);
  const diff = await cloneGit(dir, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff']);
  if ((wt?.diff ?? '') !== diff) {
    const names = (await cloneGit(dir, ['diff', '--name-only', 'HEAD'])).trim();
    throw new Error(`Tracked files in the clone do not match the code under test:\n${names || '(no tracked changes)'}`);
  }
  const copied = new Set(wt?.untracked ?? []);
  const untracked = (await cloneGit(dir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const unexpected = untracked.filter((p) => !/^fixtures\/scenarios\/qa-[a-z0-9-]+\//.test(p) && p !== '.qa-prepared.json' && !copied.has(p));
  if (unexpected.length) throw new Error(`Unexpected untracked files in the clone: ${unexpected.join(', ')}`);
}
