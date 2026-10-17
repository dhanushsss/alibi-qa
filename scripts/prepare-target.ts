/** Prepares (or refreshes) the disposable clone of the commit under test without running tests. */
import { relative } from 'node:path';
import { loadQaConfig, QA_ROOT } from './lib/config.ts';
import { fingerprint, identifyTarget, prepareTarget, sameFingerprint } from './lib/target.ts';

const cfg = loadQaConfig();
const target = await identifyTarget(cfg);
const before = await fingerprint(cfg.repo);
const prepared = await prepareTarget(cfg, target, (m) => console.log(`[prepare] ${m}`));
const after = await fingerprint(cfg.repo);
console.log(`Clone ready: ${relative(QA_ROOT, prepared.dir)} @ ${prepared.commit.slice(0, 12)} (${prepared.reused ? 'reused' : 'fresh'})`);
console.log(`Overlays: ${prepared.overlays.join(', ') || 'none'}`);
console.log(`Original repository unchanged: ${sameFingerprint(before, after) ? 'yes' : 'NO'}`);
