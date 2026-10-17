/**
 * Evidence-integrity checks over a persisted investigation bundle.
 *
 * These are independent of how Alibi renders the data: they re-derive what the
 * records must satisfy (references resolve, skipped never reads as passed, a
 * validated patch has a passing fresh-sandbox run, outcomes match records) and
 * check the application's own Evidence Path projection against the records.
 */
import type { Bundle } from './harness.ts';

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

/** Checks that encode documented Alibi guarantees or the QA brief. */
export const DOCUMENTED_CHECKS = [
  'ledger.seq-contiguous',
  'ledger.refs-experiment',
  'ledger.refs-source',
  'ledger.refs-hypothesis',
  'ledger.effect-has-result',
  'hypothesis.contradicted-not-supported',
  'experiment.skipped-not-passed',
  'experiment.result-consistent',
  'patch.validated-has-passing-run',
  'patch.unvalidated-not-claimed',
  'outcome.fix-matches-patches',
  'outcome.diagnosis-matches-verdict',
  'verdict.confirmed-requires-strong',
  'verdict.primary-exists',
  'status.matches-verdict',
  // Promoted from a probe once Alibi enforced it (remediation item 10).
  'hypothesis.supported-backed-by-experiment',
] as const;

function check(id: string, problems: string[]): Check {
  return { id, ok: problems.length === 0, detail: problems.length ? problems.slice(0, 6).join('; ') : 'ok' };
}

export function tallies(b: Bundle): Map<string, { s: number; c: number }> {
  const t = new Map<string, { s: number; c: number }>();
  for (const h of b.hypotheses) t.set(h.key, { s: 0, c: 0 });
  for (const e of b.evidence) {
    if (e.kind !== 'inference' || !e.hypothesisKey || !e.experimentId || !t.has(e.hypothesisKey)) continue;
    if (e.effect === 'supports') t.get(e.hypothesisKey)!.s++;
    if (e.effect === 'contradicts') t.get(e.hypothesisKey)!.c++;
  }
  return t;
}

export function fixOutcomeOf(patches: Array<{ status: string }>): 'VERIFIED' | 'REJECTED' | 'NONE' {
  if (!patches.length) return 'NONE';
  if (patches.some((p) => p.status === 'validated')) return 'VERIFIED';
  return patches.every((p) => p.status === 'failed' || p.status === 'rejected') ? 'REJECTED' : 'NONE';
}

export function checkBundle(b: Bundle): Check[] {
  const inv = b.investigation;
  const exps = new Map(b.experiments.map((e) => [e.id, e]));
  const srcIds = new Set(b.sources.map((s) => s.id));
  const keys = new Set(b.hypotheses.map((h) => h.key));
  const patches = new Map(b.patches.map((p) => [p.id, p]));
  const out: Check[] = [];

  out.push(check('ledger.seq-contiguous', b.evidence.map((e, i) => (e.seq === i + 1 ? '' : `record ${e.id} has seq ${e.seq}, expected ${i + 1}`)).filter(Boolean)));
  out.push(check('ledger.refs-experiment', b.evidence.filter((e) => e.experimentId && !exps.has(e.experimentId)).map((e) => `#${e.seq} → missing experiment ${e.experimentId}`)));
  out.push(check('ledger.refs-source', b.evidence.filter((e) => e.sourceId && !srcIds.has(e.sourceId)).map((e) => `#${e.seq} → missing source ${e.sourceId}`)));
  out.push(check('ledger.refs-hypothesis', b.evidence.filter((e) => e.hypothesisKey && !keys.has(e.hypothesisKey)).map((e) => `#${e.seq} "${e.title}" → unknown hypothesis ${e.hypothesisKey}`)));
  out.push(
    check(
      'ledger.effect-has-result',
      b.evidence
        .filter((e) => e.kind === 'inference' && (e.effect === 'supports' || e.effect === 'contradicts') && e.experimentId)
        .filter((e) => {
          const x = exps.get(e.experimentId);
          return !x || !x.result || x.status === 'skipped' || x.status === 'error';
        })
        .map((e) => `#${e.seq} ${e.effect} from an experiment without a usable result`),
    ),
  );

  const t = tallies(b);
  out.push(
    check(
      'hypothesis.contradicted-not-supported',
      b.hypotheses.filter((h) => h.status === 'supported' && (t.get(h.key)?.c ?? 0) > 0 && (t.get(h.key)?.s ?? 0) === 0).map((h) => `${h.key} is "supported" but only contradicted by experiments`),
    ),
  );

  out.push(
    check(
      'experiment.skipped-not-passed',
      b.experiments
        .filter((e) => e.status === 'skipped')
        .flatMap((e) => [
          e.result ? `${e.id} skipped but has a result` : '',
          b.evidence.some((r) => r.experimentId === e.id && r.kind === 'experiment_result' && /pass/i.test(r.title)) ? `${e.id} skipped but a ledger result says it passed` : '',
          b.evidence.some((r) => r.experimentId === e.id && r.kind === 'inference' && r.effect && r.effect !== 'neutral') ? `${e.id} skipped but drives a supports/contradicts inference` : '',
        ])
        .filter(Boolean),
    ),
  );

  out.push(
    check(
      'experiment.result-consistent',
      b.experiments
        .filter((e) => e.backend === 'docker' && e.result && (e.status === 'passed' || e.status === 'failed'))
        .flatMap((e) => {
          const r = e.result;
          const p: string[] = [];
          if (r.passes + r.failures !== r.attempts.length) p.push(`${e.id}: passes+failures ≠ attempts`);
          for (const a of r.attempts) if (a.passed !== (a.exitCode === 0)) p.push(`${e.id} run ${a.index}: passed=${a.passed} but exit ${a.exitCode}`);
          if ((e.status === 'passed') !== (r.failures === 0)) p.push(`${e.id}: status ${e.status} but ${r.failures} failure(s)`);
          return p;
        }),
    ),
  );

  out.push(
    check(
      'patch.validated-has-passing-run',
      b.patches
        .filter((p) => p.status === 'validated')
        .flatMap((p) => {
          const tgt = exps.get(p.validation?.targetedExperimentId);
          const suite = exps.get(p.validation?.suiteExperimentId);
          const probs: string[] = [];
          if (!tgt) return [`${p.id} validated without a targeted experiment`];
          if (tgt.kind !== 'validate_patch' || tgt.patchId !== p.id) probs.push(`${p.id}: targeted experiment is not a validation run of this patch`);
          if (tgt.status !== 'passed' || !tgt.result?.attempts.length || tgt.result.attempts.some((a: any) => a.exitCode !== 0)) probs.push(`${p.id}: targeted run did not pass`);
          if (tgt.commitSha !== inv.commitSha) probs.push(`${p.id}: validated at ${tgt.commitSha}, not the failing commit`);
          if (suite && suite.id !== tgt.id && suite.status !== 'passed') probs.push(`${p.id}: regression suite ${suite.status}`);
          return probs;
        }),
    ),
  );

  out.push(
    check(
      'patch.unvalidated-not-claimed',
      b.patches
        .filter((p) => p.status !== 'validated')
        .flatMap((p) => [
          p.status === 'proposed' && p.validation?.summary && /^Passed/.test(p.validation.summary) ? `${p.id} proposed but summary claims a pass` : '',
          b.evidence.some((e) => e.kind === 'experiment_result' && e.title === `Candidate validated: ${p.title}` && !b.patches.some((q) => q.title === p.title && q.status === 'validated'))
            ? `${p.id} "${p.title}" has a "Candidate validated" ledger record but status ${p.status}`
            : '',
          p.prUrl ? `${p.id} has a PR but is not validated` : '',
        ])
        .filter(Boolean),
    ),
  );

  out.push(check('outcome.fix-matches-patches', inv.agent && inv.agent.fix !== fixOutcomeOf(b.patches) ? [`agent.fix=${inv.agent.fix}, records imply ${fixOutcomeOf(b.patches)}`] : []));
  const diag = inv.agent?.diagnosis;
  const expectDiag = inv.verdict === 'confirmed' ? ['CONFIRMED'] : inv.verdict === 'probable' ? ['PROBABLE'] : ['INCONCLUSIVE', 'BLOCKED'];
  out.push(check('outcome.diagnosis-matches-verdict', diag && !expectDiag.includes(diag) ? [`agent.diagnosis=${diag} but verdict=${inv.verdict}`] : []));
  out.push(check('verdict.confirmed-requires-strong', inv.verdict === 'confirmed' && inv.confidence?.label !== 'strong' ? [`confirmed with ${inv.confidence?.label} evidence`] : []));
  out.push(check('verdict.primary-exists', inv.verdict && b.hypotheses.length && !keys.has(inv.primaryHypothesis) ? [`primary hypothesis ${inv.primaryHypothesis} does not exist`] : []));
  // A change verification that ended without a diagnosis (blocked, or no failing test) has no verdict by design;
  // its status must then follow the change outcome instead: completed only for "no regression observed".
  const changeOnly = inv.change?.outcome && !inv.verdict;
  const statusProblem = changeOnly
    ? (inv.status === 'completed') !== (inv.change.outcome === 'no_regression_observed') || !['completed', 'inconclusive'].includes(inv.status)
      ? `status ${inv.status} but change outcome ${inv.change.outcome} (no verdict)`
      : ''
    : inv.status === 'inconclusive' && inv.verdict !== 'inconclusive'
      ? `status inconclusive but verdict ${inv.verdict}`
      : inv.status === 'completed' && (inv.verdict === 'inconclusive' || !inv.verdict)
        ? `status completed but verdict ${inv.verdict}`
        : '';
  out.push(check('status.matches-verdict', statusProblem ? [statusProblem] : []));

  // Stricter than documented: "supported" should rest on at least one experiment.
  out.push(
    check(
      'hypothesis.supported-backed-by-experiment',
      b.hypotheses.filter((h) => h.status === 'supported' && (t.get(h.key)?.s ?? 0) === 0).map((h) => `${h.key} is "supported" with no supporting experiment (model claim only)`),
    ),
  );

  void patches;
  return out;
}

/** Checks Alibi's own Evidence Path model (built by the target's web code) against the records. */
export function checkEvidencePath(b: Bundle, model: { columns: Array<{ nodes: any[] }>; edges: any[] }): Check[] {
  const inv = b.investigation;
  const nodes = model.columns.flatMap((c) => c.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ev = new Map(b.evidence.map((e) => [e.id, e]));
  const hyp = new Map(b.hypotheses.map((h) => [h.id, h]));
  const exp = new Map(b.experiments.map((e) => [e.id, e]));
  const pat = new Map(b.patches.map((p) => [p.id, p]));
  const out: Check[] = [];

  out.push(
    check(
      'path.nodes-reference-records',
      nodes
        .filter((n) => {
          switch (n.kind) {
            case 'log':
            case 'verdict':
              return n.refId !== inv.id;
            case 'observed_fact':
              return ev.get(n.refId)?.kind !== 'observed_fact';
            case 'hypothesis':
              return !hyp.has(n.refId);
            case 'experiment':
              return !exp.has(n.refId);
            case 'patch':
              return !pat.has(n.refId);
            default:
              return true;
          }
        })
        .map((n) => `${n.id} (${n.kind}) → no record ${n.refId}`),
    ),
  );

  const allowed = new Set(['cites', 'targets', 'supports', 'contradicts', 'primary']);
  out.push(
    check(
      'path.edges-supported',
      model.edges.flatMap((e) => {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!allowed.has(e.relation)) return [`${e.id}: unsupported relation ${e.relation}`];
        if (!from || !to) return [`${e.id}: dangling endpoint`];
        if (e.relation === 'supports' || e.relation === 'contradicts') {
          const rec = ev.get(e.evidenceId);
          const h = hyp.get(to.refId);
          if (!rec || rec.kind !== 'inference' || rec.effect !== e.relation || rec.experimentId !== from.refId || rec.hypothesisKey !== h?.key) return [`${e.id}: no ledger inference records this ${e.relation}`];
          return [];
        }
        if (e.relation === 'targets') return exp.get(from.refId)?.hypothesisKey === hyp.get(to.refId)?.key ? [] : [`${e.id}: experiment does not target this hypothesis`];
        if (e.relation === 'primary') return inv.verdict && hyp.get(from.refId)?.key === inv.primaryHypothesis ? [] : [`${e.id}: not the primary hypothesis`];
        if (e.relation === 'cites') {
          const h = hyp.get(to.refId);
          const line = Number(/L(\d+)/.exec(e.label)?.[1]);
          return h?.supporting?.some((q: any) => q.verified && q.logLine === line) ? [] : [`${e.id}: no verified citation of L${line}`];
        }
        return [];
      }),
    ),
  );

  out.push(
    check(
      'path.states-match-records',
      nodes.flatMap((n) => {
        if (n.kind === 'hypothesis') {
          const h = hyp.get(n.refId);
          if (n.state === 'supported' && h?.status !== 'supported') return [`${h?.key} shown supported but status ${h?.status}`];
          if (h?.status === 'refuted' && n.state !== 'contradicted') return [`${h.key} refuted but shown ${n.state}`];
        }
        if (n.kind === 'experiment') {
          const x = exp.get(n.refId);
          if (x?.status === 'skipped' && n.state !== 'skipped') return [`${x.id} skipped but shown ${n.state}`];
          if (n.state === 'tests_passed' && (x?.status !== 'passed' || !x?.result)) return [`${x?.id} shown passed but status ${x?.status}`];
        }
        if (n.kind === 'patch') {
          const p = pat.get(n.refId);
          if ((n.state === 'validated') !== (p?.status === 'validated')) return [`${p?.id} shown ${n.state} but status ${p?.status}`];
        }
        return [];
      }),
    ),
  );
  return out;
}

export function failing(checks: Check[], ids?: readonly string[]): Check[] {
  return checks.filter((c) => !c.ok && (!ids || ids.includes(c.id)));
}

/** Readable assertion message listing failing checks. */
export function describeFailures(checks: Check[]): string {
  return checks.map((c) => `${c.id}: ${c.detail}`).join('\n');
}
