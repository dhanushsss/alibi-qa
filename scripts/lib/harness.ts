/**
 * Shared helpers for test files. Tests are started by scripts/run.ts, which
 * prepares the target clone and passes its location through the environment.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before } from 'node:test';
import { QA_ROOT } from './config.ts';
import { AlibiServer, type ServerOptions } from './alibi-server.ts';
import { MockHub } from './mocks/hub.ts';

export interface QaEnv {
  targetDir: string;
  runDir: string;
  commit: string;
  docker: boolean;
}

export function qaEnv(): QaEnv {
  const targetDir = process.env.ALIBI_QA_TARGET_DIR;
  const runDir = process.env.ALIBI_QA_RUN_DIR;
  if (!targetDir || !runDir) throw new Error('Run tests through scripts/run.ts (npm test), which prepares the target clone.');
  return { targetDir, runDir, commit: process.env.ALIBI_QA_COMMIT ?? 'unknown', docker: process.env.ALIBI_QA_DOCKER === '1' };
}

/** Skip reason for Docker-tier tests when the daemon or images are unavailable; null when runnable. */
export function dockerSkipReason(): string | false {
  return process.env.ALIBI_QA_DOCKER === '1' ? false : `missing prerequisite: ${process.env.ALIBI_QA_DOCKER_DETAIL ?? 'Docker daemon/images unavailable'}`;
}

/** Imports a module from the clone of the commit under test (white-box tests of pure modules). */
export async function importTarget<T = any>(relPath: string): Promise<T> {
  return import(pathToFileURL(join(qaEnv().targetDir, relPath)).href) as Promise<T>;
}

export function fixture<T = any>(rel: string): T {
  return JSON.parse(readFileSync(join(QA_ROOT, 'fixtures', rel), 'utf8')) as T;
}

export function fixtureText(rel: string): string {
  return readFileSync(join(QA_ROOT, 'fixtures', rel), 'utf8');
}

// ------------------------------------------------------------------ HTTP

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  text: string;
  json: T;
}

export class Api {
  constructor(readonly base: string) {}

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' || Buffer.isBuffer(body) ? (body as string) : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
    }
    const res = await fetch(`${this.base}${path}`, init);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }
  get<T = any>(path: string) {
    return this.req<T>('GET', path);
  }
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.req<T>('POST', path, body ?? {}, headers);
  }
  put<T = any>(path: string, body?: unknown) {
    return this.req<T>('PUT', path, body ?? {});
  }
  del<T = any>(path: string) {
    return this.req<T>('DELETE', path);
  }
}

// ------------------------------------------------------------------ polling (no fixed sleeps)

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs: number; intervalMs?: number; what: string }): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${opts.timeoutMs} ms waiting for ${opts.what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
}

export const TERMINAL = new Set(['completed', 'inconclusive', 'failed']);

/** Polls until the investigation is terminal and no patch is still validating; returns the bundle. */
export async function waitForInvestigation(api: Api, id: string, timeoutMs = 60_000): Promise<Bundle> {
  return waitFor(
    async () => {
      const r = await api.get<Bundle>(`/api/investigations/${id}`);
      if (r.status !== 200) throw new Error(`GET investigation returned ${r.status}`);
      const b = r.json;
      return TERMINAL.has(b.investigation.status) && !b.patches.some((p) => p.status === 'validating') ? b : null;
    },
    { timeoutMs, intervalMs: 300, what: `investigation ${id} to finish` },
  );
}

// ------------------------------------------------------------------ database (read-only)

export function openDb(dbPath: string): any {
  const require = createRequire(join(qaEnv().targetDir, 'server', 'package.json'));
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function dbRows(dbPath: string, sql: string, ...params: unknown[]): any[] {
  const db = openDb(dbPath);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ stacks

export interface Stack {
  hub: MockHub;
  server: AlibiServer;
  api: Api;
}

/**
 * Registers before/after hooks that start a mock hub and an Alibi server and
 * always tear them down (also when tests fail). Call at describe/file level.
 */
export function useStack(name: string, opts: Omit<ServerOptions, 'name' | 'targetDir' | 'runDir' | 'hub'> = {}): Stack {
  const stack = {} as Stack;
  before(async () => {
    const env = qaEnv();
    stack.hub = await new MockHub().start();
    stack.server = await new AlibiServer({ name, targetDir: env.targetDir, runDir: env.runDir, hub: stack.hub, ...opts }).start();
    stack.api = new Api(stack.server.url);
  });
  after(async () => {
    await stack.server?.stop();
    await stack.hub?.stop();
  });
  return stack;
}

/** Starts a stack imperatively (caller must call stop). */
export async function startStack(name: string, opts: Omit<ServerOptions, 'name' | 'targetDir' | 'runDir' | 'hub'> = {}, hub?: MockHub): Promise<Stack & { stop: () => Promise<void> }> {
  const env = qaEnv();
  const h = hub ?? (await new MockHub().start());
  const server = await new AlibiServer({ name, targetDir: env.targetDir, runDir: env.runDir, hub: h, ...opts }).start();
  return {
    hub: h,
    server,
    api: new Api(server.url),
    stop: async () => {
      await server.stop();
      if (!hub) await h.stop();
    },
  };
}

// ------------------------------------------------------------------ minimal types for API payloads

export interface Bundle {
  investigation: any;
  hypotheses: any[];
  experiments: any[];
  evidence: any[];
  sources: any[];
  patches: any[];
  modelCalls: any[];
  queuePosition: number;
}
