# Scenarios

Executable definitions of Alibi's core product scenarios.

| File | Tier | Scenarios |
|---|---|---|
| `malformed-logs.test.ts` | offline | A4 — empty, truncated, binary, CRLF/ANSI, OOM, 1 MB line, 60k-line logs; expired logs; runs with no failed job; unverifiable model citations |
| `inconclusive.test.ts` | offline | A5 — no discriminating experiment can run; model over-claims; loop outcome BLOCKED |
| `core.docker.test.ts` | Docker | A1 code regression · A2 dependency incompatibility · A3 flaky test · A6 confirmed diagnosis without a validated fix · A7 all candidates rejected · A8 fix validated in a fresh sandbox (and re-validated independently by QA) |
| `maven.docker.test.ts` | Docker | A2 (Maven) — Guava upgrade breaks compilation; pin and model migration validated |
| `python.docker.test.ts` | Docker | P1 pytest code regression (parent passes, failing commit fails, fix validated) · P2 flaky test with bounded repeats and a pytest skip quarantine · P3 dependency incompatibility (packaging 21.3 → 24.1) with a failing model version change and a validated pin · P4 a wrong fix rejected by the regression suite · P5 test-file edits blocked on the first attempt and on the retry · P6 unsupported layouts (Poetry, VCS requirement) refused before install |
| `go.docker.test.ts` | Docker | G1 Go code regression (subtest fails, parent passes, fix validated and re-checked independently) · G2 compiler failure reproduced with `go build`, fix must also pass `go test ./...` · G3 flaky test with bounded `-shuffle`-seeded repeats and a `t.Skip` quarantine · G4 dependency incompatibility (golang.org/x/exp `slices.SortFunc` change) with a rejected model bump and a validated go.mod + go.sum pin · G5 a wrong fix rejected by the regression suite · G6 `_test.go` edits blocked on the first attempt and on the retry · G7 unsupported layouts (go.work, local replace) refused before install |
| `typescript.docker.test.ts` | Docker | T1 ts-jest code regression with a validated fix · T2 `tsc` type-check failure reproduced; a cast-only fix passes `tsc` but is rejected by the Jest suite; a real fix validates · T3 flaky test with seeded repeats and a `test.skip` quarantine · T4 dependency incompatibility (nanoid 5 ESM-only) with a rejected bump and a validated pin · T5 a wrong fix rejected · T6 `*.test.ts` edits blocked on the first attempt and on the retry · T7 unsupported layouts (npm workspaces, Jest without a TypeScript transform) refused before install |
| `change.docker.test.ts` | Docker | V1 change regression (base passes, head fails) · V2 passing refactor (no regression observed) and a change that skips the tests it breaks (inconclusive) · V3 rejected fix · V4 validated fix (re-checked independently) · V5 missing revision, unsupported layout, malformed requests · V6 test-file edits blocked on first attempt and retry · V7 dependency install failure (blocked, never confirmed) · V8 loop-off compatibility · V9 revision and provenance consistency · V10 loop policy and budget limits |

## Overlays

`overlays/<id>/` follows Alibi's own scenario format (`scenario.json`, `commits/<NN-name>/`
overlays applied in order, `ci-log.txt`). The runner copies them into the **disposable
clone's** `fixtures/scenarios/` so Alibi's demo intake builds them as real git repositories
with stable SHAs. The original Alibi repository is never touched.

`ci-output.txt` is the hand-written, synthetic CI body; regenerate `ci-log.txt` with:

```bash
npx tsx scripts/fixtures/wrap-gha-log.ts <overlay-id>
```

Scripted model outputs for each overlay live in `fixtures/model/<overlay-id>.json`.
