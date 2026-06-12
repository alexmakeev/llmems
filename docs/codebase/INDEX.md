# Developer Role Memory — llmems (docs/codebase/)

Long-term implementation findings/decisions. Updated at task boundaries.
Last update: 2026-06-12 (llmems-mdg + stage-1 run of llmems-3io.10).

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
- Session lengths: p50 ≈ 10.5K chars, p99 ≈ 20.8K, max 78K. Embed cap 26,000 chars
  (token-verified, see Stage-1 findings) truncates 7/19,195 (full) / 4/7,012 (IE).
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

## Stage-1 live run findings (llmems-3io.10, 2026-06-12)

- **Embed cap is TOKEN-verified, not heuristic** (commit b555ffb): chars/4 failed live —
  `sharegpt_xGoJZ6Z_0` = 8,222 cl100k tokens at 28,000 chars (3.41 chars/tok). Exhaustive
  tiktoken scan of all 19,195 pinned sessions → cap 26,000 (worst 7,652 tok, 0 over,
  7 truncated full / 4 IE). Pin-test freezes the constant; re-scan before changing.
- **Cost calibration**: real corpus density = 4.75 chars/token → chars/4 preflight
  OVERestimates ~16% (safe direction). Stage-1 actual $0.3012 vs projected $0.3577
  (calibration ×0.842). Stage-2 top-up calibrated ≈ $0.539.
- **Throughput**: seed ~50 sessions/s (batch 32 ≈ 0.65s embed+DB); recall ≈ 135 ms/question
  (embed + pgvector ANN over 7,012). Dataset load+sha ≈ 7s per CLI invocation.
- **Stage-1 result** (denominator 150, corpus 7,012): recall_any@10 = 0.647, @5 = 0.507; per-type @10:
  ssa 1.000, ssu 0.438, ssp 0.433. Archived: materials/bench-20260612-d6f21ea-longmemeval-ie-stage1.json.
- **Stage-2 result** (denominator 470, corpus 19,195): recall_any@10 = 0.436, @5 = 0.338;
  per-type @10: ssa 0.982, ku 0.597, ms 0.364, tr 0.315, ssu 0.281, ssp 0.167.
  Spend window $0.5380 vs calibrated $0.539 (0.2% off — calibration validated); cumulative
  key $0.8393. Recall latency scales with corpus: ~135 ms/q @7,012 → ~300 ms/q @19,195.
  IE-type numbers shifted vs stage-1 (larger ANN corpus = different condition, by design).
  Archived: materials/bench-20260612-d6f21ea-longmemeval-full-stage2{,-seed}.json.
- tiktoken (cl100k_base) available via python3 on this host — use
  `disallowed_special=()` (corpus contains a literal `<|endoftext|>` string).
- codex-interrupt.sh PreToolUse hook judges a TRUNCATED (~400 chars) command preview —
  long correctly-quoted commands get hallucinated "unterminated quote" blocks.
  Workaround: long text → file, keep the command short (stdin / `"$(cat file)"`).

Gotchas for the paid run (bead llmems-3io.10):

- Embedding batch = 32 sessions/request (≤7K tok each → ≤224K tok/request, under the
  ~300K/request embeddings API limit).
- `LLMEMS_BENCH_BUDGET_USD` is REQUIRED for seed and recall (requireEnvNumber);
  preflight runs without it (informational) but prints the gate verdict when set.
- Dataset sha256 is verified on EVERY CLI run; mismatch aborts (results non-comparable).
- Fixture-mutation tests: never mutate a SHARED session id's content — the dedup
  content-identity guard (correctly) throws; use a fresh session id instead.
