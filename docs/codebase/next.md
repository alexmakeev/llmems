# Developer — Where We Ended / What's Next

Cold-restart pointer (developer role). Updated: 2026-06-15.

## Where We Ended

Phase 1D step 1 DONE (bead llmems-3io.11). Re-scored LongMemEval-S `recall_any@{10,20,30}` over the
existing frozen `llmems_bench` corpus (no re-seed; ~$0.0002 question-embeds only). Committed
**4226b6e** on `main`, Codex COMMIT_REVIEW APPROVE, tests 318 green. qa-tester independently
reproduced all numbers (363 green incl. harness).

Results: **@5/@10/@20/@30 = 0.338 / 0.436 / 0.566 / 0.632** (@5/@10 reproduce archived stage-2
exactly). Key finding: of 265 @10-misses only **92 (~35%) are recovered by widening to K=30**;
173 (~65%) stay far → wider K is a partial/diminishing lever, the real fix is STRUCTURAL
(granularity / embedding model). ssu/ssp dilution-bound even at @30. Full detail in
`docs/codebase/INDEX.md` (top section) + `materials/recall-at-k-20260615.md`.

## Next Action

No active developer task — at a clean task boundary, likely rotating. Next distinct task will come
from team-lead. The Phase 1D ANALYSIS REPORT + DECISION (bead llmems-3io.11, owned at CEO/architect
level — see `docs/product/next.md`) consumes this @K data; developer involvement resumes when a
concrete experiment is greenlit.

Candidate next experiments already costed in `materials/discovery-phase1d.md` §4.2 (all > $0 need a
new owner envelope — do NOT start without explicit spending approval):
- #3/#4 round-level granularity arm (~$0.29 IE / ~$0.55–0.65 full) — discriminates H1 (dilution).
  Needs a FRESH contextId (the CORPUS CONDITION MISMATCH guard forbids mixing granularities in one
  memstore). This is the prime structural-fix test the @K data now motivates.
- #5 text-embedding-3-large arm (~$1.85 / ~$3.5) — H4, run AFTER granularity A/B.

## Must Read (on resume)

- `docs/codebase/INDEX.md` — top section (recall@K findings + run mechanics + env-mapping gotchas).
- `materials/recall-at-k-20260615.md` — @K table + corrected near/far interpretation.
- `materials/discovery-phase1d.md` — full hypothesis inventory + cost ladder.
- `docs/product/next.md` — CEO-level Phase 1D plan (the report/decision this data feeds).

## Run mechanics (recall re-scores are cheap, repeatable)

Benchmark env is NOT in the repo. Source `~/llmems-stand/.env`, then map:
`POSTGRES_URL=${POSTGRES_URL/llmems_stand/llmems_bench}` (frozen corpus, memstore id=5, 19,195 mems),
`BENCHMARK_LLM_BASE_URL=${LITELLM_BASE_URL%/}/v1`, `BENCHMARK_LLM_API_KEY=$LITELLM_API_KEY`,
`BENCHMARK_EMBEDDING_MODEL=$LLMEMS_EMBEDDINGS_MODEL` (openai-embedding-small),
`LLMEMS_BENCH_BUDGET_USD=0.02` (guard), `NODE_OPTIONS=--max-old-space-size=4096`. Then
`npx tsx scripts/benchmark/longmemeval.ts recall` from repo root. Cost truth: litellm
`GET ${LITELLM_BASE_URL}/key/info` → `info.spend` ($5 hard cap).

## State

clean (working tree: only pre-existing untracked scripts/lib/role-docs-map.json + scripts/test-projection-recall.ts)
Last commit: 4226b6e
