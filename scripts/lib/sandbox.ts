/**
 * QA's own, independent fix check. Takes a patch diff persisted by Alibi,
 * applies it to a fresh clone of the scenario repository at the failing commit,
 * and runs the tests in a hardened throwaway container. Dependency install
 * has network access (as in Alibi); test runs have none.
 *
 * Containers are named alibi-qa-* and labelled alibi-qa=1 so cleanup can
 * remove exactly what this suite created.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, run } from './exec.ts';

const IMAGE = 'node:20-bookworm-slim';

function dockerArgs(dir: string, cache: string, network: boolean, cmd: string[]) {
  return [
    'run', '--rm', '--name', `alibi-qa-${randomBytes(5).toString('hex')}`, '--label', 'alibi-qa=1', '--label', `alibi-qa-run=${process.env.ALIBI_QA_RUN_ID ?? 'manual'}`,
    '--network', network ? 'bridge' : 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,exec,size=512m', '--pids-limit', '512', '--memory', '1536m',
    '-e', 'HOME=/tmp', '-e', 'CI=true', '-v', `${dir}:/work:rw`, '-v', `${cache}:/cache:rw`, '-w', '/work', IMAGE, ...cmd,
  ];
}

export interface IndependentResult {
  /** Exit code per seed before the patch is applied. */
  before: Array<number | null>;
  /** Exit code per seed with the patch applied. */
  after: Array<number | null>;
  applied: boolean;
  output: string;
}

export async function independentValidate(opts: { repoPath: string; sha: string; diff: string; scratch: string; seeds?: Array<number | undefined>; testPath?: string }): Promise<IndependentResult> {
  const cache = join(opts.scratch, 'npm-cache');
  mkdirSync(cache, { recursive: true });
  const seeds = opts.seeds ?? [undefined];

  /** Fresh checkout → (optional patch) → install → offline test runs. Installing AFTER patching matters for dependency fixes. */
  const phase = async (diff: string | null): Promise<{ codes: Array<number | null>; out: string; applied: boolean }> => {
    const dir = join(opts.scratch, `indep-${randomBytes(4).toString('hex')}`);
    try {
      await git(['clone', '--quiet', '--no-checkout', opts.repoPath, dir], opts.scratch);
      await git(['checkout', '--quiet', '--detach', opts.sha], dir);
      if (diff !== null) {
        const patchFile = join(opts.scratch, `${randomBytes(4).toString('hex')}.patch`);
        writeFileSync(patchFile, diff.endsWith('\n') ? diff : `${diff}\n`);
        const applied = await run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: dir });
        rmSync(patchFile, { force: true });
        if (applied.code !== 0) return { codes: [], out: applied.stderr, applied: false };
      }
      const lock = existsSync(join(dir, 'package-lock.json'));
      const install = await run('docker', dockerArgs(dir, cache, true, ['npm', lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/cache/npm']), { timeoutMs: 600_000 });
      if (install.code !== 0) throw new Error(`independent install failed: ${install.stderr.slice(-800)}`);
      const codes: Array<number | null> = [];
      let out = '';
      for (const s of seeds) {
        const cmd = ['node', 'node_modules/jest/bin/jest.js', '--ci', ...(s !== undefined ? [`--seed=${s}`] : []), ...(opts.testPath ? ['--runTestsByPath', opts.testPath] : [])];
        const r = await run('docker', dockerArgs(dir, cache, false, cmd), { timeoutMs: 180_000 });
        codes.push(r.code);
        out += r.stderr.slice(-2000);
      }
      return { codes, out, applied: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const before = await phase(null);
  const after = await phase(opts.diff);
  return { before: before.codes, after: after.codes, applied: after.applied, output: after.out };
}

/**
 * pytest variant of independentValidate, using QA's own commands (not Alibi's adapter):
 * a venv in the checkout, wheels-only install with network, then offline pytest runs.
 * `runs` repeats the test command in the same checkout (state may carry over between runs).
 */
export async function independentValidatePytest(opts: { repoPath: string; sha: string; diff: string; scratch: string; image: string; runs?: number; testPath?: string }): Promise<IndependentResult> {
  const cache = join(opts.scratch, 'pip-cache');
  mkdirSync(cache, { recursive: true });
  const runs = opts.runs ?? 1;
  const args = (dir: string, network: boolean, cmd: string[]) => {
    const a = dockerArgs(dir, cache, network, cmd);
    a[a.indexOf(IMAGE)] = opts.image;
    return a;
  };
  const phase = async (diff: string | null): Promise<{ codes: Array<number | null>; out: string; applied: boolean }> => {
    const dir = join(opts.scratch, `indep-py-${randomBytes(4).toString('hex')}`);
    try {
      await git(['clone', '--quiet', '--no-checkout', opts.repoPath, dir], opts.scratch);
      await git(['checkout', '--quiet', '--detach', opts.sha], dir);
      if (diff !== null) {
        const patchFile = join(opts.scratch, `${randomBytes(4).toString('hex')}.patch`);
        writeFileSync(patchFile, diff.endsWith('\n') ? diff : `${diff}\n`);
        const applied = await run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: dir });
        rmSync(patchFile, { force: true });
        if (applied.code !== 0) return { codes: [], out: applied.stderr, applied: false };
      }
      const install = await run('docker', args(dir, true, ['sh', '-c', 'python -I -m venv .qa-venv && .qa-venv/bin/python -I -m pip install -q --only-binary=:all: --cache-dir /cache/pip -r requirements.txt']), { timeoutMs: 600_000 });
      if (install.code !== 0) throw new Error(`independent pip install failed: ${(install.stdout + install.stderr).slice(-800)}`);
      const codes: Array<number | null> = [];
      let out = '';
      for (let i = 0; i < runs; i++) {
        const r = await run('docker', args(dir, false, ['.qa-venv/bin/python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--ignore=.qa-venv', ...(opts.testPath ? [opts.testPath] : [])]), { timeoutMs: 180_000 });
        codes.push(r.code);
        out += (r.stdout + r.stderr).slice(-2000);
      }
      return { codes, out, applied: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const before = await phase(null);
  const after = await phase(opts.diff);
  return { before: before.codes, after: after.codes, applied: after.applied, output: after.out };
}

/**
 * Go variant of independentValidate, using QA's own commands (not Alibi's adapter):
 * `go mod download` with network, then offline `go test` runs with the proxy off.
 * `runs` repeats the test command in the same checkout (state may carry over between runs).
 */
export async function independentValidateGo(opts: { repoPath: string; sha: string; diff: string; scratch: string; image: string; runs?: number; pkg?: string }): Promise<IndependentResult> {
  const cache = join(opts.scratch, 'go-cache');
  mkdirSync(join(cache, 'mod'), { recursive: true });
  mkdirSync(join(cache, 'build'), { recursive: true });
  const runs = opts.runs ?? 1;
  const args = (dir: string, network: boolean, cmd: string[]) => {
    const a = dockerArgs(dir, cache, network, cmd);
    const env = ['-e', 'GOMODCACHE=/cache/mod', '-e', 'GOCACHE=/cache/build', '-e', 'GOPATH=/tmp/go', '-e', 'GOTOOLCHAIN=local', '-e', 'CGO_ENABLED=0', '-e', 'GOFLAGS=-mod=readonly -modcacherw', '-e', `GOPROXY=${network ? 'https://proxy.golang.org' : 'off'}`];
    a.splice(a.indexOf(IMAGE), 1, ...env, opts.image);
    return a;
  };
  const phase = async (diff: string | null): Promise<{ codes: Array<number | null>; out: string; applied: boolean }> => {
    const dir = join(opts.scratch, `indep-go-${randomBytes(4).toString('hex')}`);
    try {
      await git(['clone', '--quiet', '--no-checkout', opts.repoPath, dir], opts.scratch);
      await git(['checkout', '--quiet', '--detach', opts.sha], dir);
      if (diff !== null) {
        const patchFile = join(opts.scratch, `${randomBytes(4).toString('hex')}.patch`);
        writeFileSync(patchFile, diff.endsWith('\n') ? diff : `${diff}\n`);
        const applied = await run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: dir });
        rmSync(patchFile, { force: true });
        if (applied.code !== 0) return { codes: [], out: applied.stderr, applied: false };
      }
      const install = await run('docker', args(dir, true, ['go', 'mod', 'download']), { timeoutMs: 600_000 });
      if (install.code !== 0) throw new Error(`independent go mod download failed: ${(install.stdout + install.stderr).slice(-800)}`);
      const codes: Array<number | null> = [];
      let out = '';
      for (let i = 0; i < runs; i++) {
        const r = await run('docker', args(dir, false, ['go', 'test', '-count=1', opts.pkg ?? './...']), { timeoutMs: 300_000 });
        codes.push(r.code);
        out += (r.stdout + r.stderr).slice(-2000);
      }
      return { codes, out, applied: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const before = await phase(null);
  const after = await phase(opts.diff);
  return { before: before.codes, after: after.codes, applied: after.applied, output: after.out };
}
