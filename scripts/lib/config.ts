import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the alibi-qa repository. */
export const QA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface QaConfig {
  repo: string;
  commit: string;
  expectedSubject: string | null;
  deps: 'copy' | 'npm-ci';
  /** 'worktree' tests the commit plus uncommitted changes; 'commit' tests the commit exactly. */
  source: 'commit' | 'worktree';
  workDir: string;
  keep: boolean;
  docker: { nodeImage: string; mavenImage: string; pythonImage: string; goImage: string };
}

/** Reads only ALIBI_QA_* keys from an optional .env; every other key is ignored on purpose. */
function readQaDotenv(): Record<string, string> {
  const file = join(QA_ROOT, '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(ALIBI_QA_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadQaConfig(): QaConfig {
  const file = JSON.parse(readFileSync(join(QA_ROOT, 'qa.config.json'), 'utf8'));
  const env = { ...readQaDotenv(), ...pick(process.env, /^ALIBI_QA_/) };
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(QA_ROOT, p));
  const deps = (env.ALIBI_QA_DEPS ?? file.deps ?? 'copy') as QaConfig['deps'];
  if (deps !== 'copy' && deps !== 'npm-ci') throw new Error(`ALIBI_QA_DEPS must be "copy" or "npm-ci" (got "${deps}")`);
  const source = (env.ALIBI_QA_SOURCE ?? file.source ?? 'commit') as QaConfig['source'];
  if (source !== 'commit' && source !== 'worktree') throw new Error(`ALIBI_QA_SOURCE must be "commit" or "worktree" (got "${source}")`);
  if (env.ALIBI_QA_ALLOW_PAID_APIS) {
    throw new Error('ALIBI_QA_ALLOW_PAID_APIS is set. Live/paid provider runs are not implemented in this suite and require explicit future approval.');
  }
  return {
    repo: abs(env.ALIBI_QA_REPO ?? file.repo),
    commit: env.ALIBI_QA_COMMIT ?? file.commit,
    expectedSubject: env.ALIBI_QA_COMMIT ? null : file.expectedSubject ?? null,
    deps,
    source,
    workDir: abs(env.ALIBI_QA_WORK_DIR ?? file.workDir ?? '.work'),
    keep: env.ALIBI_QA_KEEP === '1',
    docker: file.docker,
  };
}

function pick(obj: NodeJS.ProcessEnv, re: RegExp): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => re.test(k) && v !== undefined)) as Record<string, string>;
}

/**
 * Environment passed to every child process the suite starts. Built from an
 * allowlist so provider keys exported in the developer's shell never reach the
 * application under test or the test workers.
 */
export function scrubbedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'TERM', 'SHELL', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'PLAYWRIGHT_BROWSERS_PATH', 'CI', 'FORCE_COLOR', 'NO_COLOR']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Names of environment variables that would mean a real provider credential is in scope. */
export const PROVIDER_SECRET_VARS = ['NEBIUS_API_KEY', 'TAVILY_API_KEY', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'NEBIUS_PROJECT_ID'];
