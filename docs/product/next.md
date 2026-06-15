# Where We Ended / What's Next

Cold-restart pointer. Updated: 2026-06-15.

## Where We Ended

Phase 1D advancing. Step 1 (whole-session re-score @{10,20,30}) done earlier. B1 (round-level granularity PROBE) DONE + committed.
- Commits: a36d9ef (round-level granularity harness arm: splitRounds/runRoundSeed/CLI + underfetch guard), 5881d2c (dev next.md). Both Codex COMMIT_REVIEW APPROVE. Tests 330 green. B1 spend ~$0.30 (under $0.40 cap).
- B1 RESULT (same-corpus, clean @10 comparison; round-level = mechanical turn-pairs, NO LLM summarization):
  · user-facts (ssu): 0.438 → 0.641 (+46%) — ROBUST (n=64). Round granularity fixes dilution for concentrated facts.
  · preferences (ssp): 0.433 → 0.300 (−31%) — SOFT/NOISE: a 4-question shift, n=30 noise band; only 30 preference Qs in the whole benchmark → UNPROVABLE by scaling here. Do NOT build a thesis on this regression.
  · overall IE: 0.647 → 0.707 (+0.06).
- TAKEAWAY (robust): mechanical granularity is TYPE-DEPENDENT — helps concentrated facts, not diffuse signals. NOT a commodity win. The semantic LLM pipeline (segmentation + summarization) is the real lever for diffuse types.
- MOAT thesis STRENGTHENED: commoditizable mechanical splitting is insufficient alone → value = the closed semantic nucleus. Sharper open-core line: basic granularity+retrieval = MIT commodity; LLM semantic pipeline = closed moat. (Still gate finalization on #6/H5.)

## Active bead

llmems-3io.11 (in_progress).

## Next Action

AWAITING owner choice on next experiment (live TG conversation, topic 592):
1. Multi-resolution union probe (~$0.30, no LLM) — keep BOTH session + round indexes, retrieve union; cheapest type-aware test.
2. #6/H5 full built-pipeline run ($5–15, needs explicit owner budget envelope) — on-design test: does LLM semantic consolidation rescue diffuse types where mechanical splitting failed.
Recommended: cheap step 1 first (incremental validation). On owner go → rotate developer fresh (idle, ready) then assign.
Open-core boundary decision (A) still DEFERRED — gate on #6/H5.

## Must Read

- `materials/report-phase1d.md` (§9 = B1 read + interpretation)
- `materials/B1-results-20260615.md` (B1 full table)
- `materials/recall-at-k-20260615.md` (step-1 numbers + env recipe)
- `materials/discovery-phase1d.md` (discovery + cost ladder §4.2)

## State

clean — main at 5881d2c; team alive (developer/architect/qa-tester/researcher idle). Caveats: same-corpus whole-session @20/@30 unavailable (overwritten); ssp permanently n=30-bound.
