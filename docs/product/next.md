# Where We Ended / What's Next

Cold-restart pointer. Updated: 2026-06-15.

## Where We Ended

Phase 1D step 1 DONE, verified, committed.
- `recall_any@{5,10,20,30}` = 0.338 / 0.436 / 0.566 / 0.632 (LongMemEval-S, 470 scored Qs, 19195 sessions; naive whole-session-embedding FLOOR — not the atomic-mem pipeline).
- Key finding: FAR-MISS dominant. Extending K 10→30 recovers only ~35% of @10-misses (92 near / 173 far). Majority of weak-category misses (53–80%) sit OUTSIDE top-30 → structural representation problem (granularity/embedding), NOT a ranking-window problem.
- Worst categories: user-facts (ssu) & preferences (ssp) — ~58–63% lost even at @30 → H1 whole-session dilution confirmed.
- Commits on main: 4226b6e (re-score + depth-30 persistence), 5a3eb9a (developer role-memory). Both Codex COMMIT_REVIEW APPROVE. qa: 363 tests green, numbers reproduced independently.

## Next Action

Active bead: llmems-3io.11

AWAITING owner budget decision (TG topic 592) on the granularity A/B test (memory sliced per-round):
- B1 ~$0.29 (recommended) — two worst categories, sharpest H1 test.
- B2 ~$0.55–0.65 — all categories.
- hold — stop at current result.

Declared-envelope remainder ~$0.16 < needed → owner must authorize a NEW envelope.
On B1/B2 → ROTATE developer (rotation-ready, was ~143k; its pointer docs/codebase/next.md) then assign round-level re-seed (fresh contextId) + re-score. On hold → close Phase 1D milestone.

Open-core boundary decision (A) DEFERRED — coupled to the granularity result (do NOT finalize before B1).

## Must Read

- `materials/report-phase1d.md` — full analysis + both owner decisions framed
- `materials/recall-at-k-20260615.md` — numbers + env recipe + corrected magnitude
- `materials/discovery-phase1d.md` — Phase 1D discovery; cost ladder §4.2

## State

clean
Last stable commit: 5a3eb9a (main); team alive (developer rotation-ready/idle, architect+qa-tester+researcher idle). Pre-existing untracked scratch unrelated.
