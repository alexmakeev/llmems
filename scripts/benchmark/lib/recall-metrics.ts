// scripts/benchmark/lib/recall-metrics.ts — recall@K / precision@K (bead llmems-g3a).
//
// PROVENANCE: formulas re-derived 1:1 from the archived graph-era implementation
// (feature-context-factory history, commit eef63df, src/services/graph/recall-metrics.ts)
// so benchmark numbers stay comparable with the archived A/B verdict in
// docs/axis-experiment.md (vectorRecall R@5 0.524 / R@10 0.668). No graph imports.

/**
 * recall@K = |topK ∩ expected| / |expected|.
 * Returns null when expectedMemIds is empty — the question is excluded from
 * recall averaging (same exclusion rule as the archived run).
 */
export function recallAtK(
  rankedMemIds: string[],
  expectedMemIds: Set<string>,
  k: number,
): number | null {
  if (expectedMemIds.size === 0) return null;
  const topK = rankedMemIds.slice(0, k);
  const hits = topK.filter((id) => expectedMemIds.has(id)).length;
  return hits / expectedMemIds.size;
}

/**
 * precision@K = |topK ∩ expected| / min(K, |topK|).
 * Returns 0 for an empty ranked list or an empty expected set.
 */
export function precisionAtK(
  rankedMemIds: string[],
  expectedMemIds: Set<string>,
  k: number,
): number {
  const topK = rankedMemIds.slice(0, k);
  const denominator = Math.min(k, topK.length);
  if (denominator === 0) return 0;
  const hits = topK.filter((id) => expectedMemIds.has(id)).length;
  return hits / denominator;
}

/** Mean of values; 0 for empty input (same convention as the archived run). */
export function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * recall_any@K — LongMemEval official retrieval metric (bead llmems-mdg).
 *
 * PROVENANCE: mirrors LongMemEval's print_retrieval_metrics.py: per question,
 * the hit is binary — 1 if ANY expected session id appears in the top-K of the
 * ranked list after deduplication to UNIQUE session ids (first-occurrence rank
 * order preserved). DIFFERENT metric from the fractional recallAtK above
 * (kept untouched for archived-baseline comparability) — do not mix them.
 *
 * Empty expected set throws loudly: abstention questions (dummy
 * answer_session_ids) must be excluded BEFORE scoring, never silently scored.
 */
export function recallAnyAtK(
  rankedSessionIds: string[],
  expectedSessionIds: Set<string>,
  k: number,
): 0 | 1 {
  if (expectedSessionIds.size === 0) {
    throw new Error(
      'recall_any@K: expected session set is empty — abstention questions must be ' +
        'excluded from scoring (official denominator rule), not scored with dummy ids.',
    );
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of rankedSessionIds) {
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  return deduped.slice(0, k).some((id) => expectedSessionIds.has(id)) ? 1 : 0;
}
