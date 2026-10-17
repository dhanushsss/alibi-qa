/**
 * Builds the human-readable (Markdown) and machine-readable (JSON) report for
 * a run from the raw results in .work/runs/<runId>/. `npm run report`
 * regenerates the report for the latest run.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQaConfig, QA_ROOT } from './lib/config.ts';
import { catalogFor } from './lib/catalog.ts';
import { sanitize, sanitizeDeep } from './lib/sanitize.mjs';

export interface TestResult {
  phase: string;
  file: string;
  name: string;
  path: string[];
  kind: 'test' | 'suite';
  status: 'passed' | 'failed' | 'skipped' | 'todo-failing' | 'todo-passing';
  durationMs: number;
  skipReason?: string;
  todo?: string;
  error?: { message: string; stack?: string };
}

function readNodeResults(phase: string, file: string): TestResult[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => ({ ...r, phase, file: relative(QA_ROOT, r.file === 'unknown' ? QA_ROOT : r.file) }));
}

function readPlaywright(file: string): { results: TestResult[]; suiteSkipped?: string } {
  if (!existsSync(file)) return { results: [] };
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.skippedSuite) return { results: [], suiteSkipped: json.reason };
  const out: TestResult[] = [];
  const walk = (suite: any, parents: string[]) => {
    for (const s of suite.suites ?? []) walk(s, s.title ? [...parents, s.title] : parents);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        const st = t.status === 'skipped' ? 'skipped' : t.status === 'expected' ? 'passed' : t.status === 'flaky' ? 'failed' : 'failed';
        const ann = (t.annotations ?? []).find((a: any) => a.type === 'skip');
        out.push({
          phase: 'e2e',
          file: `e2e/${spec.file ?? basename(suite.file ?? '')}`,
          name: `${spec.title}${t.projectName ? ` [${t.projectName}]` : ''}`,
          path: [...parents, spec.title],
          kind: 'test',
          status: st,
          durationMs: last?.duration ?? 0,
          skipReason: ann?.description,
          error: last?.error ? { message: sanitize(String(last.error.message ?? '')).slice(0, 4000), stack: sanitize(String(last.error.stack ?? '')).split('\n').slice(0, 12).join('\n') } : undefined,
        });
      }
    }
  };
  for (const s of json.suites ?? []) walk(s, []);
  return { results: out };
}

function requirementId(name: string): string | null {
  return /^\[([A-F]\d+)\]/.exec(name)?.[1] ?? null;
}

export function generateReport(runDir: string) {
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const results: TestResult[] = [];
  const skippedSuites: Array<{ phase: string; reason: string }> = [];
  for (const p of manifest.phases) {
    const before = results.length;
    if (p.kind === 'node') results.push(...readNodeResults(p.name, p.resultsFile));
    else {
      const pw = readPlaywright(p.resultsFile);
      results.push(...pw.results);
      if (pw.suiteSkipped) {
        skippedSuites.push({ phase: p.name, reason: pw.suiteSkipped });
        continue;
      }
    }
    const recorded = results.slice(before);
    // A phase that crashed, or exited non-zero without reporting a failure, must never read as green.
    if ((p.exitCode !== 0 && !recorded.some((r) => r.status === 'failed')) || (recorded.length === 0 && p.files.length > 0)) {
      results.push({
        phase: p.name,
        file: p.files.join(', ') || p.name,
        name: `phase "${p.name}" ${recorded.length === 0 ? 'reported no test results' : 'exited abnormally'} (exit code ${p.exitCode})`,
        path: [`phase ${p.name}`],
        kind: 'suite',
        status: 'failed',
        durationMs: 0,
        error: { message: 'The test process exited without reporting this failure. See the console output of the run.' },
      });
    }
  }
  const tests = results.filter((r) => r.kind === 'test');
  const suiteFailures = results.filter((r) => r.kind === 'suite' && r.status === 'failed');
  const count = (s: TestResult['status'][]) => tests.filter((t) => s.includes(t.status)).length;
  const summary = {
    total: tests.length,
    passed: count(['passed']),
    failed: count(['failed']) + suiteFailures.length,
    skipped: count(['skipped']),
    todo: count(['todo-failing', 'todo-passing']),
    probesFailing: count(['todo-failing']),
  };

  const byFile = new Map<string, TestResult[]>();
  for (const t of tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  const files = [...byFile.entries()].map(([file, ts]) => {
    const c = catalogFor(file);
    return {
      file,
      area: c?.area ?? 'other',
      realism: c?.realism ?? '',
      real: c?.real ?? [],
      mocked: c?.mocked ?? [],
      passed: ts.filter((t) => t.status === 'passed').length,
      failed: ts.filter((t) => t.status === 'failed').length,
      skipped: ts.filter((t) => t.status === 'skipped').length,
      todo: ts.filter((t) => t.status.startsWith('todo')).length,
    };
  });

  const requirements = new Map<string, { passed: number; failed: number; skipped: number; todo: number; tests: string[] }>();
  for (const t of tests) {
    const id = requirementId(t.name);
    if (!id) continue;
    const r = requirements.get(id) ?? { passed: 0, failed: 0, skipped: 0, todo: 0, tests: [] };
    if (t.status === 'passed') r.passed++;
    else if (t.status === 'failed') r.failed++;
    else if (t.status === 'skipped') r.skipped++;
    else r.todo++;
    r.tests.push(t.name);
    requirements.set(id, r);
  }

  const json = sanitizeDeep({
    schema: 'alibi-qa/report@1',
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    selection: { suite: manifest.suite, tier: manifest.tier, grep: manifest.grep },
    target: manifest.target,
    underTest: manifest.underTest ?? { source: 'commit', revision: manifest.target.commit.slice(0, 7), changedFiles: [] },
    clone: manifest.clone,
    environment: { node: process.version, platform: process.platform, prereqs: manifest.prereqs },
    safety: {
      originalRepositoryUnchanged: manifest.originalRepo.unchanged,
      originalRepository: manifest.originalRepo,
      providerCalls: 'all provider traffic went to loopback mocks; outbound fetch from the server under test is blocked by the network guard',
      scrubbedShellVars: manifest.scrubbedShellVars,
      cleanup: manifest.cleanup,
    },
    summary,
    skippedSuites,
    files,
    requirements: Object.fromEntries([...requirements.entries()].sort()),
    failures: [...suiteFailures, ...tests.filter((t) => t.status === 'failed')].map((t) => ({ file: t.file, test: t.path.join(' › '), error: t.error })),
    skipped: tests.filter((t) => t.status === 'skipped').map((t) => ({ file: t.file, test: t.path.join(' › '), reason: t.skipReason ?? '' })),
    probes: tests.filter((t) => t.status.startsWith('todo')).map((t) => ({ file: t.file, test: t.path.join(' › '), status: t.status, note: t.todo ?? '', error: t.error?.message })),
    tests: tests.map((t) => ({ phase: t.phase, file: t.file, test: t.path.join(' › '), status: t.status, durationMs: t.durationMs })),
  });

  const md: string[] = [];
  const s = summary;
  md.push(`# Alibi QA report — ${manifest.runId} — ${manifest.underTest?.revision ?? manifest.target.commit.slice(0, 7)}`, '');
  md.push(`**Result:** ${s.failed === 0 ? 'no failing tests' : `${s.failed} failing`} · ${s.passed} passed · ${s.skipped} skipped · ${s.todo} probes (todo, not counted as passes)`, '');
  md.push('## Target', '');
  const ut = manifest.underTest ?? { source: 'commit', revision: manifest.target.commit.slice(0, 7), changedFiles: [], untrackedCopied: [], untrackedSkipped: [] };
  md.push(`- Repository: \`${sanitize(manifest.target.repo)}\``, `- **Code under test: \`${ut.revision}\`** (source: ${ut.source}; base commit \`${manifest.target.commit}\` — ${manifest.target.subject}${ut.changedFiles.length ? `; plus uncommitted changes to ${ut.changedFiles.length} file(s): ${ut.changedFiles.map((f: string) => `\`${f}\``).join(', ')}` : ''}${ut.untrackedCopied.length ? `; untracked files included: ${ut.untrackedCopied.length}` : ''}${ut.untrackedSkipped.length ? `; untracked media/databases not copied: ${ut.untrackedSkipped.length}` : ''})`, `- Tested in a disposable clone: \`${manifest.clone.dir}\` (dependencies: ${manifest.clone.deps}; QA scenario overlays: ${manifest.clone.overlays.join(', ') || 'none'})`, `- Selection: suite \`${manifest.suite}\`, tier \`${manifest.tier}\`${manifest.grep ? `, grep \`${manifest.grep}\`` : ''}`, '');
  md.push('## Safety', '');
  md.push(`- Original repository unchanged: **${manifest.originalRepo.unchanged ? 'yes' : 'NO'}** (HEAD, refs, working-tree status, stash compared before/after)`);
  md.push('- Provider traffic: loopback mocks only; the server under test runs with a fetch guard that blocks any non-loopback request. No paid API was called.');
  if (manifest.scrubbedShellVars.length) md.push(`- Provider variables found in the invoking shell and withheld from all child processes: ${manifest.scrubbedShellVars.join(', ')}`);
  md.push(`- Cleanup: ${manifest.cleanup.killedPids.length} leftover process(es) killed, ${manifest.cleanup.removedContainers.length} container(s) removed, run data ${manifest.cleanup.keptData ? 'kept (--keep)' : 'deleted'}`, '');
  md.push('## Prerequisites', '', '| Prerequisite | Needed for | Status |', '|---|---|---|');
  for (const p of manifest.prereqs) md.push(`| ${p.name} | ${p.neededFor} | ${p.ok ? 'ok' : `**missing** — ${sanitize(p.detail)}`} |`);
  md.push('');
  if (skippedSuites.length) {
    md.push('## Suites not run', '');
    for (const x of skippedSuites) md.push(`- ${x.phase}: ${sanitize(x.reason)}`);
    md.push('');
  }
  md.push('## Results by file', '', '| File | Area | Passed | Failed | Skipped | Probes | What is real / mocked |', '|---|---|---:|---:|---:|---:|---|');
  for (const f of files) md.push(`| \`${f.file}\` | ${f.area} | ${f.passed} | ${f.failed} | ${f.skipped} | ${f.todo} | ${f.realism}. Mocked: ${f.mocked.join(', ') || '—'} |`);
  md.push('');
  if (json.failures.length) {
    md.push('## Failures', '');
    for (const f of json.failures) {
      md.push(`### ${f.test}`, '', `File: \`${f.file}\``, '', '```', (f.error?.message ?? 'no message').split('\n').slice(0, 25).join('\n'), '```', '');
    }
  }
  if (json.probes.length) {
    md.push('## Probes (todo — hardening checks beyond documented guarantees)', '', 'A failing probe is a finding to review, not a regression. Probes never count as passes.', '');
    for (const p of json.probes) md.push(`- **${p.status === 'todo-failing' ? 'FINDING' : 'holds'}** — ${p.test}${p.note ? ` (${p.note})` : ''}${p.error ? `\n  - ${p.error.split('\n')[0]}` : ''}`);
    md.push('');
  }
  if (json.skipped.length) {
    md.push('## Skipped tests', '');
    const reasons = new Map<string, number>();
    for (const x of json.skipped) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
    for (const [r, n] of reasons) md.push(`- ${n} test(s): ${r || 'no reason given'}`);
    md.push('');
  }
  md.push('## Requirement coverage', '', '| ID | Passed | Failed | Skipped | Probes |', '|---|---:|---:|---:|---:|');
  for (const [id, r] of Object.entries(json.requirements) as Array<[string, any]>) md.push(`| ${id} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.todo} |`);
  md.push('');
  md.push('## All tests', '', '| Status | Test | File |', '|---|---|---|');
  for (const t of json.tests) md.push(`| ${t.status} | ${t.test.replace(/\|/g, '\\|')} | \`${t.file}\` |`);
  md.push('');

  const outDir = join(QA_ROOT, 'reports', 'out', manifest.runId);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, 'report.md');
  const jsonPath = join(outDir, 'report.json');
  writeFileSync(mdPath, sanitize(md.join('\n')));
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  copyFileSync(mdPath, join(QA_ROOT, 'reports', 'out', 'latest.md'));
  copyFileSync(jsonPath, join(QA_ROOT, 'reports', 'out', 'latest.json'));
  return { md: mdPath, json: jsonPath, summary };
}

// `npm run report`: regenerate for the most recent run.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadQaConfig();
  const runs = join(cfg.workDir, 'runs');
  const latest = existsSync(runs) ? readdirSync(runs).filter((d) => existsSync(join(runs, d, 'manifest.json'))).sort().pop() : undefined;
  if (!latest) {
    console.error('No completed run found. Run `npm test` first.');
    process.exitCode = 1;
  } else {
    const r = generateReport(join(runs, latest));
    console.log(`Report for run ${latest}:\n  ${relative(QA_ROOT, r.md)}\n  ${relative(QA_ROOT, r.json)}\n  ${r.summary.passed} passed, ${r.summary.failed} failed, ${r.summary.skipped} skipped, ${r.summary.todo} probes`);
  }
}
