/**
 * Builders for sanitized GitHub Actions run fixtures served by the mock.
 * Repositories, users, and SHAs are synthetic.
 */
import { randomInt } from 'node:crypto';
import { fixtureText } from './harness.ts';
import type { GhRunFixture } from './mocks/hub.ts';

const JEST_PACKAGE = JSON.stringify({ name: 'widget-service', version: '1.0.0', scripts: { test: 'jest --ci' }, devDependencies: { jest: '29.7.0' } });

let seq = 0;
/** Unique run ids per process so dedupe keys never collide across tests. */
export function nextRunId(): number {
  return 9_100_000_000 + randomInt(0, 900_000) * 1000 + ++seq;
}

function sha(tag: string, n: number): string {
  return (tag.replace(/[^0-9a-f]/g, '') + n.toString(16).padStart(8, '0')).padEnd(40, 'c').slice(0, 40);
}

export interface RunOptions {
  repo?: string;
  log?: string;
  logStatus?: number;
  jobs?: GhRunFixture['jobs'];
  diff?: string | null;
  framework?: 'jest' | 'unknown';
  runError?: number;
  conclusion?: string;
  status?: string;
}

/** A failed run of qa-org/<repo> whose only failed job serves `log`. */
export function ghRun(opts: RunOptions = {}): GhRunFixture & { url: string } {
  const runId = nextRunId();
  const jobId = runId + 7;
  const diff = opts.diff === undefined ? fixtureText('github/diffs/jest-regression.diff') : opts.diff;
  const repo = opts.repo ?? 'widget-service';
  return {
    owner: 'qa-org',
    repo,
    runId,
    headSha: sha('a11b1', runId % 1e8),
    parentSha: sha('b22b2', runId % 1e8),
    name: 'CI',
    headBranch: 'main',
    status: opts.status,
    conclusion: opts.conclusion,
    runError: opts.runError,
    jobs: opts.jobs ?? [
      { id: jobId - 1, name: 'lint', conclusion: 'success' },
      { id: jobId, name: 'test (node 20)', conclusion: 'failure' },
    ],
    logs: { [jobId]: opts.logStatus ? { status: opts.logStatus } : { body: opts.log ?? fixtureText('logs/jest-regression.log') } },
    artifacts: [{ name: 'coverage', size_in_bytes: 1024, expired: false }],
    compareDiff: diff ?? undefined,
    commitFiles: diff ? [{ filename: 'src/rounding.js', additions: 1, deletions: 1 }] : [],
    files: opts.framework === 'unknown' ? {} : { 'package.json': JEST_PACKAGE },
    url: `https://github.com/qa-org/${repo}/actions/runs/${runId}`,
  };
}

/**
 * Synthetic secret canaries, assembled at runtime so the repository never
 * contains a literal token-shaped string. Each value matches the shape of a
 * real credential format but is not a credential.
 */
export function secretCanaries(): Record<string, string> {
  const j = (...p: string[]) => p.join('');
  return {
    githubClassic: j('gh', 'p_', 'QAFAKE', '0123456789abcdefghijklmnopqrstuv'),
    githubFineGrained: j('github', '_pat_', '11QAFAKE00', '_qafakeqafakeqafakeqafakeqafake'),
    npm: j('np', 'm_', 'QAFAKEqafake0123456789qafakeQAFAKE01'),
    tavily: j('tv', 'ly-', 'qafake0123456789'),
    awsKeyId: j('AK', 'IA', 'QAFAKE0000000000'),
    slack: j('xo', 'xb-', '000000000-qafakeqafake'),
    openaiStyle: j('s', 'k-', 'qafake0123456789qafake0123'),
    jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJxYS1mYWtlIn0', '.', 'qafakeSignature0123'),
    urlPassword: 'qa-fake-url-pass-7731',
    bearer: j('qa', 'fakebearer', '0a1b2c3d4e5f'),
    assignment: j('qa', '-fake-assigned-', 'secret-9f8e'),
    privateKeyBody: j('MIIEqaFAKEqaFAKE', 'qaFAKEqaFAKEqaFAKE'),
  };
}

/** A CI log that embeds every canary in the way real logs leak secrets. */
export function secretBearingLog(c = secretCanaries()): string {
  const pk = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
  const pkEnd = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
  const lines = [
    '##[group]Run npm test',
    `echo "using ${c.githubClassic}"`,
    `git clone https://x-access-token:${c.urlPassword}@github.com/qa-org/widget-service`,
    `npm config set //registry.npmjs.org/:_authToken=${c.npm}`,
    `export GITHUB_PAT=${c.githubFineGrained}`,
    `TAVILY_API_KEY=${c.tavily}`,
    `aws configure set aws_access_key_id ${c.awsKeyId}`,
    `curl -H "Authorization: Bearer ${c.bearer}" https://api.example.invalid/`,
    `SLACK_WEBHOOK_TOKEN=${c.slack}`,
    `OPENAI_KEY: ${c.openaiStyle}`,
    `session=${c.jwt}`,
    `DEPLOY_SECRET="${c.assignment}"`,
    pk,
    c.privateKeyBody,
    pkEnd,
    'FAIL test/rounding.test.js',
    '  ● roundCurrency › rounds half up to two decimals',
    '    Expected: 10.13',
    '    Received: 10.12',
    'Tests:       1 failed, 4 passed, 5 total',
    '##[error]Process completed with exit code 1.',
  ];
  return lines.map((l, i) => `2026-10-14T12:00:${String(i).padStart(2, '0')}.0000000Z ${l}`).join('\n');
}
