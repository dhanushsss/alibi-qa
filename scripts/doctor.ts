/** Prints the target under test and which tiers can run here. Changes nothing. */
import { loadQaConfig, PROVIDER_SECRET_VARS } from './lib/config.ts';
import { checkPrereqs, tierAvailable } from './lib/prereqs.ts';
import { fingerprint, identifyTarget } from './lib/target.ts';

const cfg = loadQaConfig();
const target = await identifyTarget(cfg);
const fp = await fingerprint(cfg.repo);
console.log(`Target:     ${target.repo}`);
console.log(`Commit:     ${target.commit} — ${target.subject}`);
console.log(`Repo HEAD:  ${target.repoHead}${target.repoHeadMatchesCommit ? ' (matches)' : ' (differs; the commit is tested in a clone)'}`);
console.log(`Remotes:    ${target.remotes.length ? target.remotes.join(', ') : 'none'}`);
console.log(`Worktree:   ${fp.status.length} status entr${fp.status.length === 1 ? 'y' : 'ies'} (read-only check)`);
const present = PROVIDER_SECRET_VARS.filter((k) => process.env[k]);
if (present.length) console.log(`Note:       ${present.join(', ')} set in this shell; they are never passed to child processes.`);
const prereqs = await checkPrereqs(cfg, 'all');
console.log('');
for (const p of prereqs) console.log(`${p.ok ? 'ok  ' : 'MISS'}  [${p.neededFor}] ${p.name}: ${p.detail}`);
console.log('');
console.log(`offline tier: ${tierAvailable(prereqs, 'all').ok ? 'available' : 'unavailable'}`);
console.log(`docker tier:  ${tierAvailable(prereqs, 'docker').ok ? 'available' : `unavailable — ${tierAvailable(prereqs, 'docker').detail}`}`);
console.log(`browser tier: ${tierAvailable(prereqs, 'browser').ok ? 'available' : `unavailable — ${tierAvailable(prereqs, 'browser').detail}`}`);
