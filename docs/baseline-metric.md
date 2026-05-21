# Baseline Context Quality Metric

**STATUS: PROPOSAL — awaiting user confirmation.**

This document defines a computable composite metric for evaluating the quality of context assembled by the `ContextFactory`. The metric is deterministic: it runs on a fixed fixture with no LLM calls and no network access.

---

## Goal

Measure whether the context assembled by `ContextFactory` for a given session is:
1. **Focused** — mems in the context are semantically close to the current focus vector.
2. **Deduplicated** — no mem is loaded whose source fragment is still in raw (active) state.
3. **Chronologically ordered** — after a soft rebuild, loaded mems appear in ascending timestamp order.

---

## Composite Metric: `ContextQualityScore`

```
ContextQualityScore = (focusRelevance + dedupCorrectness + chronologyIntegrity) / 3
```

Range: `[0.0, 1.0]`. Each sub-metric is independently `[0.0, 1.0]`.

---

## Sub-metric A: `focusRelevance`

**What it measures:** The fraction of loaded mems whose cosine similarity to the current session focus vector meets or exceeds a threshold.

**Inputs:**
- `focus: number[]` — current session focus vector (1024-dim), normalized to unit length.
- `loadedMems: Mem[]` — the ordered list of mems assembled into the context.
- `threshold: number` — similarity floor, proposed default `0.50`.

**Computation:**
```
cosineSimilarity(a, b) = dot(a, b) / (|a| * |b|)

relevantCount = count of mems where cosineSimilarity(mem.embeddings.full, focus) >= threshold
focusRelevance = relevantCount / loadedMems.length   (1.0 if loadedMems is empty)
```

**How to compute on a deterministic fixture:**
- Create a fixture with a known focus vector (e.g., unit vector along first dimension).
- Create N mems with known embeddings: some above threshold, some below.
- Assert `focusRelevance` equals `relevantCount / N`.

---

## Sub-metric B: `dedupCorrectness`

**What it measures:** Whether the context contains zero mems whose source fragments are still raw-present (status `'active'` in `mem_chunks`).

A mem is "contaminated" if any of its `chunkIds` corresponds to a chunk with `status = 'active'`. Such a mem was created from fragments that have not yet been archived — meaning the raw fragment is still in the active tail. Loading this mem creates a near-duplicate: the raw tail and the mem describe the same content.

**Inputs:**
- `loadedMems: Mem[]` — the ordered list of mems assembled into the context.
- `activeChunkIds: Set<string>` — set of chunk IDs currently in `status = 'active'`.

**Computation:**
```
contaminated = mems where any chunkId is in activeChunkIds
dedupCorrectness = 1.0 if contaminated.length === 0, else 0.0
```

This is a binary metric: any contamination is a full failure. There is no partial credit because a single near-duplicate in the context can confuse the model.

**How to compute on a deterministic fixture:**
- Create 3 mems: mem-A (chunkIds `['1','2']`), mem-B (chunkIds `['3','4']`), mem-C (chunkIds `['5']`).
- Set `activeChunkIds = new Set(['3'])` (chunk 3 is still active).
- Assert `dedupCorrectness = 0.0` (mem-B is contaminated).
- Set `activeChunkIds = new Set()`.
- Assert `dedupCorrectness = 1.0`.

---

## Sub-metric C: `chronologyIntegrity`

**What it measures:** Whether loaded mems are in ascending `closedAt` timestamp order after a soft rebuild. This is relevant only when a rebuild has occurred (the context was reordered). Before the first rebuild, ordering is insertion order and this sub-metric returns `1.0` unconditionally.

**Inputs:**
- `loadedMems: Mem[]` — the ordered list of mems after a rebuild.
- `rebuildOccurred: boolean` — whether a soft rebuild was triggered in this session.

**Computation:**
```
if (!rebuildOccurred) return 1.0

violations = 0
for i in 1..loadedMems.length-1:
  if loadedMems[i].closedAt < loadedMems[i-1].closedAt:
    violations++

chronologyIntegrity = 1.0 - (violations / (loadedMems.length - 1))
(1.0 if loadedMems.length <= 1)
```

**How to compute on a deterministic fixture:**
- Create 4 mems with known `closedAt` timestamps: t1 < t2 < t3 < t4.
- Shuffle to `[t3, t1, t4, t2]` — 2 violations.
- Assert `chronologyIntegrity = 1.0 - (2 / 3) ≈ 0.333`.
- Sort to `[t1, t2, t3, t4]` — 0 violations.
- Assert `chronologyIntegrity = 1.0`.

---

## Fixture Design

All three sub-metrics are testable on a single deterministic fixture (no LLM, no network, no DB):

```typescript
// Fixture: 4 mems, known embeddings, known chunkIds, known timestamps
const focusVector = [1, 0, 0, /* ... 1021 more zeros */]; // 1024-dim unit vector

const mems: Mem[] = [
  { id: '1', summary: 'mem A', chunkIds: ['1','2'], closedAt: t1,
    embeddings: { full: [0.9, 0.1, ...], compact: [], micro: [] } },  // high relevance
  { id: '2', summary: 'mem B', chunkIds: ['3','4'], closedAt: t2,
    embeddings: { full: [0.8, 0.2, ...], compact: [], micro: [] } },  // high relevance
  { id: '3', summary: 'mem C', chunkIds: ['5'],    closedAt: t3,
    embeddings: { full: [0.1, 0.9, ...], compact: [], micro: [] } },  // low relevance
  { id: '4', summary: 'mem D', chunkIds: ['6'],    closedAt: t4,
    embeddings: { full: [0.85, 0.1, ...], compact: [], micro: [] } }, // high relevance
];

const activeChunkIds = new Set<string>(); // empty = clean
const threshold = 0.5;
```

Expected scores on this clean fixture:
- `focusRelevance` = 3/4 = `0.75` (mem C below threshold)
- `dedupCorrectness` = `1.0`
- `chronologyIntegrity` = `1.0` (no rebuild yet)
- `ContextQualityScore` = `(0.75 + 1.0 + 1.0) / 3 ≈ 0.917`

---

## Integration Point (plan step 9)

This metric will be wired into an integration test in `src/__tests__/services/context-factory-metric.test.ts`. The test will:
1. Instantiate `ContextFactory` with a mock store and mock embedding service.
2. Call `remember()` N times to populate session state.
3. Call `getCurrentContext()` to get the assembled context and session state.
4. Compute `ContextQualityScore` on the assembled state.
5. Assert score > `0.7` on the defined fixture.

No LLM, no network, no live DB — pure in-memory computation against fixture data.
