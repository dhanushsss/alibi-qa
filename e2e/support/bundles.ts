/**
 * Synthetic, internally consistent investigation bundles for route-mocked UI
 * states that the offline server cannot produce (validated and failed fixes,
 * contradicted hypotheses, agent outcomes). Every reference resolves; the
 * suite's integrity checker is run on these bundles too.
 */
export type FixVariant = 'VERIFIED' | 'REJECTED';

const T = '2026-10-16T10:00:00.000Z';
const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

export function richBundle(variant: FixVariant = 'VERIFIED', id = `inv_qaui${variant.toLowerCase()}`) {
  const exp = (eid: string, kind: string, title: string, status: string, over: Record<string, unknown> = {}) => ({
    id: eid, investigationId: id, hypothesisKey: 'H1', kind, title, reason: `QA: ${title}`, status, backend: kind === 'external_search' ? 'none' : 'docker',
    command: kind === 'external_search' ? null : ['node', 'node_modules/jest/bin/jest.js', '--ci'], environment: kind === 'external_search' ? null : { backend: 'docker', image: 'node:20-bookworm-slim', network: 'none' },
    commitSha: SHA, testSelection: 'test/a.test.js', plannedAttempts: 1, startedAt: T, finishedAt: T, durationMs: 1000, result: null, observation: null, effect: null, patchId: null, ...over,
  });
  const runs = (exits: number[]) => {
    const attempts = exits.map((c, i) => ({ index: i + 1, exitCode: c, passed: c === 0, timedOut: false, durationMs: 900, tests: { total: 3, passed: c ? 2 : 3, failed: c ? 1 : 0, failedNames: c ? ['a fails at the boundary'] : [] }, outputTail: c ? 'FAIL test/a.test.js\n  ● a fails at the boundary\n    Expected: 1\n    Received: 2' : 'PASS test/a.test.js' }));
    const failures = exits.filter((c) => c !== 0).length;
    return { attempts, passes: exits.length - failures, failures };
  };
  const p2ok = variant === 'VERIFIED';
  const experiments = [
    exp('exp_qa_reproduce', 'reproduce', 'Reproduce the failure', 'failed', { result: runs([1]) }),
    exp('exp_qa_repeat', 'repeat', 'Run the failing test 3× with varied seeds', 'failed', { hypothesisKey: 'H2', plannedAttempts: 3, result: runs([1, 1, 1]) }),
    exp('exp_qa_parent', 'compare_parent', 'Compare against the parent commit', 'passed', { commitSha: PARENT, plannedAttempts: 3, result: runs([0, 0, 0]) }),
    exp('exp_qa_search', 'external_search', 'Search for external evidence', 'skipped', { hypothesisKey: 'H3', testSelection: null, plannedAttempts: 0, command: null, observation: 'Skipped: TAVILY_API_KEY is not configured.' }),
    exp('exp_qa_val1', 'validate_patch', 'Validate: Targeted fix by qa-model', 'failed', { patchId: 'patch_qa1', plannedAttempts: 3, result: runs([1, 1, 1]) }),
    exp('exp_qa_val2', 'validate_patch', 'Validate: Revert src/a.js to the parent commit', p2ok ? 'passed' : 'failed', { patchId: 'patch_qa2', plannedAttempts: 3, result: runs(p2ok ? [0, 0, 0] : [1, 1, 1]) }),
    ...(p2ok ? [exp('exp_qa_suite2', 'regression_suite', 'Regression suite: Revert src/a.js to the parent commit', 'passed', { patchId: 'patch_qa2', testSelection: 'full test suite + patch', result: runs([0]) })] : []),
  ];
  let seq = 0;
  const ev = (kind: string, title: string, over: Record<string, unknown> = {}) => ({
    id: `ev_qa${String(++seq).padStart(2, '0')}`, investigationId: id, seq, kind, title, detail: `QA detail for ${title}`, hypothesisKey: null, experimentId: null, sourceId: null, effect: null, provenance: { type: 'policy', ref: 'qa' }, createdAt: T, ...over,
  });
  const evidence = [
    ev('observed_fact', 'Failing test: a fails at the boundary', { provenance: { type: 'log', lines: [5, 17] } }),
    ev('model_hypothesis', 'H1: The boundary comparison changed', { hypothesisKey: 'H1', provenance: { type: 'model', ref: 'qa-replay/model (replay)' } }),
    ev('model_hypothesis', 'H2: The test is flaky', { hypothesisKey: 'H2', provenance: { type: 'model', ref: 'qa-replay/model (replay)' } }),
    ev('model_hypothesis', 'H3: An upstream outage', { hypothesisKey: 'H3', provenance: { type: 'model', ref: 'qa-replay/model (replay)' } }),
    ev('experiment_result', 'Reproduce the failure @ aaaaaaaaaaaa: 1/1 run failed', { hypothesisKey: 'H1', experimentId: 'exp_qa_reproduce', provenance: { type: 'experiment', ref: 'exp_qa_reproduce' } }),
    ev('inference', 'Supports H1', { hypothesisKey: 'H1', experimentId: 'exp_qa_reproduce', effect: 'supports' }),
    ev('experiment_result', 'Run the failing test 3× @ aaaaaaaaaaaa: 3/3 runs failed', { hypothesisKey: 'H2', experimentId: 'exp_qa_repeat', provenance: { type: 'experiment', ref: 'exp_qa_repeat' } }),
    ev('inference', 'Contradicts H2', { hypothesisKey: 'H2', experimentId: 'exp_qa_repeat', effect: 'contradicts' }),
    ev('experiment_result', 'Compare against the parent commit @ bbbbbbbbbbbb: 0/3 runs failed', { hypothesisKey: 'H1', experimentId: 'exp_qa_parent', provenance: { type: 'experiment', ref: 'exp_qa_parent' } }),
    ev('inference', 'Supports H1', { hypothesisKey: 'H1', experimentId: 'exp_qa_parent', effect: 'supports' }),
    ev('assumption', 'No external search', { experimentId: 'exp_qa_search' }),
    ev('inference', 'Verdict after experiments: probable — code regression', { hypothesisKey: 'H1' }),
    ev('experiment_result', 'Candidate failed validation: Targeted fix by qa-model', { hypothesisKey: 'H1', experimentId: 'exp_qa_val1' }),
    ev('experiment_result', `Candidate ${p2ok ? 'validated' : 'failed validation'}: Revert src/a.js to the parent commit`, { hypothesisKey: 'H1', experimentId: 'exp_qa_val2', effect: p2ok ? 'supports' : null }),
    ev('inference', `Outcome: diagnosis ${p2ok ? 'CONFIRMED' : 'PROBABLE'} · fix ${variant}`),
    ev('inference', `Final verdict: ${p2ok ? 'confirmed' : 'probable'} — code regression`, { hypothesisKey: 'H1' }),
  ];
  const patch = (pid: string, title: string, status: string, over: Record<string, unknown> = {}) => ({
    id: pid, investigationId: id, origin: 'deterministic', strategy: 'code_patch', title, rationale: 'QA', diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x >\n+x >=\n', files: ['src/a.js'], status, validation: null, prUrl: null, prBranch: null, createdAt: T, ...over,
  });
  const patches = [
    patch('patch_qa1', 'Targeted fix by qa-model', 'failed', { origin: 'replay', validation: { targetedExperimentId: 'exp_qa_val1', suiteExperimentId: 'exp_qa_val1', summary: 'Targeted runs: 3/3 runs failed.' } }),
    patch('patch_qa2', 'Revert src/a.js to the parent commit', p2ok ? 'validated' : 'failed', { validation: { targetedExperimentId: 'exp_qa_val2', suiteExperimentId: p2ok ? 'exp_qa_suite2' : 'exp_qa_val2', summary: p2ok ? 'Passed 3/3 targeted runs and the full regression suite.' : 'Targeted runs: 3/3 runs failed.' } }),
    ...(p2ok ? [patch('patch_qa3', 'Quarantine "a fails at the boundary"', 'proposed', { strategy: 'quarantine' })] : []),
  ];
  const hyp = (key: string, cause: string, category: string, status: string, rank: number, supporting: unknown[] = []) => ({ id: `hyp_qa_${key}`, investigationId: id, key, cause, category, origin: 'replay', supporting, contradicting: [], prior: 'medium', status, assessment: `QA: ${status}`, nextExperiment: null, rank });
  const verdict = p2ok ? 'confirmed' : 'probable';
  return {
    investigation: {
      id, createdAt: T, updatedAt: T, status: 'completed', stage: 'Complete', source: 'demo', scenarioId: 'code-regression', mode: 'replay', repository: 'alibi-qa/ui-fixture', repoUrl: null,
      commitSha: SHA, parentSha: PARENT, branch: 'main', workflow: 'CI', job: 'test', runId: null, runUrl: null, prNumber: null, prUrl: null, commitMessage: 'refactor: boundary', commitAuthor: 'QA Fixture',
      framework: 'jest', failureSignature: 'jest: test/a.test.js › a fails at the boundary', classification: 'code_regression', summary: 'QA synthetic investigation.', verdict,
      confidence: { label: p2ok ? 'strong' : 'moderate', basis: ['Failure reproduced in a clean sandbox at the failing commit.', 'Parent commit: 0/3 runs failed.'] },
      primaryHypothesis: 'H1', recommendedAction: 'Review the validated remediation.', remediationType: p2ok ? 'code_patch' : 'none', limitations: [], error: null,
      logStats: { totalLines: 20, totalChars: 600, sentChars: 600, excerptCount: 1, redactions: 0 }, modelsUsed: { triage: 'qa-replay/model (replay)' },
      verdictHistory: [{ at: T, stage: 'Hypotheses formed', verdict: null, confidence: 'none', note: '3 hypotheses' }, { at: T, stage: 'Remediation tested', verdict, confidence: p2ok ? 'strong' : 'moderate', note: 'QA' }],
      options: { repeat: 3, requestedMode: 'replay' }, artifacts: [],
      agent: { iterations: 1, modelCalls: 1, executed: 0, rejected: 0, promptTokens: 1000, completionTokens: 100, elapsedMs: 1000, stopReason: 'model_concluded', stopDetail: 'The model concluded that the evidence is sufficient.', patchRetries: 0, diagnosis: p2ok ? 'CONFIRMED' : 'PROBABLE', fix: variant },
    },
    hypotheses: [
      hyp('H1', 'The boundary comparison changed', 'code_regression', 'supported', 0, [{ text: 'Expected: 1', logLine: 7, verified: true }]),
      hyp('H2', 'The test is flaky', 'flaky_test', 'refuted', 1),
      hyp('H3', 'An upstream outage', 'external_outage', 'inconclusive', 2),
    ],
    experiments,
    evidence,
    sources: [],
    patches,
    modelCalls: [],
    queuePosition: -1,
  };
}

export const SYNTHETIC_LOG = {
  totalLines: 20,
  from: 1,
  to: 20,
  lines: Array.from({ length: 20 }, (_, i) => (i === 6 ? '    Expected: 1' : i === 4 ? 'FAIL test/a.test.js' : `line ${i + 1}`)),
};
