// Tests for scripts/benchmark/lib/recall-metrics.ts (bead llmems-g3a).
// Formulas re-derived from the archived graph-era implementation (fcf history
// eef63df) so .10 numbers stay comparable with docs/axis-experiment.md.
import { describe, it, expect } from 'vitest';
import { recallAtK, precisionAtK, meanOf, recallAnyAtK } from '../../../scripts/benchmark/lib/recall-metrics.js';

describe('recallAtK', () => {
  it('= |topK ∩ expected| / |expected|', () => {
    expect(recallAtK(['a', 'b', 'c', 'd'], new Set(['a', 'c', 'x']), 3)).toBeCloseTo(2 / 3);
  });

  it('counts only the top-K window', () => {
    expect(recallAtK(['z', 'y', 'a'], new Set(['a']), 2)).toBe(0);
    expect(recallAtK(['z', 'y', 'a'], new Set(['a']), 3)).toBe(1);
  });

  it('returns null when expected set is empty (question excluded from averaging)', () => {
    expect(recallAtK(['a', 'b'], new Set(), 5)).toBeNull();
  });

  it('returns 0 for empty ranked list with non-empty expected', () => {
    expect(recallAtK([], new Set(['a']), 5)).toBe(0);
  });
});

describe('precisionAtK', () => {
  it('= |topK ∩ expected| / min(K, |topK|)', () => {
    expect(precisionAtK(['a', 'b', 'c', 'd'], new Set(['a', 'c']), 4)).toBeCloseTo(0.5);
  });

  it('uses ranked length as denominator when shorter than K', () => {
    expect(precisionAtK(['a', 'b'], new Set(['a']), 10)).toBeCloseTo(0.5);
  });

  it('returns 0 for empty ranked list', () => {
    expect(precisionAtK([], new Set(['a']), 5)).toBe(0);
  });

  it('returns 0 when expected is empty', () => {
    expect(precisionAtK(['a', 'b'], new Set(), 5)).toBe(0);
  });
});

describe('meanOf', () => {
  it('averages values and returns 0 for empty input', () => {
    expect(meanOf([0.5, 1])).toBeCloseTo(0.75);
    expect(meanOf([])).toBe(0);
  });
});

// recall_any@K (bead llmems-mdg) — LongMemEval official retrieval metric
// (print_retrieval_metrics.py): binary per-question hit over UNIQUE sessions.
// DIFFERENT metric from fractional recallAtK above — added alongside, no reuse.
describe('recallAnyAtK', () => {
  it('returns 1 when ANY expected session is within top-K, else 0', () => {
    expect(recallAnyAtK(['a', 'b', 'c'], new Set(['c', 'z']), 3)).toBe(1);
    expect(recallAnyAtK(['a', 'b', 'c'], new Set(['z']), 3)).toBe(0);
  });

  it('dedupes ranked ids to unique sessions BEFORE applying K', () => {
    // raw top-3 = [a,a,b] misses c; deduped [a,b,c] hits at rank 3
    expect(recallAnyAtK(['a', 'a', 'b', 'c'], new Set(['c']), 3)).toBe(1);
    // dedup preserves first-occurrence rank order
    expect(recallAnyAtK(['a', 'b', 'a', 'c'], new Set(['c']), 2)).toBe(0);
  });

  it('counts only the top-K window after dedup', () => {
    expect(recallAnyAtK(['a', 'b', 'c'], new Set(['c']), 2)).toBe(0);
  });

  it('returns 0 for an empty ranked list', () => {
    expect(recallAnyAtK([], new Set(['a']), 5)).toBe(0);
  });

  it('throws loudly on an empty expected set (abstention must never reach scoring)', () => {
    expect(() => recallAnyAtK(['a'], new Set(), 5)).toThrowError(/expected/i);
  });
});
