/**
 * Builds the Evidence Path view model with the TARGET commit's own web code
 * (web/src/pages/detail/evidencePathModel.ts), so integrity checks test what
 * the UI actually renders from a bundle.
 */
import { importTarget, type Bundle } from './harness.ts';
import { checkBundle, checkEvidencePath, DOCUMENTED_CHECKS, failing, type Check } from './integrity.ts';

let mod: any;
export async function buildEvidencePath(b: Bundle): Promise<{ columns: Array<{ key: string; nodes: any[] }>; edges: any[]; connectors: any[] }> {
  mod ??= await importTarget('web/src/pages/detail/evidencePathModel.ts');
  return mod.buildEvidencePath(b);
}

/** Documented record checks plus Evidence Path checks; returns only failures. */
export async function integrityFailures(b: Bundle): Promise<Check[]> {
  const records = failing(checkBundle(b), DOCUMENTED_CHECKS);
  const path = failing(checkEvidencePath(b, await buildEvidencePath(b)));
  return [...records, ...path];
}
