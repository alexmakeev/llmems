// src/services/graph/benchmark-aggregation.ts
// Pure aggregation functions for per-axis recall results in benchmark-recall.ts.
// All functions are exported for unit testing — no side effects, no I/O.

import type { SemanticAxis } from './types.js';

// ── Input/Output types ─────────────────────────────────────────────────────────

/** A single mem match from one axis's cosine search. */
export interface AxisRecallEntry {
  memId: string;
  similarity: number;
}

/** Aggregated result for a mem across all axes it appeared in. */
export interface AggregatedEntry {
  memId: string;
  /** Aggregation-strategy-specific score (see each function's doc for definition). */
  score: number;
  /** Number of distinct axes on which this mem appeared. */
  axisCount: number;
}

/** Per-axis recall results: axis → ranked list of mem matches. */
export type PerAxisResults = Map<SemanticAxis, AxisRecallEntry[]>;

// ── Internal helper ────────────────────────────────────────────────────────────

/**
 * Collect all per-mem similarity values across all axes.
 * Returns a Map from memId to an array of similarity scores (one per axis occurrence).
 */
function collectPerMem(
  perAxisResults: PerAxisResults,
): Map<string, number[]> {
  const collected = new Map<string, number[]>();
  for (const entries of perAxisResults.values()) {
    for (const entry of entries) {
      const existing = collected.get(entry.memId);
      if (existing !== undefined) {
        existing.push(entry.similarity);
      } else {
        collected.set(entry.memId, [entry.similarity]);
      }
    }
  }
  return collected;
}

/**
 * Count distinct axes for each mem.
 * Returns a Map from memId to the number of distinct axes it appeared in.
 */
function countDistinctAxes(
  perAxisResults: PerAxisResults,
): Map<string, number> {
  const axisCounts = new Map<string, number>();
  for (const entries of perAxisResults.values()) {
    const seenInThisAxis = new Set<string>();
    for (const entry of entries) {
      // Each DB query returns at most one entry per memId per axis (sorted, limited).
      // Guard against duplicates within a single axis just in case.
      if (!seenInThisAxis.has(entry.memId)) {
        seenInThisAxis.add(entry.memId);
        axisCounts.set(entry.memId, (axisCounts.get(entry.memId) ?? 0) + 1);
      }
    }
  }
  return axisCounts;
}

// ── Strategy 1: max-per-axis ───────────────────────────────────────────────────

/**
 * Aggregate per-axis recall results using the MAX-PER-AXIS strategy.
 *
 * score(mem) = MAX similarity over all axes where the mem appears.
 * Ranked by score descending.
 * axisCount = number of distinct axes the mem appeared in.
 */
export function aggregateMaxPerAxis(perAxisResults: PerAxisResults): AggregatedEntry[] {
  const perMemSims = collectPerMem(perAxisResults);
  const axisCounts = countDistinctAxes(perAxisResults);

  const entries: AggregatedEntry[] = [];
  for (const [memId, sims] of perMemSims) {
    const score = Math.max(...sims);
    const axisCount = axisCounts.get(memId) ?? 1;
    entries.push({ memId, score, axisCount });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// ── Strategy 2: sum-across-axes ───────────────────────────────────────────────

/**
 * Aggregate per-axis recall results using the SUM-ACROSS-AXES strategy.
 *
 * score(mem) = SUM of similarities over all axes where the mem appears.
 * Ranked by score descending.
 * axisCount = number of distinct axes the mem appeared in.
 */
export function aggregateSumAcrossAxes(perAxisResults: PerAxisResults): AggregatedEntry[] {
  const perMemSims = collectPerMem(perAxisResults);
  const axisCounts = countDistinctAxes(perAxisResults);

  const entries: AggregatedEntry[] = [];
  for (const [memId, sims] of perMemSims) {
    const score = sims.reduce((acc, s) => acc + s, 0);
    const axisCount = axisCounts.get(memId) ?? 1;
    entries.push({ memId, score, axisCount });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// ── Strategy 3: intersection ───────────────────────────────────────────────────

/**
 * Aggregate per-axis recall results using the INTERSECTION strategy.
 *
 * Primary sort:  axisCount (number of distinct axes mem appears in) DESC.
 * Tie-break:     sum of similarities DESC.
 * 1-axis mems are included but ranked below multi-axis mems.
 *
 * score = sum of similarities (used as tie-breaker and for downstream hit-criterion).
 * axisCount = number of distinct axes the mem appeared in.
 */
export function aggregateIntersection(perAxisResults: PerAxisResults): AggregatedEntry[] {
  const perMemSims = collectPerMem(perAxisResults);
  const axisCounts = countDistinctAxes(perAxisResults);

  const entries: AggregatedEntry[] = [];
  for (const [memId, sims] of perMemSims) {
    const score = sims.reduce((acc, s) => acc + s, 0);
    const axisCount = axisCounts.get(memId) ?? 1;
    entries.push({ memId, score, axisCount });
  }

  // Primary: axisCount desc. Tie-break: score (sum) desc.
  entries.sort((a, b) => {
    if (b.axisCount !== a.axisCount) return b.axisCount - a.axisCount;
    return b.score - a.score;
  });

  return entries;
}
