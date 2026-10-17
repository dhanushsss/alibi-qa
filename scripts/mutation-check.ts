/**
 * Mutation check for the hardening regressions (the 13 former probes).
 *
 * For each protection: copy the prepared candidate clone to an isolated
 * directory, disable exactly that protection with a single, exact source edit,
 * run only the regression tests that guard it, and require them to FAIL; then
 * run the same tests against the unmodified candidate and require them to PASS.
 * The original repository and the candidate clone are never edited.
 *
 *   tsx scripts/mutation-check.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadQaConfig, QA_ROOT, scrubbedEnv } from './lib/config.ts';
import { run } from './lib/exec.ts';
import { sanitize } from './lib/sanitize.mjs';
import { fingerprint, identifyTarget, prepareTarget, sameFingerprint } from './lib/target.ts';

interface Mutation {
  id: string;
  protection: string;
  file: string;
  find: string;
  replace: string;
  testFile: string;
  /** Exact test names (as in the source) that must fail under the mutation. */
  tests: string[];
}

const C2 = ['environment', 'envVars', 'variables', 'cwd'].map((k) => `[C2] rejects an environment/working-directory request passed as "${k}"`);

const MUTATIONS: Mutation[] = [
  {
    id: 'unknown-loop-args',
    protection: 'Unknown loop action fields are rejected (agentLoop.validateAction)',
    file: 'server/src/pipeline/agentLoop.ts',
    find: '  if (unknown.length) return { ok: false,',
    replace: '  if (false && unknown.length) return { ok: false,',
    testFile: 'agent-loop/policy.test.ts',
    tests: C2,
  },
  {
    id: 'bounded-loop-limits',
    protection: 'Loop limits must be non-negative integers (config.bounded)',
    file: 'server/src/config.ts',
    find: "  if (!/^\\d+$/.test(raw)) return fallback;\n  return Math.min(Number.parseInt(raw, 10), max);",
    replace: '  const n = Number.parseInt(raw, 10);\n  if (!Number.isFinite(n)) return fallback;\n  return Math.min(n, max);',
    testFile: 'agent-loop/wiring.test.ts',
    tests: ['[C7] negative limits are never accepted'],
  },
  {
    id: 'model-calls-deletion',
    protection: 'Deleting an investigation deletes its model_calls (Store.deleteInvestigation)',
    file: 'server/src/db/store.ts',
    find: "      this.db.prepare('DELETE FROM model_calls WHERE investigation_id = ?').run(id);\n",
    replace: '',
    testFile: 'api/reliability.test.ts',
    tests: ['[D12] model-call records of a deleted investigation are also removed'],
  },
  {
    id: 'supported-needs-experiment',
    protection: '"supported" requires a supporting experiment (guardHypothesisStatus)',
    file: 'server/src/pipeline/confidence.ts',
    find: "  if (status !== 'supported' || tally.s > 0) return { status, assessment };",
    replace: "  if (status !== 'supported' || tally.s > 0 || tally.c === 0) return { status, assessment };",
    testFile: 'scenarios/inconclusive.test.ts',
    tests: ['[A5] a hypothesis is only "supported" when an experiment supports it'],
  },
  {
    id: 'demo-provider-tests',
    protection: 'Provider connection tests are refused on the public demo (app.guardProviderTest)',
    file: 'server/src/app.ts',
    find: '    if (publicDemo) return sendError(reply, 403, `The ${provider} connection test is disabled on the public demo.`);\n',
    replace: '',
    testFile: 'security/http-abuse.test.ts',
    tests: ['[F8] provider-spending test endpoints are restricted in public demo mode'],
  },
  {
    id: 'option-like-test-paths',
    protection: 'Test paths with a segment starting with "-" are refused (frameworks.validateSelection)',
    file: 'server/src/runner/frameworks.ts',
    find: " && !sel.file.split('/').some((seg) => seg.startsWith('-'))",
    replace: '',
    testFile: 'security/policies.test.ts',
    tests: ['[F3] a selection starting with "-" cannot be read as a CLI option'],
  },
  {
    id: 'redaction-count',
    protection: 'Redaction count includes values removed at download (investigate.collect)',
    file: 'server/src/pipeline/investigate.ts',
    find: 'const redacted = red.count + (intake.preRedactions ?? 0);',
    replace: 'const redacted = red.count;',
    testFile: 'security/redaction.test.ts',
    tests: ['[F1] the ledger reports how many secrets were redacted'],
  },
  {
    id: 'redact-google',
    protection: 'Google API keys are redacted (redact.ts)',
    file: 'server/src/analysis/redact.ts',
    find: "  [/\\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED GOOGLE API KEY]'],\n",
    replace: '',
    testFile: 'security/redaction.test.ts',
    tests: ['[F1] a Google API key (AIza…) is redacted'],
  },
  {
    id: 'redact-stripe',
    protection: 'Stripe keys are redacted (redact.ts)',
    file: 'server/src/analysis/redact.ts',
    find: "  [/\\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\\b/g, '[REDACTED STRIPE KEY]'],\n",
    replace: '',
    testFile: 'security/redaction.test.ts',
    tests: ['[F1] a Stripe-style live key (sk_live_…) is redacted'],
  },
  {
    id: 'redact-azure',
    protection: 'Azure storage AccountKey values are redacted (redact.ts)',
    file: 'server/src/analysis/redact.ts',
    find: "  [/\\b(AccountKey=)[A-Za-z0-9+/]{20,}={0,2}/g, '$1[REDACTED]'],\n",
    replace: '',
    testFile: 'security/redaction.test.ts',
    tests: ['[F1] an Azure storage AccountKey is redacted'],
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Outcome {
  name: string;
  status: string;
}

/** Runs the named tests of one file against `targetDir`; returns each named test's status. */
function runTests(targetDir: string, runDir: string, testFile: string, names: string[]): Promise<Outcome[]> {
  mkdirSync(join(runDir, 'servers', 'whitebox-data'), { recursive: true });
  const results = join(runDir, 'results.jsonl');
  rmSync(results, { force: true });
  const pattern = `^(${names.map(escapeRe).join('|')})$`;
  const argv = ['--import', 'tsx', '--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, `--test-reporter=${join(QA_ROOT, 'scripts/lib/reporter.mjs')}`, `--test-reporter-destination=${results}`, join(QA_ROOT, testFile)];
  const env = scrubbedEnv({ ALIBI_DATA_DIR: join(runDir, 'servers', 'whitebox-data'), ALIBI_RUNNER: 'disabled', ALIBI_QA_TARGET_DIR: targetDir, ALIBI_QA_RUN_DIR: runDir, ALIBI_QA_RUN_ID: `mut-${Date.now()}`, ALIBI_QA_DOCKER: '0', FORCE_COLOR: '0' });
  return new Promise((ok) => {
    const child = spawn(process.execPath, argv, { cwd: QA_ROOT, env, stdio: 'ignore' });
    child.on('close', () => {
      const rows = existsSync(results) ? readFileSync(results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      ok(names.map((n) => ({ name: n, status: rows.find((r: any) => r.kind === 'test' && r.name === n)?.status ?? 'not-run' })));
    });
  });
}

async function main() {
  const cfg = loadQaConfig();
  const target = await identifyTarget(cfg);
  const before = await fingerprint(cfg.repo);
  const prepared = await prepareTarget(cfg, target, (m) => console.log(`[mutations] ${m}`));
  console.log(`[mutations] candidate ${prepared.revision}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const root = join(cfg.workDir, 'mutants', stamp);
  const rows: Array<{ id: string; protection: string; file: string; tests: string[]; mutant: Outcome[]; fixed: Outcome[]; killed: boolean; error?: string }> = [];

  for (const m of MUTATIONS) {
    const dir = join(root, m.id, 'target');
    const runDir = join(root, m.id, 'run');
    let error: string | undefined;
    let mutant: Outcome[] = [];
    let fixed: Outcome[] = [];
    try {
      mkdirSync(join(root, m.id), { recursive: true });
      const cp = await run('cp', ['-cR', prepared.dir, dir]);
      if (cp.code !== 0) throw new Error(`copy failed: ${cp.stderr}`);
      const path = join(dir, m.file);
      const src = readFileSync(path, 'utf8');
      const count = src.split(m.find).length - 1;
      if (count !== 1) throw new Error(`mutation anchor found ${count} times in ${m.file} (expected exactly 1)`);
      writeFileSync(path, src.replace(m.find, m.replace));
      mutant = await runTests(dir, join(runDir, 'mutant'), m.testFile, m.tests);
      fixed = await runTests(prepared.dir, join(runDir, 'fixed'), m.testFile, m.tests);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      rmSync(join(root, m.id), { recursive: true, force: true });
    }
    const killed = !error && mutant.every((o) => o.status === 'failed') && fixed.every((o) => o.status === 'passed');
    rows.push({ id: m.id, protection: m.protection, file: m.file, tests: m.tests, mutant, fixed, killed, error });
    console.log(`[mutations] ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.id}: mutant=[${mutant.map((o) => o.status).join(',')}] fixed=[${fixed.map((o) => o.status).join(',')}]${error ? ` error=${error}` : ''}`);
  }
  rmSync(root, { recursive: true, force: true });

  const after = await fingerprint(cfg.repo);
  const tests = rows.reduce((n, r) => n + r.tests.length, 0);
  const json = { schema: 'alibi-qa/mutations@1', candidate: prepared.revision, baseCommit: prepared.commit, originalRepositoryUnchanged: sameFingerprint(before, after), mutations: rows.length, testsCovered: tests, killed: rows.filter((r) => r.killed).length, rows };
  const md = [
    `# Hardening regression mutation check — ${prepared.revision}`,
    '',
    `Each protection was disabled in an isolated copy of the candidate; its regression tests had to fail there and pass on the unmodified candidate.`,
    '',
    `**${json.killed}/${rows.length} protections verified** (${tests} regression tests). Original repository unchanged: ${json.originalRepositoryUnchanged ? 'yes' : 'NO'}.`,
    '',
    '| Protection | Disabled in | Tests | With protection disabled | With protection | Verdict |',
    '|---|---|---:|---|---|---|',
    ...rows.map((r) => `| ${r.protection} | \`${r.file}\` | ${r.tests.length} | ${r.mutant.map((o) => o.status).join(', ') || '—'} | ${r.fixed.map((o) => o.status).join(', ') || '—'} | ${r.killed ? 'verified' : `**not verified**${r.error ? ` (${r.error})` : ''}`} |`),
    '',
  ].join('\n');
  const out = join(QA_ROOT, 'reports', 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `mutations-${stamp}.json`), JSON.stringify(json, null, 2));
  writeFileSync(join(out, `mutations-${stamp}.md`), sanitize(md));
  writeFileSync(join(out, 'latest-mutations.md'), sanitize(md));
  console.log(`[mutations] ${json.killed}/${rows.length} verified; report ${relative(QA_ROOT, join(out, `mutations-${stamp}.md`))}`);
  process.exitCode = json.killed === rows.length && json.originalRepositoryUnchanged ? 0 : 1;
}

main().catch((e) => {
  console.error(`[mutations] ${e instanceof Error ? e.message : e}`);
  process.exitCode = 2;
});
