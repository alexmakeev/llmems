// src/services/graph/compare-benchmarks.ts
// Pure, exported, unit-testable function for comparing two benchmark JSON files.
// No I/O, no side effects — designed for import by both tests and the CLI script.

// ── Types mirroring the BenchmarkOutput schema ────────────────────────────────

/** Aggregate recall@K / precision@K for one strategy, as written by benchmark-recall.ts */
export interface StrategyAggregate {
  strategy: string;
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanPrecisionAt5: number;
  meanPrecisionAt10: number;
  excludedQuestions: number;
}

/** Subset of BenchmarkOutput used by compareBenchmarks — only strategyAggregates is required. */
export interface BenchmarkFile {
  metadata: {
    testName: string;
    runAt: string;
    questionsTotal: number;
    questionsSucceeded: number;
    questionsFailed: number;
    memstoreId: number;
    contextId: string;
    projectionThreshold: number;
    graphNeighbors: number;
    goldSetFile: string;
    goldSetGeneratedAt: string;
    goldSetJudgeModel: string;
  };
  strategyAggregates: StrategyAggregate[];
  // Remainder of BenchmarkOutput not needed for comparison
  axisStats: unknown[];
  categoryStats: unknown[];
  questionResults: unknown[];
}

// ── Output types ───────────────────────────────────────────────────────────────

/** Mismatch reason when a strategy is only in one of the two files. */
export type MismatchReason = 'missing-in-baseline' | 'missing-in-variant';

/** Delta entry for one strategy at one K value. */
export interface StrategyComparison {
  strategy: string;
  K: 5 | 10;
  recall: {
    baseline: number;
    variant: number;
    /** variant - baseline; positive = variant is better */
    delta: number;
  };
  precision: {
    baseline: number;
    variant: number;
    delta: number;
  };
  excludedQuestions: {
    baseline: number;
    variant: number;
  };
  /**
   * Present only when the strategy exists in exactly one of the two files.
   * In this case recall/precision values for the missing side are 0,
   * and the delta is meaningless — consumers should surface the mismatch note instead.
   */
  mismatch?: MismatchReason;
}

// ── Core pure function ─────────────────────────────────────────────────────────

/**
 * Compare two benchmark JSON files and return per-strategy, per-K delta rows.
 *
 * For each strategy present in either file and each K ∈ {5, 10}, produces a
 * StrategyComparison with signed deltas (variant − baseline).
 *
 * Strategies present in only one file are included with mismatch set to
 * 'missing-in-baseline' or 'missing-in-variant'; their delta values are not
 * meaningful and the caller should communicate the discrepancy rather than
 * treating the delta as valid.
 *
 * @param baseline - Parsed content of the baseline benchmark JSON.
 * @param variant  - Parsed content of the variant benchmark JSON.
 * @returns Array of StrategyComparison rows, one per (strategy × K) pair.
 */
export function compareBenchmarks(
  baseline: BenchmarkFile,
  variant: BenchmarkFile,
): StrategyComparison[] {
  const baselineMap = new Map<string, StrategyAggregate>(
    baseline.strategyAggregates.map(a => [a.strategy, a]),
  );
  const variantMap = new Map<string, StrategyAggregate>(
    variant.strategyAggregates.map(a => [a.strategy, a]),
  );

  // Union of all strategy names, preserving order (baseline first, then variant-only)
  const allStrategies: string[] = [];
  for (const s of baselineMap.keys()) allStrategies.push(s);
  for (const s of variantMap.keys()) {
    if (!baselineMap.has(s)) allStrategies.push(s);
  }

  const rows: StrategyComparison[] = [];

  for (const strategy of allStrategies) {
    const b = baselineMap.get(strategy);
    const v = variantMap.get(strategy);

    const mismatch: MismatchReason | undefined =
      b === undefined ? 'missing-in-baseline' :
      v === undefined ? 'missing-in-variant' :
      undefined;

    // Use 0 as sentinel for missing side — caller should check mismatch field
    const bR5 = b?.meanRecallAt5 ?? 0;
    const bR10 = b?.meanRecallAt10 ?? 0;
    const bP5 = b?.meanPrecisionAt5 ?? 0;
    const bP10 = b?.meanPrecisionAt10 ?? 0;
    const bExcl = b?.excludedQuestions ?? 0;

    const vR5 = v?.meanRecallAt5 ?? 0;
    const vR10 = v?.meanRecallAt10 ?? 0;
    const vP5 = v?.meanPrecisionAt5 ?? 0;
    const vP10 = v?.meanPrecisionAt10 ?? 0;
    const vExcl = v?.excludedQuestions ?? 0;

    const baseRow = {
      excludedQuestions: { baseline: bExcl, variant: vExcl },
      ...(mismatch !== undefined ? { mismatch } : {}),
    };

    rows.push({
      strategy,
      K: 5,
      recall: { baseline: bR5, variant: vR5, delta: vR5 - bR5 },
      precision: { baseline: bP5, variant: vP5, delta: vP5 - bP5 },
      ...baseRow,
    });

    rows.push({
      strategy,
      K: 10,
      recall: { baseline: bR10, variant: vR10, delta: vR10 - bR10 },
      precision: { baseline: bP10, variant: vP10, delta: vP10 - bP10 },
      ...baseRow,
    });
  }

  return rows;
}
