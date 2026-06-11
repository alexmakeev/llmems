# Benchmark Pipeline Runbook

**Bead:** llmems-3io.10 (Phase 1C — long-memory recall benchmark)
**Blockers:** llmems-dnh (gold set on this machine) · llmems-a9r (env hardening) · llmems-ad0 (corpus migration to stand) · llmems-g3a (vectorRecall script) · llmems-wji (this runbook)
**Spend envelope:** $5 hard cap on the scoped LiteLLM key; ~$1 total target shared with the Phase 1B smoke.

---

## 1. Overview

The 1C benchmark measures long-term recall quality of `@alexmakeev/llmems` on the AM32 stand DB
using **vectorRecall** (cosine ANN on mem embeddings).

**Canonical script:** `scripts/benchmark/benchmark-recall.ts` (bead llmems-g3a)

**Env handling:** all required variables enforced via `scripts/lib/require-env.ts` — fail-fast,
no defaults by design (a9r).

**Boundary with the harness (D13):** the harness (`harness/`) is smoke-only — it proves
cross-session memory works live. The benchmark is a separate script; there is zero coupling.

---

## 2. Prerequisites

All five must be resolved before running `.10`:

### 2.1 Gold set on this machine (bead llmems-dnh)

The frozen gold set lives on the **generation machine** and is intentionally untracked (gitignored).
It contains questions (as JSON keys) with their expected mem IDs and LLM-judged coverage.

**Owner action required** to transfer the file to this machine. Once transferred, point
`BENCHMARK_GOLDSET_FILE` at it (e.g. `sandboxes/gold-set-4.json`).

Record the SHA256 on first transfer — this becomes the canonical freeze identifier (§3).

> **SHA caveat:** the gold-set SHA was not canonically recorded at generation time (May 2026).
> Authenticity of the transferred file rests on provenance (same file from the generation
> machine), not cryptographic verification. The first SHA recorded on transfer (dnh) becomes
> the canonical reference going forward.

### 2.2 POSTGRES_URL required, no default (bead llmems-a9r)

`POSTGRES_URL` is required, no fallback. The script exits immediately if unset or empty
(`scripts/lib/require-env.ts`: `"${name} is required but not set. Export it before running..."`).

### 2.3 Stand DB: corpus present (bead llmems-ad0)

The stand must contain the benchmark corpus. Verify:

```bash
psql "$POSTGRES_URL" -c "SELECT count(*) FROM mems WHERE memstore_id=$MEMSTORE_ID;"
```

> **Before ad0 lands:** query may succeed but return 0 — there is no benchmark corpus on the
> stand yet. Run `.10` only after ad0 migration is complete.

### 2.4 Corpus migration to stand — bead llmems-ad0

> **Open prerequisite.**
>
> The AM32 stand DB currently holds only the 5-table schema and Phase 1B smoke data. The
> benchmark corpus (`memstore_id=4`, ~71 mems from `benchmark-katya-year`) has not been
> migrated. Bead llmems-ad0 covers corpus-only migration. Until ad0 lands, vectorRecall
> returns zero results.

### 2.5 New vectorRecall script ready (bead llmems-g3a)

`scripts/benchmark/benchmark-recall.ts` must be written, reviewed, and merged before `.10`
can run. The old `scripts/test-projection-recall.ts` imports graph modules removed in the
v0.4.0 pure-memory cleanup and cannot compile against current `main`.

---

## 3. Gold-Set FREEZE Invariant

> **FREEZE rule: the gold-set file (pointed to by `BENCHMARK_GOLDSET_FILE`) MUST NOT be
> regenerated between runs being compared.**

Any change to the file — question text, expected mem IDs, or coverage map — invalidates all
prior comparisons, including the comparison against the May 2026 archived results (§9).

**Operational rules:**

1. Before each run: `sha256sum "$BENCHMARK_GOLDSET_FILE"` — record in your log.
2. The SHA recorded when bead dnh lands is the **canonical gold-set SHA** going forward.
3. Mismatch on any subsequent run → stop and investigate.
4. Any regeneration = new experiment: all prior results non-comparable.
5. Archive run results: `materials/bench-YYYYMMDD-<sha7>-<TEST_NAME>.json`

> **SHA provenance note:** the gold-set SHA was not recorded at May 2026 generation time.
> The first SHA recorded on transfer (dnh) becomes the canonical reference. This means the
> May 2026 results and the first live run share a provenance assumption, not a verified hash
> match — document this in the 1D report.

---

## 4. Environment Variables

All required variables enforced via `scripts/lib/require-env.ts` (fail-fast, no defaults).

### Required

| Variable | Description |
|----------|-------------|
| `POSTGRES_URL` | AM32 stand DB connection string. Required, no default. |
| `MEMSTORE_ID` | Integer ID of the memstore to benchmark (e.g. `4`). Enforced via `requireEnvInt`. Used to verify the memstore row exists and to validate the gold set belongs to this corpus (`goldSet.memstoreId === MEMSTORE_ID`). |
| `BENCHMARK_GOLDSET_FILE` | Path to the frozen gold-set JSON (e.g. `sandboxes/gold-set-4.json`). Required, no default. The script validates the file exists before running; fails fast with a clear message if missing. Never regenerate between compared runs. |
| `BENCHMARK_LLM_BASE_URL` | LiteLLM endpoint on the AM32 stand (e.g. `http://127.0.0.1:14999/v1`). The stand routes embeddings through LiteLLM — **not** OpenRouter directly. |
| `BENCHMARK_LLM_API_KEY` | Scoped `llmems-teststand` LiteLLM key ($5 hard cap). |
| `BENCHMARK_EMBEDDING_MODEL` | Embedding model name as known to LiteLLM (e.g. `openai-embedding-small` on the stand; was `openai/text-embedding-3-small` on the generation machine). No default — must match the route explicitly; see §6.1 validity condition. |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `QUESTION_LIMIT` | *(all)* | Cap the number of questions sampled. Use `QUESTION_LIMIT=20` for the cheap-subset first pass (§5.4). Unset = run all questions. |
| `TEST_NAME` | `baseline` | Label for this run; used in the output filename `sandboxes/benchmark-{TEST_NAME}.json`. |

---

## 5. Step Order

> **All commands in §5 assume all blockers have landed**, in particular bead llmems-g3a
> (which creates `scripts/benchmark/benchmark-recall.ts`). The script path is confirmed by the
> developer; the entrypoint file does not yet exist in the repo. Do not attempt to run until
> the §5.1 checklist clears.

### 5.1 Pre-run checklist

- [ ] All blockers resolved: dnh, a9r, ad0, g3a, wji
- [ ] `POSTGRES_URL` exported; connectivity: `psql "$POSTGRES_URL" -c "SELECT 1;"`
- [ ] `MEMSTORE_ID` exported (e.g. `export MEMSTORE_ID=4`)
- [ ] `BENCHMARK_GOLDSET_FILE` exported and file exists; SHA recorded:
  `sha256sum "$BENCHMARK_GOLDSET_FILE"`
- [ ] `BENCHMARK_LLM_BASE_URL`, `BENCHMARK_LLM_API_KEY`, `BENCHMARK_EMBEDDING_MODEL` exported
- [ ] LiteLLM embedding route healthy on AM32 stand
- [ ] Corpus present: `SELECT count(*) FROM mems WHERE memstore_id=$MEMSTORE_ID;` → non-zero
- [ ] LiteLLM spend logs checked; remaining budget sufficient (~$0.50 per run)

### 5.2 Run the benchmark

```bash
cd /home/alexmak/llmems/main

# Verify required env
echo "POSTGRES_URL:              ${POSTGRES_URL:?required}"
echo "MEMSTORE_ID:               ${MEMSTORE_ID:?required}"
echo "BENCHMARK_GOLDSET_FILE:    ${BENCHMARK_GOLDSET_FILE:?required}"
echo "BENCHMARK_LLM_BASE_URL:    ${BENCHMARK_LLM_BASE_URL:?required}"
echo "BENCHMARK_LLM_API_KEY:     ${BENCHMARK_LLM_API_KEY:?required}"
echo "BENCHMARK_EMBEDDING_MODEL: ${BENCHMARK_EMBEDDING_MODEL:?required}"

# Record gold-set SHA before each run
sha256sum "$BENCHMARK_GOLDSET_FILE"

# Run (full run)
npx tsx scripts/benchmark/benchmark-recall.ts
```

The script executes in a single phase:
1. **Config setup** — fail-fast validation of all required env vars.
2. **Corpus verification** — looks up `memstores WHERE id=$MEMSTORE_ID`; fails fast if memstore is
   missing (avoids silently benchmarking an empty corpus). Logs embedded mem count.
3. **vectorRecall per question** — for each question in the gold set (up to `QUESTION_LIMIT`):
   - Embeds the question text via `BENCHMARK_LLM_BASE_URL` using `BENCHMARK_EMBEDDING_MODEL`
   - Verifies the embedding dimension is exactly 1536 (fails fast on mismatch = wrong model space)
   - Runs vectorRecall (cosine ANN against stored mem embeddings via `searchMemsByVector`)
   - Records `recallAt5`, `recallAt10`, `precisionAt5`, `precisionAt10` per question
4. **Aggregate + output** — computes `aggregate.recallAt5/recallAt10/precisionAt5/precisionAt10`
   across evaluated questions; computes `deviation` vs archived baseline (R@5 0.524 / R@10 0.668);
   writes `sandboxes/benchmark-${TEST_NAME:-baseline}.json`; prints a console summary.

Console output looks like:
```
vectorRecall arm (N evaluated, M excluded):
  recall@5  = 0.524  (archived 0.524, deviation 0.000)
  recall@10 = 0.668  (archived 0.668, deviation 0.000)
  precision@5 = X.XXX, precision@10 = X.XXX
Results written: sandboxes/benchmark-baseline.json
```

### 5.3 Record results

After each run:
1. Copy `sandboxes/benchmark-${TEST_NAME:-baseline}.json` → `materials/bench-YYYYMMDD-<sha7>-${TEST_NAME:-baseline}.json`
2. Record in benchmark log: gold-set SHA, `MEMSTORE_ID`, run timestamp, `aggregate.recallAt5`,
   `aggregate.recallAt10`, `deviation.recallAt5`, `deviation.recallAt10`, total spend (LiteLLM
   spend logs)

### 5.4 Cheap subset first (CHARTER: incremental validation before costly scaling)

Run with a question cap before committing to the full set:

```bash
QUESTION_LIMIT=20 npx tsx scripts/benchmark/benchmark-recall.ts
```

Inspect results and verify spend is within budget before running without `QUESTION_LIMIT`.

---

## 6. Validity Conditions and Sanity Gate

### 6.1 Validity conditions (all must hold before treating results as meaningful)

1. **Gold-set SHA** matches canonical (§3) — verify before every run.
2. **Same `MEMSTORE_ID`** — same corpus, same DB state.
3. **Embedding space identical** — question embeddings MUST be produced by the same underlying
   model and dimension as the corpus mems' stored embeddings (`text-embedding-3-small` family,
   1536-dim). Verify that `BENCHMARK_EMBEDDING_MODEL` resolves to this model before every run.
   The script validates dimension (1536) client-side and aborts on mismatch — but model identity
   beyond the name cannot be verified client-side. Check the LiteLLM route mapping on the AM32
   stand explicitly.
4. **DB frozen between compared runs** — no mems added, removed, or re-embedded between runs
   being compared.
5. **Gold-set memstoreId match** — the script validates `goldSet.memstoreId === MEMSTORE_ID`
   at startup; a mismatch aborts with a clear error.

### 6.2 Sanity gate: expected reproduction range

The first live run should reproduce approximately:

| Metric | May 2026 recorded value | Acceptable range |
|--------|------------------------|-----------------|
| `aggregate.recallAt5` | **0.524** | 0.47 – 0.58 |
| `aggregate.recallAt10` | **0.668** | 0.62 – 0.72 |

> Ranges are an operational heuristic (~±5 questions of 100), not derived from May run variance
> (raw distributions lost — see §9 caveat 2).

Material deviation outside the acceptable range indicates migration or embedding-route drift —
stop and investigate before recording results. Do not proceed to Phase 1D until the sanity gate
passes or the deviation is explained and documented.

---

## 7. Gold-Set Provenance and Schema

### Provenance (bead llmems-dnh)

The gold set was generated **once** on the **generation machine** from the `benchmark-katya-year`
corpus. It is intentionally untracked (gitignored) and has never been committed to git.

Current state: file lives on generation machine only. Transfer is a **manual owner action**
(bead dnh). Until transferred, bead `.10` cannot run. After transfer, record the SHA256 as the
canonical freeze identifier (§3).

### Schema

The gold-set JSON has the following structure (from `scripts/benchmark/lib/benchmark-core.ts`):

```json
{
  "memstoreId": 4,
  "generatedAt": "2026-MM-DDTHH:MM:SSZ",
  "judgeModel": "<model name used to judge coverage>",
  "questions": {
    "<question text>": {
      "expectedMemIds": ["<mem_id_1>", "<mem_id_2>"]
    }
  }
}
```

Keys in `questions` are the **question text strings** (not numeric IDs). The benchmark embeds
each key directly. `expectedMemIds` lists the mem IDs (from the DB) that should be recalled for
that question.

The script validates on load:
- `questions` is an object
- `goldSet.memstoreId === MEMSTORE_ID` (prevents running the wrong corpus's gold set)
- every question entry has `expectedMemIds[]`

### Generation methodology (from FAQ 2026-05-19)

Two options were discussed for building the gold standard:

**Option A — date heuristic (free, coarse):**
Expected facts derived from the raw conversation content; relevance by date.
Zero cost; not validated against actual mem coverage.

**Option B — LLM judge (one-time cost, recommended):**
Gemini Flash judges which mems actually cover each expected fact. The coverage map is frozen
as authoritative.

The exact option used at generation time is not recorded in available project files.
**Do not regenerate** using a different methodology — it would invalidate all prior comparisons.

---

## 8. Harness vs Benchmark — Boundary

These are two distinct pipelines (D13). Do not couple them.

| | Harness (Phase 1B / bead .9) | Benchmark (Phase 1C / bead .10) |
|---|---|---|
| **Purpose** | Smoke: prove cross-session memory works live | Measure vectorRecall quality |
| **Script** | `harness/` CLI — `seed` + `recall` phases | `scripts/benchmark/benchmark-recall.ts` |
| **DB content** | Run-scoped fresh `contextId` + nonce mems | Long-lived corpus (`benchmark-katya-year`, `MEMSTORE_ID=4`) |
| **Assert** | Deterministic nonce match (planted fact) | `aggregate.recallAt5 / recallAt10` statistics vs gold set |
| **Gold set** | Not used | `BENCHMARK_GOLDSET_FILE` (bead dnh) |
| **Spend** | ~$0.016 spent (bead .9) | Within remaining $5 cap (~$1 target) |

---

## 9. Archived Projection/Graph Results (May 2026)

The May 2026 benchmark compared vectorRecall against per-axis MECE projection recall and
strict-MECE aggregation on the `benchmark-katya-year` corpus. Those scripts imported graph
modules removed from `main` by the v0.4.0 pure-memory cleanup; they cannot compile against
current `main`.

**Summary of May 2026 recorded results** (source: `docs/axis-experiment.md`):

| Strategy | R@5 | R@10 |
|----------|-----|------|
| vectorRecall (baseline) | 0.524 | 0.668 |
| SumAcrossAxes projection | 0.369 | — |
| strict-MECE | 0.241 | — |
| Graph-enriched | *excluded* — scoring broken (bead llmems-76f) | |

**Two honest caveats for Phase 1D comparison:**
1. **SHA not recorded:** the gold-set SHA was never canonically recorded in May. The comparison
   between live results and May results rests on provenance (same file from generation machine),
   not cryptographic identity.
2. **Raw results lost:** the result JSONs from May are not available. Only the summary table
   above survives. Per-question breakdowns and per-axis distributions cannot be reconstructed.

The Phase 1D report (bead .11) will compare the live vectorRecall run against these archived
numbers, with both caveats stated verbatim.

For historical context on the projection/graph experiments, see `docs/axis-experiment.md`.

---

*Open TBD — wji stays open until resolved:*
*— §7 generation methodology: exact option (A or B) used at generation time not recorded in project files.*
