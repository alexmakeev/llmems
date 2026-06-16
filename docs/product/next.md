# next.md — ROTATION HANDOFF → CONTEXT-FORMATION TRACK (product / CEO)

## ROTATION HANDOFF (2026-06-16) — READ FIRST
Session rotation complete. Phases 1A / 1B / 1C / 1D-step1 / 1D-B1 all COMPLETE. Baseline ACCEPTED by owner (2026-06-15). Team (developer, qa-tester, architect) re-spawned fresh. New track STARTED.

## What's DONE (closed, committed)
- Phase 1D baseline benchmarking complete + committed. All Codex COMMIT_REVIEW APPROVE. Tests 363 green.
- Findings: whole-session recall floor @10=0.436 (@20=0.566, @30=0.632). Far-miss dominant (~65% of @10-misses outside top-30 → structural). B1 round-level probe: helps concentrated facts (user-facts +46%); NO proven help for diffuse types. Mechanical granularity is TYPE-DEPENDENT; the SEMANTIC pipeline is the real lever.
- Baseline ACCEPTED as-is. NO more cheap proxy runs (dropped per owner 2026-06-15).

## NEW TRACK (owner directive 2026-06-16) — START HERE
QUALITY-FIRST: observe + improve how the REAL pipeline forms the per-moment mem-list and orients in context on real LongMemEval dialogues. recall@k is a LATER secondary lever.
Goal: feed real dataset dialogues through the ACTUAL pipeline (ContextFactory / BackgroundIndexer / LLMSummarizer / recall loop), then observe + improve (a) context orientation quality and (b) mem-list formation at each dialogue moment.

## Next Action
1. DISCOVERY (architect) — how ContextFactory builds per-turn mem list today: segmentation → summarization → recall loop → assembly; observability gaps; how to feed dataset dialogues through real pipeline. Output → materials/discovery-context-formation.md (≤500 lines).
2. After Discovery: architect asks owner ONE deep question on operational success criteria (which dialogues/subset; what "well-oriented" means; what observability wanted).
3. Plan (beads) → implement observability + improvements → verify on a SMALL subset first.
NOTE: full-corpus pipeline run (~$5–15, H5/#6 costed run) is GATED on explicit owner spend envelope — not yet approved.

## Active bead
llmems-3io.11 (Phase 1D) — at planning, consider closing it and opening a new bead/epic for the context-formation track.

## Must Read
- CHARTER.md
- docs/product/INDEX.md
- docs/INDEX.md
- materials/discovery-context-formation.md (once written by architect)
- materials/discovery-oneliner-integration.md

## State
branch main; commit 92bd7e7; tests 363 green; tree clean.
