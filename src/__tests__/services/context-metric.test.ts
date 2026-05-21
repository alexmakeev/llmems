// src/__tests__/services/context-metric.test.ts
// Tests for context-metric.ts — ContextQualityScore and sub-metrics.
//
// All tests are deterministic: fixed fixture, no LLM, no network, no DB.
// Embedding dimension is small (2-dim) for readability; the metric is dim-agnostic.
//
// Fixture description (baseline measurement — 2026-05-21):
//   focus = [1, 0]  (unit vector, first dimension)
//   4 mems with 2-dim embeddings and known closedAt timestamps:
//     mem A: [0.9, 0.1] — cosine ~0.994 >= 0.5 — RELEVANT
//     mem B: [0.8, 0.2] — cosine ~0.970 >= 0.5 — RELEVANT
//     mem C: [0.1, 0.9] — cosine ~0.110 <  0.5 — NOT RELEVANT
//     mem D: [0.85,0.1] — cosine ~0.993 >= 0.5 — RELEVANT
//   activeChunkIds = empty Set (no contamination)
//   rebuildOccurred = false (pre-rebuild session)
//
// Baseline sub-scores:
//   focusRelevance     = 3/4    = 0.75   (3 of 4 mems above threshold)
//   dedupCorrectness   = 1.0            (no active chunks)
//   chronologyIntegrity = 1.0           (rebuildOccurred=false)
//   composite          = (0.75 + 1.0 + 1.0) / 3 ≈ 0.9167

import { describe, it, expect } from 'vitest';
import type { Mem } from '../../types.js';
import {
  computeFocusRelevance,
  computeDedupCorrectness,
  computeChronologyIntegrity,
  computeContextQualityScore,
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

// Baseline fixture: 4 mems, timestamps t1 < t2 < t3 < t4 (ascending)
const t1 = 1000;
const t2 = 2000;
const t3 = 3000;
const t4 = 4000;

const FOCUS: number[] = [1, 0]; // unit vector, first dimension

const MEM_A = makeMem('mem-A', [0.9, 0.1], ['1', '2'], t1); // relevant
const MEM_B = makeMem('mem-B', [0.8, 0.2], ['3', '4'], t2); // relevant
const MEM_C = makeMem('mem-C', [0.1, 0.9], ['5'], t3);      // not relevant
const MEM_D = makeMem('mem-D', [0.85, 0.1], ['6'], t4);     // relevant

const CLEAN_ACTIVE_CHUNK_IDS = new Set<string>(); // empty = no contamination

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric A: focusRelevance
// ──────────────────────────────────────────────────────────────────────────────

describe('computeFocusRelevance', () => {
  it('returns 1.0 for empty loadedMems', () => {
    expect(computeFocusRelevance(FOCUS, [], 0.5)).toBe(1.0);
  });

  it('returns 0.75 on baseline fixture: 3 of 4 mems are relevant', () => {
    const score = computeFocusRelevance(FOCUS, [MEM_A, MEM_B, MEM_C, MEM_D], 0.5);
    expect(score).toBeCloseTo(0.75, 10);
  });

  it('mem C (embedding [0.1, 0.9]) has cosine similarity < 0.5 to focus [1, 0]', () => {
    // Cosine([0.1,0.9], [1,0]) = 0.1 / sqrt(0.82) ≈ 0.110
    const score = computeFocusRelevance(FOCUS, [MEM_C], 0.5);
    expect(score).toBe(0.0);
  });

  it('mem A (embedding [0.9, 0.1]) has cosine similarity >= 0.5 to focus [1, 0]', () => {
    const score = computeFocusRelevance(FOCUS, [MEM_A], 0.5);
    expect(score).toBe(1.0);
  });

  it('returns 0.0 when all mems are below threshold', () => {
    // Both mems are orthogonal to focus [1,0]
    const orthogonal = makeMem('o1', [0, 1], [], t1);
    const score = computeFocusRelevance(FOCUS, [orthogonal], 0.5);
    expect(score).toBe(0.0);
  });

  it('threshold boundary: mem exactly at threshold is counted as relevant', () => {
    // Unit vector [1,0]: cosine with itself = 1.0 >= any threshold
    const aligned = makeMem('aligned', [1, 0], [], t1);
    expect(computeFocusRelevance([1, 0], [aligned], 1.0)).toBe(1.0);
  });

  it('returns 1.0 when all mems are above threshold', () => {
    const score = computeFocusRelevance(FOCUS, [MEM_A, MEM_B, MEM_D], 0.5);
    expect(score).toBe(1.0);
  });

  it('is dim-agnostic: works with 3-dim vectors', () => {
    const focus3 = [1, 0, 0];
    const mem3 = makeMem('3d-relevant', [0.9, 0.1, 0.1], [], t1);
    const score = computeFocusRelevance(focus3, [mem3], 0.5);
    expect(score).toBe(1.0); // cosine ≈ 0.9 / sqrt(0.83) ≈ 0.987
  });

  it('handles mems with empty embedding vector (returns 0 similarity)', () => {
    const emptyEmbedding = makeMem('empty-emb', [], [], t1);
    const score = computeFocusRelevance(FOCUS, [emptyEmbedding], 0.5);
    expect(score).toBe(0.0); // cosineSimilarity returns 0 for empty vectors
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric B: dedupCorrectness
// ──────────────────────────────────────────────────────────────────────────────

describe('computeDedupCorrectness', () => {
  it('returns 1.0 for empty loadedMems', () => {
    expect(computeDedupCorrectness([], CLEAN_ACTIVE_CHUNK_IDS)).toBe(1.0);
  });

  it('returns 1.0 on baseline fixture: no active chunks', () => {
    const score = computeDedupCorrectness([MEM_A, MEM_B, MEM_C, MEM_D], CLEAN_ACTIVE_CHUNK_IDS);
    expect(score).toBe(1.0);
  });

  it('returns 0.0 when one mem has an active chunk (contamination detected)', () => {
    // chunk '3' belongs to MEM_B
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
    const sameTime1 = makeMem('s1', [1, 0], [], 1000);
    const sameTime2 = makeMem('s2', [1, 0], [], 1000); // same closedAt — not a violation
    expect(computeChronologyIntegrity([sameTime1, sameTime2], true)).toBe(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Composite: computeContextQualityScore — BASELINE MEASUREMENT
// ──────────────────────────────────────────────────────────────────────────────

describe('computeContextQualityScore — baseline fixture', () => {
  it('computes expected sub-scores and composite on the clean baseline fixture', () => {
    // BASELINE FIXTURE (2026-05-21) — deterministic, no LLM/network/DB
    // focus = [1, 0], 4 mems, no active chunks, no rebuild
    const result = computeContextQualityScore({
      focus: FOCUS,
      loadedMems: [MEM_A, MEM_B, MEM_C, MEM_D],
      activeChunkIds: CLEAN_ACTIVE_CHUNK_IDS,
      threshold: 0.5,
      rebuildOccurred: false,
    });

    // Sub-metric assertions
    expect(result.focusRelevance).toBeCloseTo(0.75, 10);        // 3/4 mems relevant
    expect(result.dedupCorrectness).toBe(1.0);                  // no contamination
    expect(result.chronologyIntegrity).toBe(1.0);               // no rebuild yet

    // Composite: (0.75 + 1.0 + 1.0) / 3 ≈ 0.9167
    expect(result.composite).toBeCloseTo(0.9166666667, 6);

    // Gate: baseline composite must be above 0.7 (Phase-2 uplift gate per docs/baseline-metric.md)
    expect(result.composite).toBeGreaterThan(0.7);
  });

  it('returns lower composite when dedup is contaminated', () => {
    // chunk '3' belongs to MEM_B — contaminated
    const result = computeContextQualityScore({
      focus: FOCUS,
      loadedMems: [MEM_A, MEM_B, MEM_C, MEM_D],
      activeChunkIds: new Set(['3']),
      threshold: 0.5,
      rebuildOccurred: false,
    });
    // dedupCorrectness = 0.0 => composite = (0.75 + 0 + 1.0) / 3 ≈ 0.583
    expect(result.dedupCorrectness).toBe(0.0);
    expect(result.composite).toBeCloseTo(0.5833333333, 6);
  });

  it('returns lower composite when chronology is violated (after rebuild)', () => {
    // Mems in reverse order: t4, t3, t2, t1 — 3 violations out of 3 pairs => score 0.0
    const result = computeContextQualityScore({
      focus: FOCUS,
      loadedMems: [MEM_D, MEM_C, MEM_B, MEM_A],
      activeChunkIds: CLEAN_ACTIVE_CHUNK_IDS,
      threshold: 0.5,
      rebuildOccurred: true,
    });
    // chronologyIntegrity = 0.0 => composite = (0.75 + 1.0 + 0.0) / 3 ≈ 0.583
    expect(result.chronologyIntegrity).toBe(0.0);
    expect(result.composite).toBeCloseTo(0.5833333333, 6);
  });

  it('returns composite = 0 when all sub-metrics fail', () => {
    // All relevant mems below threshold, contaminated, and in reverse chronological order
    const allBelow = [MEM_C]; // only mem below threshold in fixture
    const result = computeContextQualityScore({
      focus: FOCUS,
      loadedMems: [allBelow[0]!],
      activeChunkIds: new Set(['5']), // MEM_C's chunkId
      threshold: 0.5,
      rebuildOccurred: true, // with single mem, chronology = 1.0 — cannot get all zeros with <2 mems
    });
    // focusRelevance = 0.0, dedupCorrectness = 0.0, chronologyIntegrity = 1.0 (single mem)
    expect(result.focusRelevance).toBe(0.0);
    expect(result.dedupCorrectness).toBe(0.0);
    expect(result.chronologyIntegrity).toBe(1.0);
    expect(result.composite).toBeCloseTo(1 / 3, 10);
  });

  it('returns composite = 1.0 for empty context', () => {
    // Empty loadedMems: all sub-metrics return 1.0
    const result = computeContextQualityScore({
      focus: FOCUS,
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
