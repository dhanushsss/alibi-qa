# Alibi QA report — EXAMPLE (illustrative format only, not a real result)

**Result:** 1 failing · 3 passed · 1 skipped · 1 probes (todo, not counted as passes)

## Target

- Repository: `~/Desktop/Alibi`
- Commit under test: `0000000000000000000000000000000000000000` — example subject
- Tested in a disposable clone: `.work/target-000000000000` (dependencies: copy; QA scenario overlays: qa-code-regression)
- Selection: suite `all`, tier `offline`

## Safety

- Original repository unchanged: **yes** (HEAD, refs, working-tree status, stash compared before/after)
- Provider traffic: loopback mocks only; the server under test runs with a fetch guard that blocks any non-loopback request. No paid API was called.
- Cleanup: 0 leftover process(es) killed, 0 container(s) removed, run data deleted

## Results by file

| File | Area | Passed | Failed | Skipped | Probes | What is real / mocked |
|---|---|---:|---:|---:|---:|---|
| `api/contract.test.ts` | D. API and reliability | 2 | 0 | 0 | 0 | Integration: real Alibi server process, HTTP API, SQLite, investigation pipeline. Mocked: Nebius Token Factory (scripted), GitHub API (fixtures), sandbox disabled |
| `scenarios/inconclusive.test.ts` | A/B. Core scenarios (no sandbox) | 1 | 1 | 0 | 1 | … |
| `scenarios/core.docker.test.ts` | A/B. Core scenarios (sandbox) | 0 | 0 | 1 | 0 | … |

## Failures

### A5 inconclusive diagnosis › [A5] example failing test

File: `scenarios/inconclusive.test.ts`

```
expected verdict "inconclusive", got "probable"
```

## Probes (todo — hardening checks beyond documented guarantees)

- **FINDING** — example probe (probe: description)

## Skipped tests

- 1 test(s): missing prerequisite: docker daemon (not running)
