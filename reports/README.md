# Reports

Every run writes two reports to `reports/out/<runId>/` (git-ignored) and copies them to
`reports/out/latest.{md,json}`:

- `report.md` — human-readable: target and commit, safety checks, prerequisites, results by
  file (with what is real and what is mocked), failures, probes, skipped tests, requirement
  coverage, and the full test list.
- `report.json` — machine-readable, schema `alibi-qa/report@1` (fields below).

`npm run report` regenerates both from the raw results of the most recent run
(`.work/runs/<runId>/`: `manifest.json`, `offline.jsonl`, `docker.jsonl`, `playwright.json`).

## What is never in a report

All text passes through `scripts/lib/sanitize.mjs` before it is written: credential-shaped
values, the suite's fake mock credentials and canaries, and your home directory path are
replaced. Reports contain no screenshots, traces, databases, or CI logs. Playwright traces
for failing browser tests stay in `test-results/` (git-ignored) and contain only synthetic data.

## Status values

| Status | Meaning |
|---|---|
| `passed` | The assertion ran and held. |
| `failed` | The assertion ran and did not hold, or the test (or its setup) crashed. A test phase that exits abnormally without reporting is also recorded as a failure. |
| `skipped` | Not run, with a reason (missing prerequisite, or filtered with `--grep`). Never counted as passed. |
| `todo-failing` | A **probe**: a hardening check beyond Alibi's documented guarantees. It ran and found a gap. Reported as a finding, not a regression. |
| `todo-passing` | A probe that ran and held. |

## `report.json` fields

| Field | Content |
|---|---|
| `target` | repository path, commit SHA, subject, author, commit date, repository HEAD |
| `clone` | disposable clone location, dependency mode, installed QA scenario overlays |
| `environment.prereqs` | each prerequisite, which tier needs it, and whether it is present |
| `safety` | `originalRepositoryUnchanged`, before/after fingerprints, cleanup actions |
| `summary` | `total`, `passed`, `failed`, `skipped`, `todo`, `probesFailing` |
| `files[]` | per test file: area, realism (real vs mocked), counts |
| `requirements` | per requirement ID (`A1`…`F9`): counts and test names |
| `failures[]`, `skipped[]`, `probes[]` | details, sanitized |
| `tests[]` | every test with phase, file, status, duration |

See `examples/` for a short illustrative report. It is an example of the format, not a
result.
