// src/__tests__/services/context-metric.test.ts
// Tests for context-metric.ts — ContextQualityScore and sub-metrics.
//
// All tests are deterministic: fixed fixture, no LLM, no network, no DB.
// Embedding dimension is small (2-dim) for readability; the metric is dim-agnostic.
//
// Dual-vector fixture (S2.9 baseline — 2026-05-21):
//   currentVec = [1, 0]  (unit vector, first dimension)
//   sessionVec = [0, 1]  (unit vector, second dimension — orthogonal to currentVec)
//   4 mems with 2-dim embeddings and provenance tags:
//     mem A (current): [0.9, 0.1] — cosine to currentVec ≈ 0.994 >= 0.5 — RELEVANT
//     mem B (current): [0.1, 0.9] — cosine to currentVec ≈ 0.110 <  0.5 — NOT RELEVANT
//     mem C (backbone): [0.1, 0.9] — cosine to sessionVec ≈ 0.994 >= 0.5 — RELEVANT
//     mem D (backbone): [0.9, 0.1] — cosine to sessionVec ≈ 0.110 <  0.5 — NOT RELEVANT
//   activeChunkIds = empty Set (no contamination)
//   rebuildOccurred = false (pre-rebuild session)
//
// Dual-vector baseline sub-scores:
//   focusRelevance     = 2/4    = 0.5    (1 current + 1 backbone above threshold)
//   dedupCorrectness   = 1.0            (no active chunks)
//   chronologyIntegrity = 1.0           (rebuildOccurred=false)
//   composite          = (0.5 + 1.0 + 1.0) / 3 ≈ 0.8333
//
// Legacy single-vector baseline (2026-05-21, now superseded):
//   ~0.9167 — measured under old single-focus-vector methodology.
//   Not comparable: different inputs (single focus vs dual currentVec+sessionVec).

import { describe, it, expect } from 'vitest';
import type { Mem } from '../../types.js';
import {
  computeFocusRelevance,
  computeDedupCorrectness,
  computeChronologyIntegrity,
  computeContextQualityScore,
  type ProvenanceMem,
} from '../../services/context-metric.js';

// ──────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeMem(
  id: string,
  embedding: number[],
  chunkIds: string[],
  closedAtMs: number,
): Mem {
  return {
    id,
    summary: `Summary for ${id}`,
    chunkIds,
    embeddings: { full: embedding },
    closedAt: new Date(closedAtMs),
  };
}

function makeProvMem(
  id: string,
  embedding: number[],
  chunkIds: string[],
  closedAtMs: number,
  provenance: 'current' | 'backbone',
): ProvenanceMem {
  return {
    id,
    summary: `Summary for ${id}`,
    chunkIds,
    embeddings: { full: embedding },
    closedAt: new Date(closedAtMs),
    provenance,
  };
}

// Baseline fixture: 4 mems, timestamps t1 < t2 < t3 < t4 (ascending)
const t1 = 1000;
const t2 = 2000;
const t3 = 3000;
const t4 = 4000;

// Dual-vector fixture vectors
const CURRENT_VEC: number[] = [1, 0]; // unit vector, first dimension
const SESSION_VEC: number[] = [0, 1]; // unit vector, second dimension

// Dual-vector fixture mems (provenance-tagged)
// current mems scored against CURRENT_VEC [1, 0]:
const MEM_A_CUR = makeProvMem('mem-A', [0.9, 0.1], ['1', '2'], t1, 'current'); // cos ≈ 0.994 >= 0.5 RELEVANT
const MEM_B_CUR = makeProvMem('mem-B', [0.1, 0.9], ['3', '4'], t2, 'current'); // cos ≈ 0.110 <  0.5 NOT RELEVANT
// backbone mems scored against SESSION_VEC [0, 1]:
const MEM_C_BKB = makeProvMem('mem-C', [0.1, 0.9], ['5'], t3, 'backbone'); // cos ≈ 0.994 >= 0.5 RELEVANT
const MEM_D_BKB = makeProvMem('mem-D', [0.9, 0.1], ['6'], t4, 'backbone'); // cos ≈ 0.110 <  0.5 NOT RELEVANT

// Legacy single-vector mems (used in sub-metric and edge-case tests where provenance doesn't matter)
const MEM_A = makeProvMem('mem-A', [0.9, 0.1], ['1', '2'], t1, 'current'); // relevant to [1,0]
const MEM_B = makeProvMem('mem-B', [0.8, 0.2], ['3', '4'], t2, 'current'); // relevant to [1,0]
const MEM_C = makeProvMem('mem-C', [0.1, 0.9], ['5'], t3, 'current');      // not relevant to [1,0]
const MEM_D = makeProvMem('mem-D', [0.85, 0.1], ['6'], t4, 'current');     // relevant to [1,0]

const CLEAN_ACTIVE_CHUNK_IDS = new Set<string>(); // empty = no contamination

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric A: focusRelevance (dual-vector)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeFocusRelevance', () => {
  it('returns 1.0 for empty loadedMems', () => {
    expect(computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [], 0.5)).toBe(1.0);
  });

  it('returns 0.75 on single-vector-style fixture: all mems current, 3 of 4 relevant to currentVec', () => {
    // All mems tagged as 'current' — scores against currentVec [1,0]
    // MEM_A [0.9,0.1] cos≈0.994 RELEVANT, MEM_B [0.8,0.2] cos≈0.970 RELEVANT,
    // MEM_C [0.1,0.9] cos≈0.110 NOT RELEVANT, MEM_D [0.85,0.1] cos≈0.993 RELEVANT
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_A, MEM_B, MEM_C, MEM_D], 0.5);
    expect(score).toBeCloseTo(0.75, 10);
  });

  it('returns 0.5 on dual-vector fixture: 1 current + 1 backbone relevant out of 4 total', () => {
    // MEM_A_CUR [0.9,0.1] vs currentVec [1,0]: cos≈0.994 RELEVANT
    // MEM_B_CUR [0.1,0.9] vs currentVec [1,0]: cos≈0.110 NOT RELEVANT
    // MEM_C_BKB [0.1,0.9] vs sessionVec [0,1]: cos≈0.994 RELEVANT
    // MEM_D_BKB [0.9,0.1] vs sessionVec [0,1]: cos≈0.110 NOT RELEVANT
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_A_CUR, MEM_B_CUR, MEM_C_BKB, MEM_D_BKB], 0.5);
    expect(score).toBeCloseTo(0.5, 10); // 2/4
  });

  it('current mem irrelevant to currentVec scores 0', () => {
    // [0.1, 0.9] vs currentVec [1,0]: cos ≈ 0.110 < 0.5
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_B_CUR], 0.5);
    expect(score).toBe(0.0);
  });

  it('current mem relevant to currentVec scores 1.0', () => {
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_A_CUR], 0.5);
    expect(score).toBe(1.0);
  });

  it('backbone mem relevant to sessionVec scores 1.0', () => {
    // [0.1, 0.9] vs sessionVec [0,1]: cos ≈ 0.994 >= 0.5
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_C_BKB], 0.5);
    expect(score).toBe(1.0);
  });

  it('backbone mem irrelevant to sessionVec scores 0.0', () => {
    // [0.9, 0.1] vs sessionVec [0,1]: cos ≈ 0.110 < 0.5
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_D_BKB], 0.5);
    expect(score).toBe(0.0);
  });

  it('returns 0.0 when all mems are below threshold', () => {
    // Orthogonal to currentVec [1,0]
    const orthogonal = makeProvMem('o1', [0, 1], [], t1, 'current');
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [orthogonal], 0.5);
    expect(score).toBe(0.0);
  });

  it('threshold boundary: mem exactly at threshold is counted as relevant', () => {
    // Unit vector [1,0] vs currentVec [1,0]: cosine = 1.0 >= 1.0
    const aligned = makeProvMem('aligned', [1, 0], [], t1, 'current');
    expect(computeFocusRelevance([1, 0], SESSION_VEC, [aligned], 1.0)).toBe(1.0);
  });

  it('returns 1.0 when all mems are above threshold for their provenance vector', () => {
    // All current, all relevant to currentVec
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [MEM_A, MEM_B, MEM_D], 0.5);
    expect(score).toBe(1.0);
  });

  it('is dim-agnostic: works with 3-dim vectors', () => {
    const current3 = [1, 0, 0];
    const session3 = [0, 1, 0];
    const mem3 = makeProvMem('3d-relevant', [0.9, 0.1, 0.1], [], t1, 'current');
    const score = computeFocusRelevance(current3, session3, [mem3], 0.5);
    expect(score).toBe(1.0); // cosine ≈ 0.9 / sqrt(0.83) ≈ 0.987
  });

  it('handles mems with empty embedding vector (returns 0 similarity)', () => {
    const emptyEmbedding = makeProvMem('empty-emb', [], [], t1, 'current');
    const score = computeFocusRelevance(CURRENT_VEC, SESSION_VEC, [emptyEmbedding], 0.5);
    expect(score).toBe(0.0); // cosineSimilarity returns 0 for empty vectors
  });

  it('cold-start: backbone mem with empty sessionVec scores 0 (no reference vector)', () => {
    // Empty sessionVec = cold-start (no closed mems yet).
    // cosineSimilarity([0.1, 0.9], []) returns 0 — dim mismatch → 0.
    const backboneMem = makeProvMem('backbone-cold', [0.1, 0.9], [], t1, 'backbone');
    const score = computeFocusRelevance(CURRENT_VEC, [], [backboneMem], 0.5);
    expect(score).toBe(0.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric B: dedupCorrectness
// ──────────────────────────────────────────────────────────────────────────────

describe('computeDedupCorrectness', () => {
  it('returns 1.0 for empty loadedMems', () => {
    expect(computeDedupCorrectness([], CLEAN_ACTIVE_CHUNK_IDS)).toBe(1.0);
  });

  it('returns 1.0 on fixture: no active chunks (provenance-tagged mems)', () => {
    // Uses provenance-tagged mems — provenance irrelevant for dedup check
    const score = computeDedupCorrectness([MEM_A, MEM_B, MEM_C, MEM_D], CLEAN_ACTIVE_CHUNK_IDS);
    expect(score).toBe(1.0);
  });

  it('returns 0.0 when one mem has an active chunk (contamination detected)', () => {
    // chunk '3' belongs to MEM_B (provenance='current')
    const activeIds = new Set(['3']);
    const score = computeDedupCorrectness([MEM_A, MEM_B, MEM_C, MEM_D], activeIds);
    expect(score).toBe(0.0);
  });

  it('is binary: partial contamination = full failure (0.0)', () => {
    // Only MEM_B is contaminated, but all 4 mems are loaded — still 0.0
    const activeIds = new Set(['4']); // chunk '4' from MEM_B
    const score = computeDedupCorrectness([MEM_A, MEM_B, MEM_C, MEM_D], activeIds);
    expect(score).toBe(0.0);
  });

  it('detects contamination via ANY chunkId in a multi-chunk mem', () => {
    // MEM_A has chunkIds ['1', '2']; only '2' is active
    const activeIds = new Set(['2']);
    const score = computeDedupCorrectness([MEM_A], activeIds);
    expect(score).toBe(0.0);
  });

  it('returns 1.0 when active chunk set exists but does not overlap with any mem chunkId', () => {
    const activeIds = new Set(['999', '888']); // no overlap
    const score = computeDedupCorrectness([MEM_A, MEM_B], activeIds);
    expect(score).toBe(1.0);
  });

  it('dedup is provenance-agnostic: backbone mem contamination detected same as current', () => {
    // MEM_C_BKB has chunkIds ['5'] and provenance='backbone'
    const activeIds = new Set(['5']);
    const score = computeDedupCorrectness([MEM_A_CUR, MEM_C_BKB], activeIds);
    expect(score).toBe(0.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric C: chronologyIntegrity
// ──────────────────────────────────────────────────────────────────────────────

describe('computeChronologyIntegrity', () => {
  it('returns 1.0 when rebuildOccurred=false (no rebuild yet)', () => {
    // Even with out-of-order mems, pre-rebuild state always returns 1.0
    const shuffled = [MEM_C, MEM_A, MEM_D, MEM_B]; // t3, t1, t4, t2 — 2 violations
    expect(computeChronologyIntegrity(shuffled, false)).toBe(1.0);
  });

  it('returns 1.0 for empty loadedMems regardless of rebuildOccurred', () => {
    expect(computeChronologyIntegrity([], true)).toBe(1.0);
    expect(computeChronologyIntegrity([], false)).toBe(1.0);
  });

  it('returns 1.0 for single mem regardless of rebuildOccurred', () => {
    expect(computeChronologyIntegrity([MEM_A], true)).toBe(1.0);
    expect(computeChronologyIntegrity([MEM_A], false)).toBe(1.0);
  });

  it('returns 1.0 when mems are already in ascending closedAt order (after rebuild)', () => {
    // t1 < t2 < t3 < t4 — perfectly sorted
    const sorted = [MEM_A, MEM_B, MEM_C, MEM_D];
    expect(computeChronologyIntegrity(sorted, true)).toBe(1.0);
  });

  it('returns ~0.333 for 2 violations out of 3 adjacent pairs', () => {
    // [t3, t1, t4, t2]: pairs (t3,t1), (t1,t4), (t4,t2) => violations at pair 0 and 2 => 2/3
    const shuffled = [MEM_C, MEM_A, MEM_D, MEM_B]; // t3, t1, t4, t2
    const score = computeChronologyIntegrity(shuffled, true);
    expect(score).toBeCloseTo(1.0 - 2 / 3, 10); // ≈ 0.3333
  });

  it('returns 0.0 when all adjacent pairs are out of order (reversed)', () => {
    // [t4, t3, t2, t1]: all 3 pairs are violations => 3/3 = 1.0 violations => score = 0.0
    const reversed = [MEM_D, MEM_C, MEM_B, MEM_A]; // t4, t3, t2, t1
    const score = computeChronologyIntegrity(reversed, true);
    expect(score).toBe(0.0);
  });

  it('correctly counts equal timestamps as NOT a violation', () => {
    const sameTime1 = makeProvMem('s1', [1, 0], [], 1000, 'current');
    const sameTime2 = makeProvMem('s2', [1, 0], [], 1000, 'backbone'); // same closedAt — not a violation
    expect(computeChronologyIntegrity([sameTime1, sameTime2], true)).toBe(1.0);
  });

  it('chronology is provenance-agnostic: mixed current+backbone mems checked uniformly', () => {
    // t1(current), t2(current), t3(backbone), t4(backbone) — ascending
    const sortedMixed = [MEM_A_CUR, MEM_B_CUR, MEM_C_BKB, MEM_D_BKB];
    expect(computeChronologyIntegrity(sortedMixed, true)).toBe(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Composite: computeContextQualityScore — DUAL-VECTOR BASELINE MEASUREMENT (S2.9)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeContextQualityScore — dual-vector baseline fixture (S2.9)', () => {
  it('computes expected sub-scores and composite on the dual-vector baseline fixture', () => {
    // DUAL-VECTOR BASELINE FIXTURE (2026-05-21, S2.9) — deterministic, no LLM/network/DB
    // currentVec = [1, 0], sessionVec = [0, 1]
    // 4 mems: 2 current (one relevant, one not) + 2 backbone (one relevant, one not)
    // no active chunks, no rebuild
    const result = computeContextQualityScore({
      currentVec: CURRENT_VEC,
      sessionVec: SESSION_VEC,
      loadedMems: [MEM_A_CUR, MEM_B_CUR, MEM_C_BKB, MEM_D_BKB],
      activeChunkIds: CLEAN_ACTIVE_CHUNK_IDS,
      threshold: 0.5,
      rebuildOccurred: false,
    });

    // Sub-metric assertions
    // focusRelevance: MEM_A_CUR relevant (cos≈0.994), MEM_B_CUR NOT (cos≈0.110),
    //                 MEM_C_BKB relevant (cos≈0.994), MEM_D_BKB NOT (cos≈0.110)
    //                 → 2/4 = 0.5
    expect(result.focusRelevance).toBeCloseTo(0.5, 10);
    expect(result.dedupCorrectness).toBe(1.0);                  // no contamination
    expect(result.chronologyIntegrity).toBe(1.0);               // no rebuild yet

    // Composite: (0.5 + 1.0 + 1.0) / 3 ≈ 0.8333
    expect(result.composite).toBeCloseTo(0.8333333333, 6);

    // Gate: dual-vector baseline composite must be above 0.7 (Phase-2 uplift gate)
    expect(result.composite).toBeGreaterThan(0.7);
  });

  it('returns lower composite when dedup is contaminated', () => {
    // chunk '3' belongs to MEM_B_CUR (provenance='current') — contaminated
    const result = computeContextQualityScore({
      currentVec: CURRENT_VEC,
      sessionVec: SESSION_VEC,
      loadedMems: [MEM_A_CUR, MEM_B_CUR, MEM_C_BKB, MEM_D_BKB],
      activeChunkIds: new Set(['3']),
      threshold: 0.5,
      rebuildOccurred: false,
    });
    // dedupCorrectness = 0.0 => composite = (0.5 + 0 + 1.0) / 3 ≈ 0.5
    expect(result.dedupCorrectness).toBe(0.0);
    expect(result.composite).toBeCloseTo(0.5, 6);
  });

  it('returns lower composite when chronology is violated (after rebuild)', () => {
    // Mems in reverse order: t4(backbone), t3(backbone), t2(current), t1(current) — 3 violations
    const result = computeContextQualityScore({
      currentVec: CURRENT_VEC,
      sessionVec: SESSION_VEC,
      loadedMems: [MEM_D_BKB, MEM_C_BKB, MEM_B_CUR, MEM_A_CUR],
      activeChunkIds: CLEAN_ACTIVE_CHUNK_IDS,
      threshold: 0.5,
      rebuildOccurred: true,
    });
    // chronologyIntegrity = 0.0, focusRelevance = 0.5 (same mems, different order)
    // composite = (0.5 + 1.0 + 0.0) / 3 ≈ 0.5
    expect(result.chronologyIntegrity).toBe(0.0);
    expect(result.composite).toBeCloseTo(0.5, 6);
  });

  it('returns composite ~0.6667 when focusRelevance fails (all mems irrelevant)', () => {
    // MEM_B_CUR [0.1,0.9] vs currentVec [1,0]: cos≈0.110 NOT RELEVANT
    // MEM_D_BKB [0.9,0.1] vs sessionVec [0,1]: cos≈0.110 NOT RELEVANT
    // → focusRelevance = 0.0, dedup = 1.0, chronology = 1.0
    // composite = (0.0 + 1.0 + 1.0) / 3 ≈ 0.6667
    const result = computeContextQualityScore({
      currentVec: CURRENT_VEC,
      sessionVec: SESSION_VEC,
      loadedMems: [MEM_B_CUR, MEM_D_BKB],
      activeChunkIds: CLEAN_ACTIVE_CHUNK_IDS,
      threshold: 0.5,
      rebuildOccurred: false,
    });
    expect(result.focusRelevance).toBe(0.0);
    expect(result.dedupCorrectness).toBe(1.0);
    expect(result.chronologyIntegrity).toBe(1.0);
    expect(result.composite).toBeCloseTo(2 / 3, 10);
  });

  it('returns composite = 1.0 for empty context', () => {
    // Empty loadedMems: all sub-metrics return 1.0
    const result = computeContextQualityScore({
      currentVec: CURRENT_VEC,
      sessionVec: SESSION_VEC,
      loadedMems: [],
      activeChunkIds: CLEAN_ACTIVE_CHUNK_IDS,
      threshold: 0.5,
      rebuildOccurred: false,
    });
    expect(result.focusRelevance).toBe(1.0);
    expect(result.dedupCorrectness).toBe(1.0);
    expect(result.chronologyIntegrity).toBe(1.0);
    expect(result.composite).toBe(1.0);
  });
});
