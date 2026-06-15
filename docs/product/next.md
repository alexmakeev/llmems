# next.md — ROTATION HANDOFF → NEW TRACK (product / CEO)

## ROTATION HANDOFF (2026-06-15) — READ FIRST
Owner approved rotation to start a NEW track with fresh context (CEO + team). The baseline-benchmarking track is CLOSED.

## What's DONE (closed, committed)
- Phase 1D baseline benchmarking complete + committed: 4226b6e (re-score depth-30), a36d9ef (round-level granularity arm), recaps 86d110c/fd61215, dev memory 5881d2c. All Codex COMMIT_REVIEW APPROVE. Tests 330 green.
- Findings: whole-session recall floor @10=0.436 (@20=0.566, @30=0.632). Far-miss dominant (~65% of @10-misses outside top-30 → structural, not ranking-window). B1 round-level probe: helps concentrated facts (user-facts +46%, robust n=64); NO proven help for diffuse types (preferences regression statistically soft, n=30-bound). Takeaway: mechanical granularity is TYPE-DEPENDENT, not a commodity win; the SEMANTIC pipeline is the real lever. Moat thesis strengthened (commodity = basic granularity+retrieval; closed = LLM semantic pipeline).
- Baseline ACCEPTED by owner as-is. NO more cheap proxy runs (multi-resolution etc. dropped per owner 2026-06-15).

## NEW TRACK (owner directive 2026-06-15) — START HERE
Pivot to the REAL built system: the mem-based CONTEXT-FORMATION algorithm (the atomic-mem pipeline — ContextFactory / BackgroundIndexer / LLMSummarizer / recall loop, NOT the benchmark proxies).
Goal: make it possible to feed REAL dataset dialogues (LongMemEval) through the ACTUAL pipeline, then OBSERVE + IMPROVE:
  (a) how well the system orients in context, and
  (b) how well it forms the list of available mems at each moment of the dialogue.
This is about live-pipeline BEHAVIOR on real dialogues + iterative improvement — NOT recall@K in a vacuum.

## Next Action (post-rotation)
1. DISCOVERY (architect) on the current context-formation algorithm: how ContextFactory builds the per-turn mem list today (segmentation → summarization → recall loop → assembly), what observability exists, edge cases, integration points, and how to feed dataset dialogues through the real pipeline. Output ≤500-line discovery doc.
2. Then ONE Deep Question to owner on specifics: which dialogues/subset; what "well-oriented in context" + "good mem-list" mean operationally (success criteria); what observability he wants.
3. Plan (beads) → implement observability + improvements → verify. Start on a SMALL subset of dialogues for cheap iteration.
NOTE: running the full pipeline over the whole corpus is LLM-heavy (~$5–15, the #6/H5 run) — any such spend needs an explicit owner budget envelope.

## Team
Recreate the team FRESH (roster: developer, qa-tester, architect, researcher). The pre-rotation teammates carried heavy baseline context (developer ~251k) — do NOT reuse them. If the old "llmems" team/teammates linger, recreate fresh.

## Active bead
llmems-3io.11 (Phase 1D) — baseline portion done; at planning, consider closing it and opening a new bead/epic for the context-formation track.

## Must Read
- materials/report-phase1d.md (full Phase 1D analysis incl. B1 §9)
- materials/discovery-phase1d.md (pipeline layers; what the baseline bypasses)
- docs/codebase/INDEX.md (developer role memory: pipeline mechanics, env recipe)
- vision.md (Phase-2 structure/graph), CHARTER.md

## State
clean — main at 90dd40d; baseline track closed.
