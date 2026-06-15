NEW TRACK (owner pivot 2026-06-15): context-formation pipeline development (feed dataset dialogues through the real ContextFactory/recall pipeline; observe+improve context orientation + per-moment mem-list formation). See docs/product/next.md ROTATION HANDOFF. Baseline track closed.

# Developer — Where We Ended / What's Next

Cold-restart pointer (developer role). Updated: 2026-06-15 (B1 done, commit a36d9ef).

## B1 — round-level granularity arm (DONE, commit a36d9ef)

Round-level re-seed of the IE slice (7,012 sessions → 36,448 rounds, fresh contextId
`longmemeval-s-round-ie`, `--fetch-k 500`). Cost ~$0.30 (under $0.40 cap). Code: splitRounds /
runRoundSeed / `--granularity`/`--context-id`/`--fetch-k` CLI + recall underfetch guard; 330 tests green.

**Result (same 7,012-corpus, @10, whole-session→round):** user-facts 0.438→0.641 (+46% ↑),
preferences 0.433→0.300 (−31% ↓), assistant 1.0→1.0, overall IE 0.647→0.707. Round @20/@30:
ssu 0.734/0.750, ssp 0.467/0.500. **Granularity is NOT a blanket fix — helps user-facts, HURTS
preferences.** Clean comparison is @10-only (same-corpus whole-session @20/@30 unavailable —
stage-1 stored only @10; IE whole-session corpus overwritten by the stage-2 full-set top-up).
Details: `materials/B1-results-20260615.md`.

**KEY OPEN QUESTION this raises (for CEO/architect):** does the REAL built LLM-summarization
pipeline (BackgroundIndexer topic-mems, src/services/background-indexer.ts) RESCUE diffuse
preferences where mechanical round-splitting fails? B1 strips LLM summarization on purpose; the
ssp regression suggests preference signal needs semantic aggregation, not just finer slicing —
exactly what the topic-summary pipeline does. That is the expensive **#6 / H5 run (~$5–15+, hours,
LLM summarization of the corpus)** — needs a new owner envelope. B1 is the cheap probe that now
motivates (or not) spending on #6.

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

Candidate next experiments costed in `materials/discovery-phase1d.md` §4.2 (all > $0 need a new owner
envelope — do NOT start without explicit spending approval):
- #3 round-level IE arm — **DONE (B1, commit a36d9ef)**: mixed result (helps ssu, hurts ssp).
- **#6 / H5 — full LLM-summarization pipeline run (~$5–15+, hours)** — now the prime motivated dev
  task: does semantic topic-summary aggregation rescue preferences where mechanical round-splitting
  failed? (the B1 open question). Runs the library's real BackgroundIndexer over the corpus.
- #4 round-level FULL set (~$0.55–0.65) — extend B1 to all 6 types if CEO wants the full granularity map.
- #5 text-embedding-3-large arm (~$1.85 / ~$3.5) — H4, run AFTER the granularity story is settled.

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
Last commit: a36d9ef (B1 round-level granularity arm)
