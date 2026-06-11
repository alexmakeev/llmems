# Benchmark Pipeline Runbook

**Bead:** llmems-3io.10 (Phase 1C — long-memory recall benchmark)
**Blockers:** llmems-dnh (questions file on this machine) · llmems-a9r (env hardening + script promotion) · llmems-wji (this runbook)
**Spend envelope:** $5 hard cap on the scoped LiteLLM key; ~$1 total target shared with the Phase 1B smoke.

---

## 1. Overview

The 1C benchmark measures long-term recall quality of `@alexmakeev/llmems` on the AM32 stand DB.
It compares two recall strategies on the same frozen question set:

| Arm | Strategy |
|-----|----------|
| **A — baseline** | Standard `vectorRecall` (cosine ANN on mem embeddings) |
| **B — challenger** | Per-axis MECE projection recall (cosine on `mem_projections` per semantic axis) |

**Canonical script:** `scripts/benchmark/test-projection-recall.ts`
(Promoted from `scripts/test-projection-recall.ts` under bead llmems-a9r. Imports from `../../src/`.)

**Env handling:** all required variables enforced via `scripts/lib/require-env.ts` — fail-fast,
no defaults by design.

**Boundary with the harness (D13):** the harness (`harness/`) is smoke-only — it proves
cross-session memory works live. The benchmark is a separate script; there is zero coupling
between them.

---

## 2. Prerequisites

All four must be resolved before running `.10`:

### 2.1 Questions file on this machine (bead llmems-dnh)

The frozen question set (`recall-test-questions.json`) lives on the **generation machine** and
has never been committed to git (intentionally untracked — gitignored). It contains the test
questions with `expected_facts` used by both arms of the benchmark.

**Owner action required** to transfer the file to this machine. Once transferred:

```bash
export BENCHMARK_QUESTIONS_FILE=/path/to/recall-test-questions.json
```

No script edit needed — `BENCHMARK_QUESTIONS_FILE` is a required env var enforced by
`scripts/lib/require-env.ts`. See §3 for the FREEZE invariant.

### 2.2 POSTGRES_URL required, no default (bead llmems-a9r)

`POSTGRES_URL` is required, no fallback. The script exits immediately if unset or empty.

> **TBD — fill in when a9r merges:** exact error message produced by `scripts/lib/require-env.ts`
> on a missing `POSTGRES_URL`, and the line number in the promoted script.

Export the AM32 stand DB URL before running:

```bash
export POSTGRES_URL=postgresql://...
```

### 2.3 Stand DB: mems table populated

The `mems` table for `MEMSTORE_ID=4` must contain the benchmark corpus. Verify:

```bash
psql "$POSTGRES_URL" -c "SELECT count(*) FROM mems WHERE memstore_id=4;"
```

If the count is 0, the benchmark has no data — stop. See §2.4.

### 2.4 Corpus + mem_projections migration to stand — bead TBD (escalated)

> **Open prerequisite — blocked on team-lead decision.**
>
> The AM32 stand DB currently holds only the 5-table schema and Phase 1B smoke data (harness
> runs). It does **not** contain the benchmark corpus (`memstore_id=4`, ~71 mems from the
> `benchmark-katya-year` conversation) and the `mem_projections` table does not exist on the
> stand.
>
> Without the corpus, arm A (vectorRecall) returns zero results. Without `mem_projections`,
> arm B (per-axis projection) fails at query time (lines 289, 412 in the script).
>
> This is a blocking gap that must be resolved by a dedicated bead (corpus import + projection
> extraction to the stand). That bead is TBD — team-lead is deciding scope and sequencing.
> Until it lands, `.10` cannot run a meaningful benchmark on the stand.

---

## 3. Gold-Set FREEZE Invariant

> **FREEZE rule: `recall-test-questions.json` (the frozen question set) MUST NOT be regenerated
> between A-arm and B-arm runs, or between any two runs being compared.**

The A/B comparison is valid only when both arms are evaluated against the **identical** question
set and `expected_facts` lists. Any change to the file — even adding or removing one question —
invalidates all prior comparisons.

**Operational rules:**

1. Before each run, record `sha256sum "$BENCHMARK_QUESTIONS_FILE"` in your benchmark log.
2. The SHA recorded when bead dnh lands is the **canonical question-set SHA** for this benchmark.
3. Verify the SHA matches before every run. Mismatch → stop and investigate.
4. Any regeneration or edit to the file constitutes a **new experiment**: both arms must be
   re-run from scratch. Prior results are not comparable.
5. Archive run results with the SHA in the filename:
   `materials/bench-YYYYMMDD-<sha7>-<arm>.json`

---

## 4. Environment Variables

All required variables enforced via `scripts/lib/require-env.ts` (fail-fast, no defaults).

### Required

| Variable | Description |
|----------|-------------|
| `POSTGRES_URL` | AM32 stand DB connection string. Required, no default. **TBD — see §2.2 for exact fail-fast wording once a9r merges.** |
| `BENCHMARK_QUESTIONS_FILE` | Absolute path to `recall-test-questions.json` (transferred from generation machine, bead dnh). Required, no default. |
| `LITELLM_BASE_URL` | LiteLLM endpoint on the AM32 stand (e.g. `http://AM32:4000`). Required, no default. **TBD — sync with developer for exact env var name.** The script currently hardcodes `https://openrouter.ai/api/v1` (line 661); this becomes configurable under a9r. |
| `LITELLM_API_KEY` | Scoped `llmems-teststand` LiteLLM key ($5 hard cap). Required, no default. **TBD — sync with developer for exact env var name.** |

> Provider note: the stand has **no direct OpenRouter embeddings** — all inference goes through
> the LiteLLM proxy (the `openai-embedding-small` route provisioned in bead .7). The key
> above is the scoped teststand key, not a raw OpenRouter key. Verify the LiteLLM route name
> matches the model string in the script (`openai/text-embedding-3-small`) — see §6 validity
> condition on embedding space.

### Hardcoded script constants (not env vars — edit only if targeting a different corpus)

| Constant | Value | Change when |
|----------|-------|-------------|
| `MEMSTORE_ID` | `4` | Only if targeting a different memstore |
| `CONTEXT_ID` | `'benchmark-katya-year'` | Only if targeting a different corpus |
| `RESULTS_FILE` | `sandboxes/projection-test-results.json` (repo-relative) | Output file; gitignored |
| `PROJECTION_THRESHOLD` | `0.3` | Minimum cosine similarity to collect an axis match |
| `PROJECTION_HIT_THRESHOLD` | `0.5` | Threshold for counting a question as "hit" on an axis |
| `PROJECTION_LIMIT` | `5` | Max axis matches per question per axis |
| `VECTOR_RECALL_LIMIT` | `10` | Max mems returned by `vectorRecall` |
| `API_DELAY_MS` | `500` ms | Delay between embedding API calls (rate-limit guard) |

---

## 5. Step Order

### 5.1 Pre-run checklist

- [ ] Blockers resolved: dnh (questions file transferred), a9r (script promoted, env hardening done), §2.4 corpus + projections on stand
- [ ] `POSTGRES_URL` exported; connectivity: `psql "$POSTGRES_URL" -c "SELECT 1;"`
- [ ] `BENCHMARK_QUESTIONS_FILE` exported; file present and SHA recorded
- [ ] `LITELLM_BASE_URL` and `LITELLM_API_KEY` exported (TBD exact names — sync with developer)
- [ ] LiteLLM `openai-embedding-small` route healthy on AM32
- [ ] Stand DB has mems: `SELECT count(*) FROM mems WHERE memstore_id=4;`
- [ ] Stand DB has projections: `SELECT count(*) FROM mem_projections WHERE memstore_id=4;`
- [ ] LiteLLM spend logs checked; remaining budget > target for this run (~$0.50 per run)

### 5.2 Run the benchmark

```bash
cd /home/alexmak/llmems/main

# Verify required env
echo "POSTGRES_URL:              ${POSTGRES_URL:?required}"
echo "BENCHMARK_QUESTIONS_FILE:  ${BENCHMARK_QUESTIONS_FILE:?required}"
# TBD: add LITELLM_BASE_URL / LITELLM_API_KEY checks here once names confirmed

# Record gold-set SHA before each run
sha256sum "$BENCHMARK_QUESTIONS_FILE"

# Run the benchmark
npx tsx scripts/benchmark/test-projection-recall.ts
```

**Phase 1 — Re-embed mems** (auto-skipped if all mems already have embeddings):
Queries mems with `NULL embedding` for `MEMSTORE_ID=4`. Embeds in batches of 50 via
`openai/text-embedding-3-small` (1536-dim) through the LiteLLM proxy. One-time cost; skipped
on subsequent runs.

**Phase 2 — Recall per question:**
Samples ~20 representative questions from `BENCHMARK_QUESTIONS_FILE` (evenly distributed
across categories, ~3–4 per category). For each question:
- Embeds the question via the LiteLLM proxy
- **Arm A:** runs `vectorRecall` (ANN, up to `VECTOR_RECALL_LIMIT` results)
- **Arm B:** runs per-axis cosine similarity against `mem_projections` for all 7 semantic axes
- Also runs `graphEnrichedRecall` (informational; graph experiment on pause)
- Records counts and similarities for all arms

**Phase 3 — Aggregate statistics:**
Per-axis `hitRate`, `avgSimilarity`, similarity distribution buckets, per-category breakdown,
overall `vectorOnlyHitRate` and `projectionHitRate`. Writes `sandboxes/projection-test-results.json`
and prints a human-readable summary to stdout.

### 5.3 Record results

After each run:
1. Copy `sandboxes/projection-test-results.json` →
   `materials/bench-YYYYMMDD-<questions-sha7>-<arm-label>.json`
2. Note in benchmark log: questions SHA, `MEMSTORE_ID`, `CONTEXT_ID`, run timestamp,
   `vectorOnlyHitRate`, `projectionHitRate`, per-axis hitRate table, total spend (LiteLLM spend logs)

---

## 6. A/B Procedure

### Validity conditions (all must hold before treating results as comparable)

1. **Questions SHA identical** across compared runs — verify before each run (§3).
2. **Same `MEMSTORE_ID` and `CONTEXT_ID`** — same corpus, same DB state.
3. **Same embedding space** — question embeddings MUST use the same underlying model and
   dimension as the corpus mems. Current model: `openai/text-embedding-3-small`, 1536-dim
   via LiteLLM. Verify the LiteLLM route resolves to this model before every run; a model
   mismatch silently produces meaningless hitRate numbers (queries in a different vector space).
4. **Re-embedding consistent** — Phase 1 must be fully complete before both arms' data
   is produced. Do not run Phase 1 for only one arm.
5. **DB frozen between compared runs** — no mems added, removed, or re-embedded between
   the two runs being compared.

### Metrics to report (minimum)

Both arm A and arm B metrics are in the same output file. Report side-by-side:

| Metric | Arm A (vectorRecall) | Arm B (projection) |
|--------|---------------------|---------------------|
| `vectorOnlyHitRate` | ✓ | — |
| `projectionHitRate` | — | ✓ |
| Per-axis `hitRate` (7 axes) | — | ✓ |
| Per-axis `avgSimilarity` | — | ✓ |
| `avgVectorRecallCount` | ✓ | — |
| `graphEnrichedCount` delta | informational only | informational only |

`graphEnrichedCount` delta is **informational only** — the graph scoring is known-broken
(bead llmems-76f: `edge.relevance` not comparable to query cosine, floods top-K). Do not
use graph metrics as a decision signal for Phase 1D.

### Spending note

Each run embeds ~20 questions via the LiteLLM proxy. If Phase 1 triggers (NULL embeddings
present), it also embeds all mems for `MEMSTORE_ID=4` (~71 mems at last count). Total envelope:
$5 hard cap on the scoped key, shared with Phase 1B smoke (~$0.016 used). Stop and report to
owner if remaining budget approaches $0.50.

---

## 7. Gold-Set Provenance and Methodology

### Provenance (bead llmems-dnh)

The question set (`recall-test-questions.json`) was assembled on the **generation machine**
from the `benchmark-katya-year` conversation corpus. It has never been committed to git and
is intentionally untracked.

Current state: file lives on generation machine only. Transfer is a **manual owner action**
(bead dnh). Until transferred, bead .10 cannot run.

After transfer: file is placed anywhere on this machine and referenced via
`BENCHMARK_QUESTIONS_FILE` (no repo path required). Record the SHA256; this becomes the
canonical freeze identifier (§3).

### File structure

```json
{
  "questions": [
    {
      "id": "<string>",
      "category": "<string>",
      "question": "<string>",
      "difficulty": "<string>",
      "expected_facts": ["<fact string>", "..."]
    }
  ]
}
```

~100 questions across 6 categories. The benchmark samples ~20 evenly (~3–4 per category);
statistics are computed over the sampled subset.

### How the questions and expected_facts were built (from FAQ 2026-05-19)

Two options were discussed for building the gold standard:

**Option A — date heuristic (free, coarse):**
Expected facts derived from the raw conversation content; relevance threshold set by date.
Zero cost; not validated against actual mem coverage.

**Option B — LLM judge (one-time cost, more precise):**
Gemini Flash judges which mems actually cover each `expected_fact`. The coverage map is
frozen as authoritative. Recommended in the FAQ discussion.

The exact methodology used at generation time is not recorded in available project files.
**Do not attempt to re-derive** using a different methodology — it would invalidate all
prior benchmark comparisons.

---

## 8. Harness vs Benchmark — Boundary

These are two distinct pipelines (D13). Do not couple them.

| | Harness (Phase 1B / bead .9) | Benchmark (Phase 1C / bead .10) |
|---|---|---|
| **Purpose** | Smoke: prove cross-session memory works live | Measure recall quality (vectorRecall vs projection) |
| **Script** | `harness/` CLI — `seed` + `recall` phases | `scripts/benchmark/test-projection-recall.ts` |
| **DB content** | Run-scoped fresh `contextId` + nonce mems | Long-lived corpus (`benchmark-katya-year`, `memstore_id=4`) |
| **Assert** | Deterministic nonce match (planted fact) | `hitRate` statistics over sampled question set |
| **Questions file** | Not used | Required via `BENCHMARK_QUESTIONS_FILE` (bead dnh) |
| **Spend** | ~$0.016 spent (bead .9) | Within remaining $5 cap (~$1 target) |

---

*Open TBDs before wji can close (keep bead OPEN):*
*— §2.2: POSTGRES_URL fail-fast wording — fills in when a9r merges.*
*— §4: `LITELLM_BASE_URL` / `LITELLM_API_KEY` exact env var names — sync with developer.*
*— §2.4: corpus + mem_projections migration bead — TBD, blocked on team-lead decision.*
