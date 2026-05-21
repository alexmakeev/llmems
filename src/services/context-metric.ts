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

import type { Mem } from '../types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Breakdown of all three sub-metric scores plus the composite.
 */
export interface ContextQualityScore {
  /** Fraction of loaded mems with cosine similarity to focus >= threshold. Range [0.0, 1.0]. */
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
  /** Current session focus vector (any consistent dimension). */
  focus: number[];
  /** Ordered list of mems assembled into the context (as held in session.loaded). */
  loadedMems: Mem[];
  /**
   * Set of chunk IDs currently in 'active' status (raw-present signal).
   * A mem is contaminated if any of its chunkIds appears in this set.
   */
  activeChunkIds: Set<string>;
  /**
   * Similarity floor for focusRelevance sub-metric.
   * A mem counts as relevant if cosineSimilarity(mem.embeddings.full, focus) >= threshold.
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
// Sub-metric A: focusRelevance
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fraction of loaded mems whose cosine similarity to focus >= threshold.
 * Returns 1.0 when there are no loaded mems (empty context is trivially relevant).
 *
 * Uses mem.embeddings.full as the mem's embedding vector — same field that
 * softRebuild() uses for scoring, ensuring metric-vs-factory consistency.
 */
export function computeFocusRelevance(
  focus: number[],
  loadedMems: Mem[],
  threshold: number,
): number {
  if (loadedMems.length === 0) return 1.0;
  let relevantCount = 0;
  for (const mem of loadedMems) {
    const sim = cosineSimilarity(mem.embeddings.full, focus);
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
 */
export function computeDedupCorrectness(
  loadedMems: Mem[],
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
 */
export function computeChronologyIntegrity(
  loadedMems: Mem[],
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
    inputs.focus,
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
