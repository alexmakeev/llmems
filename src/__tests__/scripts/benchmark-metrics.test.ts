// Tests for scripts/benchmark/lib/recall-metrics.ts (bead llmems-g3a).
// Formulas re-derived from the archived graph-era implementation (fcf history
// eef63df) so .10 numbers stay comparable with docs/axis-experiment.md.
import { describe, it, expect } from 'vitest';
import { recallAtK, precisionAtK, meanOf } from '../../../scripts/benchmark/lib/recall-metrics.js';

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
