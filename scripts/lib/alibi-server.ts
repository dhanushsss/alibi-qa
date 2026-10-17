/**
 * Starts an Alibi server from the disposable clone with a constrained
 * environment: providers point at local mocks, keys are fake, outbound fetch is
 * guarded, and every data file lives in a per-instance directory the suite owns.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QA_ROOT, scrubbedEnv } from './config.ts';
import type { MockHub } from './mocks/hub.ts';
import { sanitize } from './sanitize.mjs';

/** Fake credentials. They only ever reach the local mocks; leak tests search for them. */
export const MOCK_SECRETS = {
  nebiusKey: 'qa-mock-nebius-key-0f3c9a71e2',
  githubToken: 'qa-mock-github-token-7d21e4b0c9',
  webhookSecret: 'qa-mock-webhook-secret-a19b55f0',
  tavilyKey: 'qa-mock-tavily-key-5e8d03aa',
  hostCanary: 'qa-host-canary-91c2d7e45a',
} as const;

export interface ServerOptions {
  name: string;
  targetDir: string;
  runDir: string;
  hub: MockHub;
  runner?: 'disabled' | 'docker';
  /** 'mock' sets a fake key and points the client at the mock; 'none' leaves Nebius unconfigured. */
  nebius?: 'mock' | 'none';
  github?: boolean;
  tavily?: boolean;
  webhookSecret?: boolean;
  publicDemo?: boolean;
  /** Enables ALIBI_LOOP=1 and sets loop limits (e.g. { ALIBI_LOOP_MAX_RUNS: '4' }). */
  loop?: false | Record<string, string>;
  concurrency?: number;
  /** Extra Alibi env (validated: URLs must be loopback). */
  env?: Record<string, string>;
  /** Re-use an existing data directory (restart/persistence tests). */
  dataDir?: string;
}

const STARTUP_TIMEOUT_MS = 90_000;

export class AlibiServer {
  url = '';
  private child: ChildProcess | null = null;
  readonly dataDir: string;
  readonly logFile: string;
  readonly guardLog: string;

  constructor(readonly opts: ServerOptions) {
    this.dataDir = opts.dataDir ?? join(opts.runDir, 'servers', `${opts.name}-${randomBytes(3).toString('hex')}`);
    this.logFile = join(this.dataDir, 'server.log');
    this.guardLog = join(this.dataDir, 'network-guard.log');
  }

  get dbPath() {
    return join(this.dataDir, 'qa.db');
  }

  env(): NodeJS.ProcessEnv {
    const o = this.opts;
    const hub = o.hub;
    const alibi: Record<string, string> = {
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      ALIBI_DATA_DIR: this.dataDir,
      ALIBI_DB: 'qa.db',
      ALIBI_RUNNER: o.runner ?? 'disabled',
      ALIBI_CONCURRENCY: String(o.concurrency ?? 1),
      ALIBI_DEMO_READONLY: o.publicDemo ? 'true' : 'false',
      ALIBI_AUTO_INVESTIGATE: 'false',
      ALIBI_REPEAT_DEFAULT: '3',
      NEBIUS_API_KEY: o.nebius === 'none' ? '' : MOCK_SECRETS.nebiusKey,
      NEBIUS_BASE_URL: hub.nebiusBaseUrl,
      NEBIUS_PROJECT_ID: '',
      NEBIUS_TIMEOUT_MS: '20000',
      NEBIUS_MAX_RETRIES: '1',
      ALIBI_MODEL_TRIAGE: '',
      ALIBI_MODEL_REASONING: '',
      ALIBI_MODEL_DEEP: '',
      TAVILY_API_KEY: o.tavily ? MOCK_SECRETS.tavilyKey : '',
      TAVILY_TIMEOUT_MS: '5000',
      GITHUB_TOKEN: o.github === false ? '' : MOCK_SECRETS.githubToken,
      GITHUB_API_URL: hub.githubApiUrl,
      GITHUB_WEBHOOK_SECRET: o.webhookSecret === false ? '' : MOCK_SECRETS.webhookSecret,
      ALIBI_RUNNER_TIMEOUT_SEC: '120',
      ALIBI_RUNNER_INSTALL_TIMEOUT_SEC: '420',
      ALIBI_LOOP: o.loop ? '1' : '',
      ...(o.loop || {}),
      ...(o.env ?? {}),
      // Test seams for the network guard and sandbox canary.
      QA_TAVILY_MOCK_URL: hub.tavilyUrl,
      QA_GUARD_LOG: this.guardLog,
      QA_HOST_CANARY: MOCK_SECRETS.hostCanary,
    };
    for (const [k, v] of Object.entries(alibi)) {
      if (/URL$/.test(k) && v && !/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(v)) throw new Error(`Refusing to start Alibi: ${k} must point at a loopback mock (got ${v})`);
    }
    return scrubbedEnv(alibi);
  }

  async start(): Promise<this> {
    mkdirSync(this.dataDir, { recursive: true });
    // A restarted instance appends to the same log: only parse what this process writes.
    const offset = existsSync(this.logFile) ? statSync(this.logFile).size : 0;
    const guard = pathToFileURL(join(QA_ROOT, 'scripts', 'lib', 'network-guard.mjs')).href;
    const fd = openSync(this.logFile, 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', guard, 'server/src/index.ts'], {
      cwd: this.opts.targetDir,
      env: this.env(),
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    this.child = child;
    const pidDir = join(this.opts.runDir, 'pids');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, targetDir: this.opts.targetDir, dataDir: this.dataDir, startedAt: new Date().toISOString() }));

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let exited: number | null = null;
    child.once('exit', (code) => (exited = code ?? -1));
    while (Date.now() < deadline) {
      if (exited !== null) throw new Error(`Alibi server "${this.opts.name}" exited during startup (code ${exited}).\n${this.logTail()}`);
      const log = existsSync(this.logFile) ? readFileSync(this.logFile).subarray(offset).toString('utf8') : '';
      const m = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (m) {
        if (!log.includes('[qa-network-guard] active')) {
          await this.stop();
          throw new Error('Network guard did not load in the Alibi server process; refusing to continue.');
        }
        this.url = m[1];
        const health = await fetch(`${this.url}/api/health`).then((r) => r.ok).catch(() => false);
        if (health) return this;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.stop();
    throw new Error(`Alibi server "${this.opts.name}" did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s.\n${this.logTail()}`);
  }

  /** Graceful stop (SIGTERM), escalating to SIGKILL. Safe to call twice. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.forgetPid();
      return;
    }
    const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
    this.forgetPid();
  }

  /** Abrupt termination, as in a crash or power loss. */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
    child.kill('SIGKILL');
    await exited;
    this.forgetPid();
  }

  /** A new process over the same data directory. */
  async restart(): Promise<AlibiServer> {
    await this.stop();
    return new AlibiServer({ ...this.opts, dataDir: this.dataDir }).start();
  }

  logText(): string {
    return existsSync(this.logFile) ? readFileSync(this.logFile, 'utf8') : '';
  }

  logTail(lines = 40): string {
    return sanitize(this.logText().split('\n').slice(-lines).join('\n'));
  }

  /** Outbound requests the network guard refused (should be empty). */
  blockedRequests(): Array<{ host: string; path: string }> {
    if (!existsSync(this.guardLog)) return [];
    return readFileSync(this.guardLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  removeData() {
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  private forgetPid() {
    if (this.child?.pid) rmSync(join(this.opts.runDir, 'pids', `${this.child.pid}.json`), { force: true });
  }
}
