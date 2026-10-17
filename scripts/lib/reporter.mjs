/**
 * node:test reporter that writes one sanitized JSON line per test (and per
 * failed suite hook). Consumed by scripts/report.ts. Skips and todos are
 * recorded as such, never as passes.
 */
import { sanitize } from './sanitize.mjs';

function errorInfo(err) {
  if (!err) return undefined;
  const inner = err.cause && typeof err.cause === 'object' ? err.cause : err;
  const message = sanitize(String(inner.message ?? err.message ?? err)).slice(0, 4000);
  const stack = sanitize(String(inner.stack ?? '')).split('\n').slice(0, 12).join('\n');
  return { message, stack, failureType: err.failureType ?? null, code: err.code ?? null };
}

export default async function* qaReporter(source) {
  const stacks = new Map();
  for await (const ev of source) {
    const d = ev.data ?? {};
    const file = d.file ?? 'unknown';
    if (ev.type === 'test:start') {
      const s = stacks.get(file) ?? [];
      s[d.nesting] = d.name;
      s.length = d.nesting + 1;
      stacks.set(file, s);
      continue;
    }
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const isSuite = d.details?.type === 'suite';
    if (isSuite && ev.type === 'test:pass') continue;
    // A suite "fails" whenever a child fails; only record suites whose own hooks failed.
    if (isSuite && d.details?.error?.failureType === 'subtestsFailed') continue;
    const parents = (stacks.get(file) ?? []).slice(0, d.nesting);
    let status;
    if (d.skip !== undefined) status = 'skipped';
    else if (d.todo !== undefined) status = ev.type === 'test:fail' ? 'todo-failing' : 'todo-passing';
    else status = ev.type === 'test:pass' ? 'passed' : 'failed';
    const error = ev.type === 'test:fail' ? errorInfo(d.details?.error) : undefined;
    // A test cancelled because its suite's setup failed is reported as failed with that reason.
    yield `${JSON.stringify({
      file,
      name: d.name,
      path: [...parents, d.name],
      kind: isSuite ? 'suite' : 'test',
      status,
      durationMs: Math.round(d.details?.duration_ms ?? 0),
      skipReason: typeof d.skip === 'string' ? d.skip : undefined,
      todo: typeof d.todo === 'string' ? d.todo : undefined,
      error,
    })}\n`;
  }
}
