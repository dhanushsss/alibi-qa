# alibi-qa

End-to-end verification suite for **Alibi** (CI failure forensics). It tests a pinned Alibi
commit as a black box wherever possible: a real server process, real HTTP API, real SQLite
database, real investigation pipeline, real Docker sandbox experiments, and the real built
web UI. Only the external providers (Nebius Token Factory, GitHub, Tavily) are replaced by
local, scripted mocks.

The suite never modifies the Alibi repository, never calls a paid or external API, and
never pushes, publishes, or deploys anything.

## Prerequisites

| Needed for | Requirement |
|---|---|
| everything | Node.js ≥ 20.11, git, the Alibi repository at `../Alibi` (configurable) |
| `copy` dependency mode (default) | Alibi's own `node_modules` installed from the same `package-lock.json` as the commit under test |
| Docker tier | a running Docker daemon, the `node:20-bookworm-slim` image, and network access to `registry.npmjs.org` (fixture dependencies are installed inside the sandbox); for the Maven scenario also `maven:3.9-eclipse-temurin-17` and Maven Central |
| browser tier | Playwright Chromium (`npx playwright install chromium`; network) |

`npm run doctor` reports the target commit and which tiers can run on this machine. It
changes nothing.

## Setup

```bash
npm ci                    # QA dependencies: tsx, typescript, @types/node, @playwright/test
npm run doctor            # target, commit, prerequisites per tier
npm run prepare:target    # optional; the runner does this automatically
```

Configuration is in `qa.config.json` (repository path, commit, expected commit subject).
Overrides via environment or `.env` (see `.env.example`; only `ALIBI_QA_*` keys are read).

## Commands

| Command | What runs | Needs |
|---|---|---|
| `npm test` / `npm run test:all` | every **offline** suite: API, agent loop, security, offline scenarios | nothing beyond Node/git |
| `npm run test:api` | API contract and reliability (offline) | — |
| `npm run test:agent-loop` | agent-loop policy, budgets, wiring (offline) | — |
| `npm run test:security` | security: offline checks **and** the sandbox isolation probe | Docker for the probe (skipped with a reason otherwise) |
| `npm run test:scenarios` | all core scenarios: offline ones and the Docker ones | Docker + npm registry for A1–A3, A6–A8 |
| `npm run test:docker` | every Docker-tier test across suites | Docker + npm registry |
| `npm run test:e2e` | Playwright browser journeys | Chromium |
| `npm run test:full` | all tiers | all of the above |
| `npm run report` | regenerate the Markdown/JSON report of the latest run | — |
| `npm run clean` | remove run data and leftover server processes (`-- --all` also removes the clone and reports) | — |
| `npm run typecheck` | `tsc --noEmit` over the suite | — |

Runner flags (via `npx tsx scripts/run.ts`): `--suite all|api|agent-loop|security|scenarios|e2e`,
`--tier offline|docker|browser|all`, `--source worktree|commit`, `--grep <pattern>`, `--keep` (keep per-run data dirs).

### What code is tested

- `source: "worktree"` (default in `qa.config.json`): the configured commit, which must be the repository HEAD, **plus** its uncommitted changes (`git diff HEAD --binary`) and untracked non-media files. The run is labelled `<sha>+wt.<hash of the changes>`. Untracked screenshots, media, archives, databases and `.env*` files are never copied.
- `source: "commit"`: exactly the configured commit. If the repository has uncommitted changes, the runner warns that they are **not** under test.

The disposable clone is reset to the base commit on every run, the changes are re-applied, the web bundle is rebuilt whenever the revision changes, and the clone is checked to match the code under test exactly. The revision is printed at the start of the run and is the first line of every report.

Exit code: `0` when nothing failed and the original repository is unchanged, `1` otherwise,
`2` when the run could not start (for example a missing required prerequisite or an
unexpected target commit).

## How a run works

1. **Identify and verify the target.** Resolves the configured commit in the Alibi repository
   and refuses to run if its subject differs from the expected one.
2. **Fingerprint the original repository** (HEAD, refs, `git status`, stash) using read-only
   git (`GIT_OPTIONAL_LOCKS=0`, so even `git status` does not touch its index). The
   fingerprint is compared again at the end and reported.
3. **Check prerequisites** for the selected tiers. Missing ones skip the affected tests with
   the reason; they are never reported as passes.
4. **Prepare a disposable clone** in `.work/target-<sha>`: `git clone --no-hardlinks` of the
   commit (plus working-tree changes in `worktree` mode, see above), origin remote removed, dependencies copied (copy-on-write) or installed with
   `npm ci`, web bundle built. QA scenario overlays are copied into the clone's
   `fixtures/scenarios/qa-*`. The runner verifies that no tracked file differs from the
   commit. The clone has no `.env`, no database, and no replay recordings.
5. **Run suites.** Each test file starts its own mock hub and Alibi server(s) with a
   per-instance data directory, and always stops them in `after` hooks (also on failure).
6. **Clean up only what the run created**: recorded server PIDs (verified by command line),
   sandbox containers that appeared during the run, QA containers labelled with the run id,
   and the per-run data directories (unless `--keep`).
7. **Report** to `reports/out/<runId>/report.{md,json}` (see `reports/README.md`).

## Safety model

- **Original repository:** only read. Tests run against a clone; the clone cannot push back
  (no remote). The before/after fingerprint is part of every report.
- **No paid or external API calls.** Every Alibi server is started with fake credentials and
  provider URLs pointing at a loopback mock (`NEBIUS_BASE_URL`, `GITHUB_API_URL`). The
  launcher refuses to start if a configured URL is not loopback. A preloaded fetch guard
  (`scripts/lib/network-guard.mjs`, loaded with `node --import`, Alibi's source untouched)
  blocks every non-loopback request from the server process and redirects Tavily's
  hard-coded endpoint to the mock. The server refuses to continue if the guard did not load.
- **Shell credentials are never passed on.** Child processes get an allowlisted environment;
  `NEBIUS_API_KEY`, `GITHUB_TOKEN` and similar variables in your shell are withheld (the
  report lists which were present, by name only).
- **No sensitive artifacts.** Reports are sanitized (credential patterns, the suite's own
  fake credentials and canaries, your home path). Secret canaries used in tests are
  assembled at runtime from fragments, so the repository contains no token-shaped strings.
  Databases, server logs and traces stay in git-ignored `.work/` and `test-results/`.
- **Sandbox and security tests are benign.** The isolation probe only observes its
  environment (uid, capabilities, writable paths, mounts, network reachability, env var
  names) inside Alibi's hardened container. No destructive or exploit payload is executed
  anywhere. Traversal and injection tests send inputs over HTTP or to pure functions, and
  write only inside throwaway directories of the run.
- **Docker-tier network use:** the only outbound traffic is npm package installation inside
  sandbox containers (Alibi's own install step, and QA's independent validation), from the
  public npm registry.

## What is real and what is mocked

| Suite | Real | Mocked |
|---|---|---|
| `api/` | server process, HTTP API, validation, SQLite, queue, pipeline, restarts | Nebius (scripted), GitHub (fixtures); sandbox disabled |
| `scenarios/*.test.ts` (offline) | pipeline over GitHub-run intake, log parsing, redaction, verdict capping, ledger | Nebius, GitHub; sandbox disabled |
| `scenarios/core.docker.test.ts` | git fixture repositories, every experiment and fix validation in Alibi's Docker sandbox, **plus independent re-validation by QA's own sandbox** | Nebius (scripted triage/verdict/patch) |
| `agent-loop/policy.test.ts` | the target commit's own `agentLoop.ts` (white-box) | model decisions and observations (scripted) |
| `agent-loop/wiring.test.ts` | target config module; real server with `ALIBI_LOOP` on vs off | Nebius, GitHub; sandbox disabled |
| `agent-loop/loop.docker.test.ts` | loop controller in the pipeline, Docker experiments, patch retry and validation | Nebius (scripted decisions and patches) |
| `security/` | redaction end to end (API, raw DB bytes, prompts, logs), patch policy, selection validation, docker args, clone-source checks, webhook HMAC, public-demo restrictions; sandbox probe in Docker | providers |
| `e2e/` | built React app served by a real server (axe-core WCAG audit included), seeded with real offline investigations (Replay and heuristic modes) | providers; `page.route` bundles for rich states (validated/failed fixes, agent outcomes, loading/error/empty/partial) |

"Replay" in the browser suite uses a **QA-authored** recording (`fixtures/replays/`), not a
recording of a live run.

## Repository layout

```
api/            D — API contract, validation, persistence, duplicates, restarts, concurrency, timeouts, outages, missing config, cleanup
agent-loop/     C — policy, budgets, stop conditions, outcomes (white-box); loop on/off wiring; end-to-end loop on Docker
security/       F — redaction, unsafe paths, patch policy, command/container args, webhooks, request abuse, public demo, sandbox probe
scenarios/      A/B — malformed logs, inconclusive diagnosis (offline); core sandbox scenarios (Docker)
  overlays/     controlled CI failure scenarios (git commit overlays + synthetic CI logs) installed into the clone
e2e/            E — Playwright journeys, responsive navigation, keyboard/focus/reduced motion, UI states, secret leakage
fixtures/       sanitized logs, GitHub diffs, scripted model outputs, QA-authored replay
scripts/        runner, target preparation, mock hub, server launcher, network guard, integrity checker, reporter, cleanup
reports/        report format documentation and an illustrative example (generated reports are git-ignored)
```

Test names start with a requirement ID (`[A1]`…`[F9]`), which the report uses for its
coverage table.

## Controlled scenarios (`scenarios/overlays/`)

| ID | Failure | Used for |
|---|---|---|
| `qa-code-regression` | `<=` → `<` in weight bands; parent passes | A1, A8, agent loop (C1–C3, C5, C8, C9) |
| `qa-dependency-incompat` | uuid 3.4.0 → 9.0.1 removes `uuid/v4`; model "fix" to 8.3.2 still fails | A2 |
| `qa-flaky` | seeded jitter reorders deliveries for seeds k·65537, k∈{1,2,5,6}; docs-only commit | A3 |
| `qa-flaky-dynamic` | same flake, table-driven test title (no quarantine possible) | A6 |
| `qa-all-rejected` | cent padding regression; revert loses a new feature | A7, C8 |
| `qa-sandbox-probe` | benign isolation probe that fails on purpose | F9 |
| *(built-in)* `maven-dependency` | Guava 20.0 → 21.0 compile failure | A2 (Maven) |

All were verified in Docker to fail and pass as described. CI logs are hand-written to
match real Jest output and wrapped with `scripts/fixtures/wrap-gha-log.ts`.

## Probes

Tests marked `todo` are **probes**: hardening checks that go beyond what Alibi documents
(for example redaction of credential formats not in its pattern list). They run, and a
failing probe is listed as a finding in the report, but probes are never counted as passes
or as regressions.

## Brand, landing page, and layout (`e2e/brand-and-landing.spec.ts`)

The product under test is now branded **Zerqis**; this suite keeps its original name.
Browser checks `[F1]`–`[F11]` cover the title, metadata, and favicon; the absence of
visible or accessible-name "Alibi" branding on every route (the `ALIBI_*` environment
variable names and `alibi-demo/*` sample repositories are technical identifiers and are
excluded); landing-page navigation and CTA destinations; the recorded sample
walkthrough (labelled, pausable, stops at the end); reduced motion; horizontal overflow
at 1440, 1280, 1024, 768, and 390 px; the app content area spanning the width beside the
sidebar at 1024–1920 px; keyboard focus; axe WCAG A/AA audits of `/` and `/docs`; and
that the landing page makes no API calls. The app Overview lives at `/overview`; `/` is
the marketing page.

## Limitations

- **No live provider coverage.** Model behaviour is scripted; whether real Nemotron outputs
  parse, and real GitHub/Tavily responses, are not tested here. A live run would need
  explicit approval and is not implemented (`ALIBI_QA_ALLOW_PAID_APIS` makes the runner refuse).
- **GitHub-run investigations never reach the sandbox**, because experiments for GitHub runs
  clone from `github.com`. GitHub intake is tested with the sandbox disabled; sandbox
  behaviour is tested with demo-scenario overlays.
- **Tavily search results** are exercised only through the mock redirect; the loop's search
  path is covered by policy tests, not by a Docker scenario.
- **Maven** is exercised by one scenario (`scenarios/maven.docker.test.ts`, Alibi's built-in
  `maven-dependency`); the first run downloads dependencies from Maven Central (a few minutes).
- **Docker isolation is observed from inside one container per run;** kernel-level escape
  resistance (Docker is not a VM boundary) is out of scope and documented by Alibi itself.
- **Container cleanup heuristics:** Alibi's sandbox containers are unlabelled, so the runner
  removes only `alibi-exp-*` names that appeared during the run. Do not run two Docker-tier
  QA runs (or Alibi itself) concurrently on the same daemon.
- **Accessibility:** keyboard access, focus visibility, skip link, drawer and reduced motion are
  tested directly, and `e2e/accessibility.spec.ts` runs an axe-core WCAG 2.0/2.1 A/AA audit of the
  main pages (serious and critical violations fail). Automated audits do not replace a manual
  screen-reader review.
- Responsive checks use Chromium viewport emulation, not real devices.
