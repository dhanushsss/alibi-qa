/**
 * What each test file actually exercises. Used by the report so nobody has to
 * guess which results come from real integrations and which from mocks.
 */
export interface CatalogEntry {
  match: RegExp;
  area: string;
  realism: string;
  real: string[];
  mocked: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    match: /^api\//,
    area: 'D. API and reliability',
    realism: 'Integration: real Alibi server process, HTTP API, SQLite, investigation pipeline',
    real: ['Fastify API', 'SQLite persistence', 'queue', 'pipeline stages', 'redaction'],
    mocked: ['Nebius Token Factory (scripted)', 'GitHub API (fixtures)', 'sandbox disabled (ALIBI_RUNNER=disabled)'],
  },
  {
    match: /^agent-loop\/.*policy/,
    area: 'C. Agent loop (policy, budgets, stop rules)',
    realism: "White-box: the target commit's own agentLoop.ts module, driven with scripted decisions",
    real: ['validateAction', 'runAgentLoop', 'diagnosisOutcome', 'fixOutcome'],
    mocked: ['model decisions (scripted)', 'experiment execution (scripted observations)'],
  },
  {
    match: /^agent-loop\/.*\.docker\./,
    area: 'C. Agent loop (end to end)',
    realism: 'Integration: real server, real Docker sandbox runs, real patch validation',
    real: ['loop controller in the pipeline', 'Docker experiments', 'fresh-sandbox validation', 'ledger'],
    mocked: ['Nebius Token Factory (scripted decisions and patches)'],
  },
  {
    match: /^agent-loop\//,
    area: 'C. Agent loop (pipeline wiring, no sandbox)',
    realism: 'Integration: real server and pipeline with ALIBI_LOOP on/off; sandbox disabled',
    real: ['pipeline', 'loop wiring', 'model-call accounting'],
    mocked: ['Nebius Token Factory (scripted)', 'GitHub API (fixtures)'],
  },
  {
    match: /^security\/.*\.docker\./,
    area: 'F. Security (sandbox)',
    realism: "Integration: benign probes executed inside Alibi's real Docker sandbox",
    real: ['container isolation flags', 'network none', 'read-only root', 'no host env'],
    mocked: ['Nebius Token Factory (scripted)'],
  },
  {
    match: /^security\//,
    area: 'F. Security',
    realism: 'Mixed: white-box checks of target modules plus HTTP-level abuse against a real server',
    real: ['redaction', 'patch policy', 'selection validation', 'webhook HMAC', 'API validation', 'public demo restrictions'],
    mocked: ['providers (local mocks behind a network guard)'],
  },
  {
    match: /^scenarios\/.*\.docker\./,
    area: 'A/B. Core scenarios and evidence integrity (sandbox)',
    realism: 'Integration: real server, real git fixture repos, real Docker experiments and fix validation; QA re-validates patches independently',
    real: ['reproduce/repeat/parent experiments', 'patch validation', 'ledger', 'confidence rubric'],
    mocked: ['Nebius Token Factory (scripted triage/verdict/patch)'],
  },
  {
    match: /^scenarios\//,
    area: 'A/B. Core scenarios (no sandbox)',
    realism: 'Integration: real server and pipeline over GitHub-run intake with malformed logs; sandbox disabled',
    real: ['log parsing', 'redaction', 'verdict capping', 'ledger'],
    mocked: ['Nebius Token Factory (scripted)', 'GitHub API (fixtures)'],
  },
  {
    match: /^e2e\//,
    area: 'E. Browser and accessibility',
    realism: 'Browser: real built web app served by a real server; data from real offline investigations plus route-mocked bundles for rich states',
    real: ['React UI', 'routing', 'keyboard/focus', 'responsive layout'],
    mocked: ['providers', 'some API responses (page.route) for loading/error/rich states'],
  },
];

export function catalogFor(file: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.match.test(file));
}
