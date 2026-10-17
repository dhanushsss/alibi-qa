/** Builders for scripted model conversations from fixtures/model/*.json. */
import { fixture } from './harness.ts';
import type { ModelReply, ModelRule } from './mocks/hub.ts';

export const widget = () => fixture('model/widget-service.json');

/** Triage + verdict for the offline widget-service GitHub fixture. */
export function widgetRules(opts: { verdict?: 'confirmed' | 'inconclusive'; triage?: ModelReply[]; verdictReplies?: ModelReply[] } = {}): ModelRule[] {
  const w = widget();
  return [
    { stage: 'triage', replies: opts.triage ?? [{ json: w.triage }] },
    { stage: 'verdict', replies: opts.verdictReplies ?? [{ json: opts.verdict === 'inconclusive' ? w.verdictInconclusive : w.verdictConfirmed }] },
  ];
}

/** Scripted rules for a QA overlay scenario: fixtures/model/<id>.json with triage/verdict/patch entries. */
export function overlayRules(id: string, pick: { verdict?: string; patch?: string[]; retry?: string[]; loop?: unknown[] } = {}): ModelRule[] {
  const f = fixture(`model/${id}.json`);
  const rules: ModelRule[] = [
    { stage: 'triage', replies: [{ json: f.triage }] },
    { stage: 'verdict', replies: [{ json: f[pick.verdict ?? 'verdict'] }] },
  ];
  if (pick.patch) rules.push({ stage: 'patch', replies: pick.patch.map((k) => ({ json: f[k] })) });
  if (pick.retry) rules.push({ stage: 'patch-retry', replies: pick.retry.map((k) => ({ json: f[k] })) });
  if (pick.loop) rules.push({ stage: 'loop', replies: pick.loop.map((d) => ({ json: d })) });
  return rules;
}
