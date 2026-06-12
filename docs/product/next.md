# Where We Ended / What's Next

Cold-restart pointer. Updated: 2026-06-12.

## Where We Ended

Phase 1C complete via external benchmark pivot (owner directive 2026-06-11): homemade gold-set path superseded by LongMemEval-S (ICLR 2025, HuggingFace cleaned variant, 500 Qs / 470 scored). Both stages ran clean end-to-end. Final scores: `recall_any@10 = 0.436` / `recall_any@5 = 0.338` (470 Qs, 19,195 sessions). Per-type @10: assistant-facts 0.982, knowledge-update 0.597, multi-session 0.364, temporal-reasoning 0.315, user-facts 0.281, preferences 0.167. All sanity gates PASS (ingestion count, evidence sessions, sha256, budget gate). Spend: USD 0.839 of 1.00 owner envelope; corpus persisted in `llmems_bench` — re-runs nearly free. Two setup-repo bug-reports filed (048/049). Beads closed this session: dnh (superseded), wji, yn7, mdg, o1d, 3io.10.

## Next Action

Active bead: **llmems-3io.11** — Phase 1D analysis report + decision.

Core input: weak-category profile — user-facts (@10 0.281), preferences (0.167), temporal-reasoning (0.315), multi-session (0.364) all underperform vs assistant-facts (0.982) and knowledge-update (0.597). Key questions for the report:
1. Root-cause: chunking strategy, session-boundary alignment, or recall-time context window?
2. Scaling: is current vectorRecall sufficient at higher K, or does retrieval need structural changes?
3. `cache_control` hint injection feasibility — `getCurrentContextParts()` boundary already exposed (stable backbone / dynamic mems / raw tail).
4. Graph-bet revival — does the weak temporal/multi-session profile justify revisiting `experiment/axis-projections`?
5. Open-core boundary decision (gate for Phase 2 planning).

Corpus persisted; re-experiments with changed parameters are cheap (~$0 seed top-up, <$0.05 recall re-score).

## Must Read

- `docs/INDEX.md` — current state + active beads
- Bead `llmems-3io.10` close reason + comments (stage gates, per-type breakdown, spend log)
- `materials/research-2026-06-11-external-memory-benchmarks.md` — Phase 1C re-scope rationale
- `docs/benchmark.md` §10 — LongMemEval-S runbook (CLI, metric, stage gates, spend)
- `materials/bench-20260612-d6f21ea-longmemeval-*.json` — stage-1 and stage-2 result artifacts
- `docs/vision.md` — north-star (context for open-core boundary decision)

## Open Risks

- Weak categories (user-facts 0.281, preferences 0.167) — root cause not yet isolated; may require chunking or retrieval changes.
- Failure paths (truncation/degrade/late-settle) still offline-proven only — carry-to-1D (G3).
- Old-DB password still unrotated (owner; llmems scripts fail-fast on missing `POSTGRES_URL`, no silent fallback).
- Setup-repo issues 048/049 filed but not yet resolved.

## State

clean
Last stable commit: PENDING
