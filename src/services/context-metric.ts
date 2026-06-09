// src/services/context-metric.ts
// ContextQualityScore — composite metric for ContextFactory context quality.
//
// Three independent sub-metrics aggregated as an unweighted average:
//   ContextQualityScore = (focusRelevance + dedupCorrectness + chronologyIntegrity) / 3
//
// All sub-metrics are in [0.0, 1.0]. The metric is dim-agnostic: cosine similarity
// is used throughout, which works for any consistent embedding dimension.
//
// This metric is deterministic: given fixed inputs it always produces the same output.
// No LLM, no network, no DB — pure in-memory computation.
//
// Dual-vector focusRelevance (S2.9):
//   Each loaded mem carries a provenance tag ('current' | 'backbone').
//   'current' mems are scored against currentVec (per-turn embedding of the current fragment).
//   'backbone' mems are scored against sessionVec (normalized mean of recent closed mem embeddings).
//   A mem counts as relevant if cosineSimilarity(mem.embeddings.full, <its-provenance-vector>) >= threshold.
//   focusRelevance = (count of relevant mems) / (total loaded mems).   Returns 1.0 when empty.

import type { Mem } from '../types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Provenance-tagged mem (metric-local type)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A Mem tagged with its retrieval provenance.
 *
 * Structurally identical to LoadedMem in context-factory.ts — callers can pass
 * LoadedMem values directly without any cast (structural typing).
 *
 * Defined locally here to keep context-metric.ts self-contained and avoid
 * a circular import (context-factory imports context-metric indirectly via its consumers).
 *
 * 'current'  — retrieved per-turn via currentVec (current fragment embedding).
 * 'backbone' — retrieved at reconciliation via sessionVec (session/theme vector).
 */
export type ProvenanceMem = Mem & { provenance: 'current' | 'backbone' };

// ──────────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Breakdown of all three sub-metric scores plus the composite.
 */
export interface ContextQualityScore {
  /** Fraction of loaded mems relevant to their own provenance vector (>= threshold). Range [0.0, 1.0]. */
  focusRelevance: number;
  /** 1.0 if no loaded mem is contaminated (source chunk still active), 0.0 otherwise. */
  dedupCorrectness: number;
  /** Fraction of adjacent loaded-mem pairs in ascending closedAt order. 1.0 if <2 mems or no rebuild. */
  chronologyIntegrity: number;
  /** Unweighted average of the three sub-metrics. Range [0.0, 1.0]. */
  composite: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Inputs
// ──────────────────────────────────────────────────────────────────────────────

/**
 * All inputs required to compute ContextQualityScore.
 */
export interface ContextQualityInputs {
  /**
   * Per-turn embedding vector for the current fragment (unit-normalized).
   * Used as the relevance reference for mems with provenance === 'current'.
   */
  currentVec: number[];
  /**
   * Session/theme vector: normalized mean of recent closed mem embeddings.
   * Used as the relevance reference for mems with provenance === 'backbone'.
   * May be an empty array when no closed mems exist yet (cold-start).
   * In cold-start, backbone mems score as 0 (no provenance vector available).
   */
  sessionVec: number[];
  /** Ordered list of provenance-tagged mems assembled into the context (as held in session.loaded). */
  loadedMems: ProvenanceMem[];
  /**
   * Set of chunk IDs currently in 'active' status (raw-present signal).
   * A mem is contaminated if any of its chunkIds appears in this set.
   */
  activeChunkIds: Set<string>;
  /**
   * Similarity floor for focusRelevance sub-metric.
   * A mem counts as relevant if cosineSimilarity(mem.embeddings.full, <provenance-vector>) >= threshold.
   * Proposed default: 0.50.
   */
  threshold: number;
  /**
   * Whether a soft rebuild has occurred in this session.
   * chronologyIntegrity is 1.0 unconditionally when false (no rebuild = ordering not yet enforced).
   */
  rebuildOccurred: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Vector math (local — no dep on context-factory internals)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * General cosine similarity: dot(a, b) / (|a| * |b|).
 * Returns 0 for empty or mismatched-dimension vectors (degenerate case).
 * Does NOT require pre-normalized inputs.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric A: focusRelevance (dual-vector, S2.9)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fraction of loaded mems whose cosine similarity to their own provenance vector >= threshold.
 *
 * Each mem is scored against the vector that retrieved it:
 *   'current' mems → compared to currentVec (per-turn fragment embedding).
 *   'backbone' mems → compared to sessionVec (session/theme vector).
 *
 * Returns 1.0 when there are no loaded mems (empty context is trivially relevant).
 *
 * Cold-start guard: if sessionVec is empty ([] — no closed mems yet) and a backbone
 * mem is encountered, cosineSimilarity returns 0 (empty-vector path in cosineSimilarity),
 * which falls below any positive threshold. This is correct: without a session vector
 * there is no reference to score backbone mems against.
 *
 * Uses mem.embeddings.full as the mem's embedding vector — same field that
 * softRebuild() uses for scoring, ensuring metric-vs-factory consistency.
 */
export function computeFocusRelevance(
  currentVec: number[],
  sessionVec: number[],
  loadedMems: ProvenanceMem[],
  threshold: number,
): number {
  if (loadedMems.length === 0) return 1.0;
  let relevantCount = 0;
  for (const mem of loadedMems) {
    const provenanceVec = mem.provenance === 'backbone' ? sessionVec : currentVec;
    const sim = cosineSimilarity(mem.embeddings.full, provenanceVec);
    if (sim >= threshold) {
      relevantCount++;
    }
  }
  return relevantCount / loadedMems.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric B: dedupCorrectness
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Binary metric: 1.0 if no loaded mem is contaminated, 0.0 otherwise.
 * A mem is contaminated if any of its chunkIds appears in activeChunkIds.
 * Returns 1.0 when there are no loaded mems.
 *
 * This is a binary metric because a single near-duplicate in context can
 * confuse the model — partial credit would misrepresent the severity.
 *
 * Provenance is irrelevant for dedup: contamination check is the same regardless
 * of whether the mem was retrieved via currentVec or sessionVec.
 */
export function computeDedupCorrectness(
  loadedMems: ProvenanceMem[],
  activeChunkIds: Set<string>,
): number {
  for (const mem of loadedMems) {
    for (const chunkId of mem.chunkIds) {
      if (activeChunkIds.has(chunkId)) {
        return 0.0; // any contamination = full failure
      }
    }
  }
  return 1.0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-metric C: chronologyIntegrity
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fraction of adjacent loaded-mem pairs in ascending closedAt order.
 *
 * Returns 1.0 unconditionally when:
 * - rebuildOccurred is false (ordering not yet enforced — pre-rebuild state)
 * - loadedMems.length < 2 (no adjacent pairs to check)
 *
 * For rebuildOccurred=true with 2+ mems:
 *   violations = count of pairs where loadedMems[i].closedAt < loadedMems[i-1].closedAt
 *   chronologyIntegrity = 1.0 - (violations / (loadedMems.length - 1))
 *
 * Provenance is irrelevant for chronology: ordering check applies uniformly to all mems.
 */
export function computeChronologyIntegrity(
  loadedMems: ProvenanceMem[],
  rebuildOccurred: boolean,
): number {
  if (!rebuildOccurred) return 1.0;
  if (loadedMems.length < 2) return 1.0;

  let violations = 0;
  for (let i = 1; i < loadedMems.length; i++) {
    if (loadedMems[i]!.closedAt.getTime() < loadedMems[i - 1]!.closedAt.getTime()) {
      violations++;
    }
  }
  return 1.0 - violations / (loadedMems.length - 1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Composite metric
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full ContextQualityScore from session state inputs.
 *
 * Composite formula: (focusRelevance + dedupCorrectness + chronologyIntegrity) / 3
 *
 * All three sub-metrics are computed independently and are each in [0.0, 1.0].
 * The composite is their unweighted average.
 *
 * This function is the single entry point for the metric — callers do not need
 * to call the sub-metric functions individually unless they need per-sub-metric
 * values for debugging.
 */
export function computeContextQualityScore(inputs: ContextQualityInputs): ContextQualityScore {
  const focusRelevance = computeFocusRelevance(
    inputs.currentVec,
    inputs.sessionVec,
    inputs.loadedMems,
    inputs.threshold,
  );
  const dedupCorrectness = computeDedupCorrectness(
    inputs.loadedMems,
    inputs.activeChunkIds,
  );
  const chronologyIntegrity = computeChronologyIntegrity(
    inputs.loadedMems,
    inputs.rebuildOccurred,
  );
  const composite = (focusRelevance + dedupCorrectness + chronologyIntegrity) / 3;

  return { focusRelevance, dedupCorrectness, chronologyIntegrity, composite };
}
