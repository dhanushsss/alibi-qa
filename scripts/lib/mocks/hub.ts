/**
 * Local provider mocks hosted on one loopback HTTP server:
 *   /v1/*            Nebius Token Factory (OpenAI-compatible) with scripted responses
 *   /gh/*            GitHub REST API backed by sanitized fixtures
 *   /tavily/search   Tavily search (reached via the network guard's redirect)
 *
 * Every request is recorded so tests can assert what the application sent
 * (prompts, observations, credentials) — not just what it displayed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// ------------------------------------------------------------------ Nebius

export type Stage = 'triage' | 'verdict' | 'patch' | 'patch-retry' | 'loop' | 'ping' | 'unknown';

export type ModelReply =
  | { json: unknown; usage?: { prompt_tokens: number; completion_tokens: number } | null }
  | { content: string; usage?: { prompt_tokens: number; completion_tokens: number } | null }
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { delayMs: number; then: ModelReply }
  | { hang: true };

export interface ModelRule {
  stage: Stage;
  /** Only match when the last user message contains this text. */
  userIncludes?: string;
  /** Replies are consumed in order; the last one repeats when `repeatLast` is true. */
  replies: ModelReply[];
  repeatLast?: boolean;
}

export interface CapturedModelCall {
  at: number;
  stage: Stage;
  model: string;
  schemaName: string | null;
  responseFormat: string | null;
  system: string;
  user: string;
  messageCount: number;
  authorization: string | null;
  matched: boolean;
  reply: string;
}

export const MOCK_MODELS = ['qa-mock/nemotron-3-lightning', 'qa-mock/nemotron-3-super', 'qa-mock/nemotron-3-ultra', 'qa-mock/embedding-model'];

function stageOf(system: string, user: string): Stage {
  if (/log-triage stage/.test(system)) return 'triage';
  if (/evidence-weighing stage/.test(system)) return 'verdict';
  if (/experiment-selection stage/.test(system)) return 'loop';
  if (/remediation stage/.test(system)) return /previous candidate FAILED validation/.test(user) ? 'patch-retry' : 'patch';
  if (/Reply with a JSON object only/.test(system)) return 'ping';
  return 'unknown';
}

class NebiusMock {
  rules: Array<ModelRule & { used: number }> = [];
  calls: CapturedModelCall[] = [];
  modelListStatus = 200;
  modelListCalls = 0;

  script(rules: ModelRule[]) {
    this.rules = rules.map((r) => ({ ...r, used: 0 }));
    this.calls = [];
  }
  reset() {
    this.script([]);
    this.modelListStatus = 200;
    this.modelListCalls = 0;
  }
  callsFor(stage: Stage) {
    return this.calls.filter((c) => c.stage === stage);
  }
  /** Calls that matched no rule: the application asked for something the test did not script. */
  unscripted() {
    return this.calls.filter((c) => !c.matched);
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string, body: string) {
    const auth = req.headers.authorization ?? null;
    if (path === '/v1/models' && req.method === 'GET') {
      this.modelListCalls++;
      if (this.modelListStatus !== 200) return send(res, this.modelListStatus, { error: { message: 'mock catalog unavailable' } });
      return send(res, 200, { object: 'list', data: MOCK_MODELS.map((id) => ({ id, object: 'model' })) });
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, { error: { message: 'invalid json' } });
      }
      const messages: Array<{ role: string; content: string }> = parsed.messages ?? [];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
      const stage = stageOf(system, firstUser);
      const rule = this.rules.find((r) => r.stage === stage && (!r.userIncludes || firstUser.includes(r.userIncludes)) && (r.used < r.replies.length || (r.repeatLast && r.replies.length)));
      const call: CapturedModelCall = {
        at: Date.now(),
        stage,
        model: parsed.model,
        schemaName: parsed.response_format?.json_schema?.name ?? null,
        responseFormat: parsed.response_format?.type ?? null,
        system,
        user: firstUser,
        messageCount: messages.length,
        authorization: auth,
        matched: Boolean(rule),
        reply: '',
      };
      this.calls.push(call);
      if (!rule) {
        call.reply = 'unscripted';
        return send(res, 500, { error: { message: `alibi-qa mock: no scripted reply for stage "${stage}"` } });
      }
      const reply = rule.replies[Math.min(rule.used, rule.replies.length - 1)];
      rule.used++;
      return this.reply(res, reply, parsed.model, call);
    }
    return send(res, 404, { error: { message: `mock: unknown Nebius route ${path}` } });
  }

  private async reply(res: ServerResponse, r: ModelReply, model: string, call: CapturedModelCall): Promise<void> {
    if ('hang' in r) {
      call.reply = 'hang';
      return; // never answers; the client must time out
    }
    if ('delayMs' in r) {
      await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (res.destroyed) return;
      return this.reply(res, r.then, model, call);
    }
    if ('status' in r) {
      call.reply = `http ${r.status}`;
      return send(res, r.status, r.body ?? { error: { message: `mock HTTP ${r.status}` } }, r.headers);
    }
    const content = 'json' in r ? JSON.stringify(r.json) : r.content;
    call.reply = 'json' in r ? 'json' : 'content';
    const usage = r.usage === null ? undefined : r.usage ?? { prompt_tokens: 1000, completion_tokens: 200 };
    return send(res, 200, {
      id: `chatcmpl-qa-${call.at}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}),
    });
  }
}

// ------------------------------------------------------------------ GitHub

export interface GhRunFixture {
  owner: string;
  repo: string;
  runId: number;
  runAttempt?: number;
  headSha: string;
  parentSha: string | null;
  name?: string;
  headBranch?: string;
  status?: string;
  conclusion?: string;
  /** Force an HTTP error for GET run (e.g. 500 outage, 404). */
  runError?: number;
  jobs: Array<{ id: number; name: string; conclusion: string }>;
  /** Log per job id: body (served via a signed-URL style redirect) or an HTTP error. */
  logs: Record<number, { body?: string; status?: number }>;
  artifacts?: Array<{ name: string; size_in_bytes: number; expired: boolean }>;
  compareDiff?: string;
  commitFiles?: Array<{ filename: string; additions: number; deletions: number }>;
  /** Repository files visible through the contents API, for framework detection. */
  files?: Record<string, string>;
}

export interface CapturedGhRequest {
  method: string;
  path: string;
  hasAuth: boolean;
  /** Only for the redirected log download: true would mean the token leaked to the log host. */
  authOnRedirect?: boolean;
}

class GitHubMock {
  runs = new Map<string, GhRunFixture>();
  requests: CapturedGhRequest[] = [];
  writes: CapturedGhRequest[] = [];
  base = '';

  addRun(f: GhRunFixture) {
    this.runs.set(`${f.owner}/${f.repo}#${f.runId}`, f);
  }
  reset() {
    this.runs.clear();
    this.requests = [];
    this.writes = [];
  }

  private findRun(owner: string, repo: string, id: number) {
    return this.runs.get(`${owner}/${repo}#${id}`);
  }
  /** A run of this repository, preferring the one whose head (or parent) is `sha`. */
  private findByRepo(owner: string, repo: string, sha?: string) {
    const runs = [...this.runs.values()].filter((r) => r.owner === owner && r.repo === repo);
    if (!sha) return runs[0];
    return runs.find((r) => r.headSha === sha) ?? runs.find((r) => r.parentSha === sha);
  }

  handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const rec: CapturedGhRequest = { method: req.method ?? 'GET', path, hasAuth: Boolean(req.headers.authorization) };
    this.requests.push(rec);
    if (req.method !== 'GET') {
      // Draft-PR creation and any other write: never expected in this suite.
      this.writes.push(rec);
      return send(res, 403, { message: 'alibi-qa mock: writes are not allowed' });
    }
    let m: RegExpExecArray | null;
    if (path === '/user') return send(res, 200, { login: 'qa-mock-user' }, { 'x-oauth-scopes': 'repo' });
    if ((m = /^\/__logs\/(\d+)$/.exec(path))) {
      rec.authOnRedirect = rec.hasAuth;
      const run = [...this.runs.values()].find((r) => r.logs[Number(m![1])]);
      const log = run?.logs[Number(m[1])];
      if (!log) return send(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(log.body ?? '');
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/.exec(path))) {
      const run = this.findRun(m[1], m[2], Number(m[3]));
      if (!run) return send(res, 404, { message: 'Not Found' });
      if (run.runError) return send(res, run.runError, { message: `mock error ${run.runError}` });
      return send(res, 200, {
        id: run.runId,
        name: run.name ?? 'CI',
        head_branch: run.headBranch ?? 'main',
        head_sha: run.headSha,
        run_attempt: run.runAttempt ?? 1,
        status: run.status ?? 'completed',
        conclusion: run.conclusion ?? 'failure',
        html_url: `https://github.com/${run.owner}/${run.repo}/actions/runs/${run.runId}`,
        head_commit: { message: `qa: fixture commit for run ${run.runId}`, author: { name: 'QA Fixture' } },
        pull_requests: [],
      });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(path))) {
      const run = this.findRun(m[1], m[2], Number(m[3]));
      if (!run) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { total_count: run.jobs.length, jobs: run.jobs.map((j) => ({ ...j, html_url: `https://github.com/${run.owner}/${run.repo}/actions/runs/${run.runId}/job/${j.id}` })) });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/artifacts$/.exec(path))) {
      const run = this.findRun(m[1], m[2], Number(m[3]));
      return send(res, 200, { total_count: run?.artifacts?.length ?? 0, artifacts: run?.artifacts ?? [] });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)\/logs$/.exec(path))) {
      const run = [...this.runs.values()].find((r) => r.owner === m![1] && r.repo === m![2] && r.logs[Number(m![3])]);
      const log = run?.logs[Number(m[3])];
      if (!log) return send(res, 404, { message: 'Not Found' });
      if (log.status) return send(res, log.status, { message: `mock log error ${log.status}` });
      res.writeHead(302, { location: `${this.base}/gh/__logs/${m[3]}` });
      return res.end();
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)\/pulls$/.exec(path))) return send(res, 200, []);
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)$/.exec(path))) {
      const run = this.findByRepo(m[1], m[2], m[3]);
      if (!run) return send(res, 404, { message: 'Not Found' });
      const isHead = m[3] === run.headSha;
      return send(res, 200, {
        sha: m[3],
        parents: isHead && run.parentSha ? [{ sha: run.parentSha }] : [],
        commit: { message: 'qa: fixture commit', author: { name: 'QA Fixture' } },
        files: isHead ? run.commitFiles ?? [] : [],
      });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(path))) {
      const run = this.findByRepo(m[1], m[2], m[4]);
      if (!run?.compareDiff || run.parentSha !== m[3]) return send(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(run.compareDiff);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path))) {
      const run = this.findByRepo(m[1], m[2]);
      const content = run?.files?.[decodeURIComponent(m[3])];
      if (content === undefined) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path))) {
      return send(res, 200, { full_name: `${m[1]}/${m[2]}`, html_url: `https://github.com/${m[1]}/${m[2]}`, private: false, default_branch: 'main' });
    }
    void query;
    return send(res, 404, { message: `alibi-qa mock: unknown GitHub route ${path}` });
  }
}

// ------------------------------------------------------------------ Tavily

class TavilyMock {
  requests: Array<{ query: string; authorization: string | null }> = [];
  results: Array<{ title: string; url: string; content: string; score: number }> = [];
  reset() {
    this.requests = [];
    this.results = [];
  }
  handle(req: IncomingMessage, res: ServerResponse, body: string) {
    let q = '';
    try {
      q = JSON.parse(body).query ?? '';
    } catch {
      // ignore
    }
    this.requests.push({ query: q, authorization: req.headers.authorization ?? null });
    return send(res, 200, { query: q, results: this.results, response_time: 0.01, request_id: `qa-${this.requests.length}` });
  }
}

// ------------------------------------------------------------------ Hub

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export class MockHub {
  readonly nebius = new NebiusMock();
  readonly github = new GitHubMock();
  readonly tavily = new TavilyMock();
  private server: Server | null = null;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const u = new URL(req.url ?? '/', 'http://mock');
        const p = u.pathname;
        const done = (e: unknown) => send(res, 500, { error: { message: `mock failure: ${(e as Error).message}` } });
        try {
          if (p.startsWith('/v1/')) return void this.nebius.handle(req, res, p, body).catch(done);
          if (p.startsWith('/gh/')) return this.github.handle(req, res, p.slice(3), u.searchParams);
          if (p === '/tavily/search') return this.tavily.handle(req, res, body);
          return send(res, 404, { error: 'unknown mock route' });
        } catch (e) {
          done(e);
        }
      });
    });
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    this.github.base = this.url;
    return this;
  }

  get nebiusBaseUrl() {
    return `${this.url}/v1`;
  }
  get githubApiUrl() {
    return `${this.url}/gh`;
  }
  get tavilyUrl() {
    return `${this.url}/tavily`;
  }

  reset() {
    this.nebius.reset();
    this.github.reset();
    this.tavily.reset();
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((ok) => this.server!.close(() => ok()));
    this.server = null;
  }
}
