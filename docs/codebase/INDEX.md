# Developer Role Memory — llmems (docs/codebase/)

Long-term implementation findings/decisions. Updated at task boundaries.
Last update: 2026-06-12 (bead llmems-mdg).

## LongMemEval-S adapter (llmems-mdg, commit 39567e2)

Layout: `scripts/benchmark/longmemeval.ts` (CLI: preflight|seed|recall) +
`scripts/benchmark/lib/longmemeval-core.ts` (pure, ports-injected, offline-tested).
Tests live in `src/__tests__/scripts/` (root vitest includes only `src/**`; scripts
are OUTSIDE tsc build scope — typecheck them ad-hoc:
`npx tsc --noEmit --strict ... scripts/benchmark/longmemeval.ts ...`).

Reproducible dataset facts (pinned file, sha256 d6f21ea9…3442, 265 MB):

- 500 questions; 19,195 unique sessions of 23,867 refs; shared session ids are
  content-identical (verified: 4,672 shared-id checks, 0 mismatches).
- Abstention = `question_id` SUFFIX `_abs` (30 Qs across 4 types; their
  `answer_session_ids` are dummies absent from haystack). Retrieval denominator = 470.
- 32 multi-session counting questions have NUMERIC `answer` (e.g. `3`) — yn7 field
  contract said `str`; validator accepts `string|number` (field unused in retrieval-only).
- Session lengths: p50 ≈ 10.5K chars, p99 ≈ 20.8K, max 78K. Embed cap 28,000 chars
  truncates only 6/19,195 (full) / 4/7,012 (info-extraction).
- Preflight (chars/4 ≈ tokens, $0.02/1M): full ≈ $0.998 (49.9M tok); info-extraction
  slice ≈ $0.358 (156 selected incl. 6 abs haystacks, 150 scored, 7,012 sessions).
- `JSON.parse` of the 265MB file needs `NODE_OPTIONS=--max-old-space-size=4096` (~2s).

Design decisions (Codex COMMIT_REVIEW: APPROVE after 1 fix):

- Provenance: mems schema has NO metadata column, library change forbidden → the ONLY
  on-mem channel is a summary first-line marker `[longmemeval session=<id>]\n<text>`;
  embeddings are computed from raw session text (marker never embedded).
  `chunk_ids` is `int[]` in DB — cannot carry string session ids.
- Ingestion uses the library write path `store.applyBackgroundResult(batch, [], null, ctx)`
  (no raw-SQL inserts); dedicated memstore name `longmemeval-s` in `llmems_bench`.
- Seed is an idempotent top-up (skips stored session ids via
  `SELECT left(summary,200) …` scan + provenance decode); budget gate is computed on
  the MISSING set only, BEFORE the first embed call → stage-1 + stage-2 total ≈ $1
  (no re-embedding), interrupted seeds resume free.
- Recall sanity gate aborts BOTH on missing evidence/selection sessions AND on EXTRA
  sessions beyond the selection (Codex finding: category recall over a fully-seeded
  store = silently different ANN corpus → non-comparable metric). Per-category numbers
  over the full corpus come from full recall's `byCategory`, not slice re-runs.
- `recallAnyAtK` added ALONGSIDE fractional `recallAtK` in `recall-metrics.ts`
  (different metric; archived-baseline comparability requires the old one untouched).
  Throws on empty expected set — abstention must be excluded before scoring.

Gotchas for the paid run (bead llmems-3io.10):

- Embedding batch = 32 sessions/request (≤7K tok each → ≤224K tok/request, under the
  ~300K/request embeddings API limit).
- `LLMEMS_BENCH_BUDGET_USD` is REQUIRED for seed and recall (requireEnvNumber);
  preflight runs without it (informational) but prints the gate verdict when set.
- Dataset sha256 is verified on EVERY CLI run; mismatch aborts (results non-comparable).
- Fixture-mutation tests: never mutate a SHARED session id's content — the dedup
  content-identity guard (correctly) throws; use a fresh session id instead.
