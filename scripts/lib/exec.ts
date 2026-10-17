import { spawn, type SpawnOptions } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Never throws on non-zero exit; callers decide. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Like run(), but throws with captured output when the command fails. */
export async function mustRun(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number; input?: string } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}\n${r.stderr.slice(-2000)}${r.stdout.slice(-1000)}`);
  return r.stdout;
}

/** Host-side git with repository-controlled behaviour disabled (hooks, fsmonitor, LFS filters). */
export function git(args: string[], cwd: string) {
  return mustRun('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'advice.detachedHead=false', ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    timeoutMs: 300_000,
  });
}
