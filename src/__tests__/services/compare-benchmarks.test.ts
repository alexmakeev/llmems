// src/__tests__/services/compare-benchmarks.test.ts
// Unit tests for compareBenchmarks pure function.
// All offline — synthetic inputs only.

import { describe, it, expect } from 'vitest';
import { compareBenchmarks } from '../../services/graph/compare-benchmarks.js';
import type { BenchmarkFile, StrategyComparison } from '../../services/graph/compare-benchmarks.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAggregate(
  strategy: string,
  r5: number,
  r10: number,
  p5: number,
  p10: number,
  excluded: number,
) {
  return {
    strategy,
    meanRecallAt5: r5,
    meanRecallAt10: r10,
    meanPrecisionAt5: p5,
    meanPrecisionAt10: p10,
    excludedQuestions: excluded,
  };
}

function makeBenchmark(aggregates: ReturnType<typeof makeAggregate>[]): BenchmarkFile {
  return {
    metadata: {
      testName: 'test',
      runAt: '2026-01-01T00:00:00Z',
      questionsTotal: 100,
      questionsSucceeded: 95,
      questionsFailed: 5,
      memstoreId: 4,
      contextId: 'ctx',
      projectionThreshold: 0.3,
      graphNeighbors: 10,
      goldSetFile: '/tmp/gold.json',
      goldSetGeneratedAt: '2026-01-01T00:00:00Z',
      goldSetJudgeModel: 'test-model',
    },
    strategyAggregates: aggregates,
    axisStats: [],
    categoryStats: [],
    questionResults: [],
  };
}

// Full set of 5 canonical strategies
const STRATEGIES = [
  'vectorRecall',
  'graphEnrichedRecall',
  'projectionMaxPerAxis',
  'projectionSumAcrossAxes',
  'projectionIntersection',
];

function makeFullBenchmark(
  values: Record<string, { r5: number; r10: number; p5: number; p10: number; excl: number }>,
): BenchmarkFile {
  return makeBenchmark(
    STRATEGIES.map(s => {
      const v = values[s] ?? { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 };
      return makeAggregate(s, v.r5, v.r10, v.p5, v.p10, v.excl);
    }),
  );
}

// ── compareBenchmarks: delta computation ───────────────────────────────────────

describe('compareBenchmarks', () => {
  it('computes correct recall delta for each strategy and K', () => {
    const baseline = makeFullBenchmark({
      vectorRecall: { r5: 0.50, r10: 0.60, p5: 0.30, p10: 0.25, excl: 2 },
      graphEnrichedRecall: { r5: 0.55, r10: 0.65, p5: 0.32, p10: 0.28, excl: 2 },
      projectionMaxPerAxis: { r5: 0.40, r10: 0.50, p5: 0.20, p10: 0.18, excl: 3 },
      projectionSumAcrossAxes: { r5: 0.45, r10: 0.55, p5: 0.22, p10: 0.20, excl: 3 },
      projectionIntersection: { r5: 0.35, r10: 0.45, p5: 0.18, p10: 0.15, excl: 4 },
    });
    const variant = makeFullBenchmark({
      vectorRecall: { r5: 0.52, r10: 0.63, p5: 0.31, p10: 0.26, excl: 2 },
      graphEnrichedRecall: { r5: 0.53, r10: 0.62, p5: 0.30, p10: 0.27, excl: 2 },
      projectionMaxPerAxis: { r5: 0.48, r10: 0.58, p5: 0.25, p10: 0.22, excl: 3 },
      projectionSumAcrossAxes: { r5: 0.46, r10: 0.56, p5: 0.23, p10: 0.21, excl: 3 },
      projectionIntersection: { r5: 0.36, r10: 0.46, p5: 0.19, p10: 0.16, excl: 4 },
    });

    const result = compareBenchmarks(baseline, variant);

    // Should have one entry per strategy × K combination
    // 5 strategies × 2 K values = 10 entries
    expect(result).toHaveLength(10);

    // Check vectorRecall at K=5
    const vec5 = result.find(r => r.strategy === 'vectorRecall' && r.K === 5);
    expect(vec5).toBeDefined();
    expect(vec5!.recall.baseline).toBeCloseTo(0.50);
    expect(vec5!.recall.variant).toBeCloseTo(0.52);
    expect(vec5!.recall.delta).toBeCloseTo(0.02);
    expect(vec5!.precision.baseline).toBeCloseTo(0.30);
    expect(vec5!.precision.variant).toBeCloseTo(0.31);
    expect(vec5!.precision.delta).toBeCloseTo(0.01);

    // Check vectorRecall at K=10
    const vec10 = result.find(r => r.strategy === 'vectorRecall' && r.K === 10);
    expect(vec10).toBeDefined();
    expect(vec10!.recall.baseline).toBeCloseTo(0.60);
    expect(vec10!.recall.variant).toBeCloseTo(0.63);
    expect(vec10!.recall.delta).toBeCloseTo(0.03);
    expect(vec10!.precision.baseline).toBeCloseTo(0.25);
    expect(vec10!.precision.variant).toBeCloseTo(0.26);
    expect(vec10!.precision.delta).toBeCloseTo(0.01);
  });

  it('returns negative delta when variant is worse', () => {
    const baseline = makeFullBenchmark({
      vectorRecall: { r5: 0.70, r10: 0.80, p5: 0.50, p10: 0.45, excl: 0 },
      graphEnrichedRecall: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
      projectionMaxPerAxis: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
      projectionSumAcrossAxes: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
      projectionIntersection: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
    });
    const variant = makeFullBenchmark({
      vectorRecall: { r5: 0.60, r10: 0.70, p5: 0.40, p10: 0.35, excl: 0 },
      graphEnrichedRecall: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
      projectionMaxPerAxis: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
      projectionSumAcrossAxes: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
      projectionIntersection: { r5: 0, r10: 0, p5: 0, p10: 0, excl: 0 },
    });

    const result = compareBenchmarks(baseline, variant);
    const vec5 = result.find(r => r.strategy === 'vectorRecall' && r.K === 5);
    expect(vec5!.recall.delta).toBeCloseTo(-0.10);
    expect(vec5!.precision.delta).toBeCloseTo(-0.10);
  });

  it('surfaces excluded question counts for each strategy', () => {
    const baseline = makeFullBenchmark({
      vectorRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 7 },
      graphEnrichedRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 3 },
      projectionMaxPerAxis: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 5 },
      projectionSumAcrossAxes: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 5 },
      projectionIntersection: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 5 },
    });
    const variant = makeFullBenchmark({
      vectorRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 8 },
      graphEnrichedRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 4 },
      projectionMaxPerAxis: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 5 },
      projectionSumAcrossAxes: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 5 },
      projectionIntersection: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 5 },
    });

    const result = compareBenchmarks(baseline, variant);
    // Each (strategy, K) pair carries excluded counts — both K values of same strategy share the same excludedQuestions
    const vec5 = result.find(r => r.strategy === 'vectorRecall' && r.K === 5);
    expect(vec5!.excludedQuestions.baseline).toBe(7);
    expect(vec5!.excludedQuestions.variant).toBe(8);

    const graph5 = result.find(r => r.strategy === 'graphEnrichedRecall' && r.K === 5);
    expect(graph5!.excludedQuestions.baseline).toBe(3);
    expect(graph5!.excludedQuestions.variant).toBe(4);
  });

  it('handles strategies present in baseline but missing from variant with note', () => {
    const baseline = makeBenchmark([
      makeAggregate('vectorRecall', 0.5, 0.6, 0.3, 0.25, 2),
      makeAggregate('graphEnrichedRecall', 0.55, 0.65, 0.32, 0.28, 2),
    ]);
    const variant = makeBenchmark([
      makeAggregate('vectorRecall', 0.52, 0.62, 0.31, 0.26, 2),
      // graphEnrichedRecall missing
    ]);

    // Should not throw — should return entries with a mismatch marker
    expect(() => compareBenchmarks(baseline, variant)).not.toThrow();
    const result = compareBenchmarks(baseline, variant);

    // vectorRecall present in both — should have entries at K=5 and K=10
    const vec5 = result.find(r => r.strategy === 'vectorRecall' && r.K === 5);
    expect(vec5).toBeDefined();
    expect(vec5!.mismatch).toBeUndefined();

    // graphEnrichedRecall only in baseline — should have entries marked as mismatch
    const graph5 = result.find(r => r.strategy === 'graphEnrichedRecall' && r.K === 5);
    expect(graph5).toBeDefined();
    expect(graph5!.mismatch).toBe('missing-in-variant');
  });

  it('handles strategies present in variant but missing from baseline with note', () => {
    const baseline = makeBenchmark([
      makeAggregate('vectorRecall', 0.5, 0.6, 0.3, 0.25, 2),
    ]);
    const variant = makeBenchmark([
      makeAggregate('vectorRecall', 0.52, 0.62, 0.31, 0.26, 2),
      makeAggregate('projectionMaxPerAxis', 0.45, 0.55, 0.25, 0.22, 3),
    ]);

    const result = compareBenchmarks(baseline, variant);
    const proj5 = result.find(r => r.strategy === 'projectionMaxPerAxis' && r.K === 5);
    expect(proj5).toBeDefined();
    expect(proj5!.mismatch).toBe('missing-in-baseline');
  });

  it('delta is zero when both sides are identical', () => {
    const bench = makeFullBenchmark({
      vectorRecall: { r5: 0.65, r10: 0.75, p5: 0.40, p10: 0.35, excl: 2 },
      graphEnrichedRecall: { r5: 0.65, r10: 0.75, p5: 0.40, p10: 0.35, excl: 2 },
      projectionMaxPerAxis: { r5: 0.65, r10: 0.75, p5: 0.40, p10: 0.35, excl: 2 },
      projectionSumAcrossAxes: { r5: 0.65, r10: 0.75, p5: 0.40, p10: 0.35, excl: 2 },
      projectionIntersection: { r5: 0.65, r10: 0.75, p5: 0.40, p10: 0.35, excl: 2 },
    });

    const result = compareBenchmarks(bench, bench);
    for (const row of result) {
      if (row.mismatch === undefined) {
        expect(row.recall.delta).toBeCloseTo(0);
        expect(row.precision.delta).toBeCloseTo(0);
      }
    }
  });

  it('produces entries for both K=5 and K=10 for each strategy', () => {
    const bench = makeFullBenchmark({
      vectorRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 0 },
      graphEnrichedRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 0 },
      projectionMaxPerAxis: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 0 },
      projectionSumAcrossAxes: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 0 },
      projectionIntersection: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 0 },
    });

    const result = compareBenchmarks(bench, bench);
    const Ks = [...new Set(result.map(r => r.K))].sort((a, b) => a - b);
    expect(Ks).toEqual([5, 10]);

    for (const strategy of STRATEGIES) {
      expect(result.filter(r => r.strategy === strategy)).toHaveLength(2);
    }
  });

  it('result type satisfies StrategyComparison shape', () => {
    const bench = makeFullBenchmark({
      vectorRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 1 },
      graphEnrichedRecall: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 1 },
      projectionMaxPerAxis: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 1 },
      projectionSumAcrossAxes: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 1 },
      projectionIntersection: { r5: 0.5, r10: 0.6, p5: 0.3, p10: 0.25, excl: 1 },
    });

    const result = compareBenchmarks(bench, bench);
    const row: StrategyComparison = result[0]!;

    expect(typeof row.strategy).toBe('string');
    expect(typeof row.K).toBe('number');
    expect(typeof row.recall.baseline).toBe('number');
    expect(typeof row.recall.variant).toBe('number');
    expect(typeof row.recall.delta).toBe('number');
    expect(typeof row.precision.baseline).toBe('number');
    expect(typeof row.precision.variant).toBe('number');
    expect(typeof row.precision.delta).toBe('number');
    expect(typeof row.excludedQuestions.baseline).toBe('number');
    expect(typeof row.excludedQuestions.variant).toBe('number');
  });
});
