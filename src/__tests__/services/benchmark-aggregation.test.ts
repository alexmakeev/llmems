// src/__tests__/services/benchmark-aggregation.test.ts
// Unit tests for the 3 aggregation pure functions used in the benchmark.
// All inputs are synthetic — no DB or LLM required.

import { describe, it, expect } from 'vitest';
import type { SemanticAxis } from '../../services/graph/types.js';
import {
  aggregateMaxPerAxis,
  aggregateSumAcrossAxes,
  aggregateIntersection,
} from '../../services/graph/benchmark-aggregation.js';
import type { AxisRecallEntry, AggregatedEntry } from '../../services/graph/benchmark-aggregation.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

type AxisMap = Map<SemanticAxis, AxisRecallEntry[]>;

function makeEntry(memId: string, similarity: number): AxisRecallEntry {
  return { memId, similarity };
}

function toMap(entries: [SemanticAxis, AxisRecallEntry[]][]): AxisMap {
  return new Map(entries);
}

// ── aggregateMaxPerAxis ────────────────────────────────────────────────────────

describe('aggregateMaxPerAxis', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateMaxPerAxis(new Map())).toEqual([]);
  });

  it('returns single mem from single axis', () => {
    const input = toMap([['theme', [makeEntry('m1', 0.8)]]]);
    const result = aggregateMaxPerAxis(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ memId: 'm1', score: 0.8, axisCount: 1 });
  });

  it('scores by MAX similarity across axes when mem appears on multiple axes', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.6)]],
      ['emotion', [makeEntry('m1', 0.9)]],
      ['chronos', [makeEntry('m1', 0.4)]],
    ]);
    const result = aggregateMaxPerAxis(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ memId: 'm1', score: 0.9, axisCount: 3 });
  });

  it('ranks by score descending', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.5), makeEntry('m2', 0.9), makeEntry('m3', 0.7)]],
    ]);
    const result = aggregateMaxPerAxis(input);
    expect(result.map(r => r.memId)).toEqual(['m2', 'm3', 'm1']);
  });

  it('handles mem appearing on different axes — uses global max', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.4), makeEntry('m2', 0.95)]],
      ['cause', [makeEntry('m1', 0.85), makeEntry('m3', 0.5)]],
    ]);
    const result = aggregateMaxPerAxis(input);
    const m1 = result.find(r => r.memId === 'm1');
    const m2 = result.find(r => r.memId === 'm2');
    const m3 = result.find(r => r.memId === 'm3');
    expect(m1?.score).toBeCloseTo(0.85);
    expect(m1?.axisCount).toBe(2);
    expect(m2?.score).toBeCloseTo(0.95);
    expect(m2?.axisCount).toBe(1);
    expect(m3?.score).toBeCloseTo(0.5);
    expect(m3?.axisCount).toBe(1);
    // m2 should rank first
    expect(result[0]?.memId).toBe('m2');
  });

  it('axisCount reflects number of distinct axes mem appears on', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.5)]],
      ['emotion', [makeEntry('m1', 0.6)]],
      ['agents', [makeEntry('m1', 0.7)]],
    ]);
    const result = aggregateMaxPerAxis(input);
    expect(result[0]?.axisCount).toBe(3);
  });
});

// ── aggregateSumAcrossAxes ─────────────────────────────────────────────────────

describe('aggregateSumAcrossAxes', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateSumAcrossAxes(new Map())).toEqual([]);
  });

  it('returns single mem from single axis', () => {
    const input = toMap([['theme', [makeEntry('m1', 0.8)]]]);
    const result = aggregateSumAcrossAxes(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ memId: 'm1', score: 0.8, axisCount: 1 });
  });

  it('sums similarities from all axes where mem appears', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.6)]],
      ['emotion', [makeEntry('m1', 0.4)]],
      ['chronos', [makeEntry('m1', 0.5)]],
    ]);
    const result = aggregateSumAcrossAxes(input);
    expect(result[0]).toMatchObject({ memId: 'm1', axisCount: 3 });
    expect(result[0]?.score).toBeCloseTo(1.5);
  });

  it('ranks by sum descending — multi-axis mem can outrank higher-peak single-axis mem', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.5), makeEntry('m2', 0.9)]],
      ['emotion', [makeEntry('m1', 0.7)]],
    ]);
    const result = aggregateSumAcrossAxes(input);
    // m1 sum = 1.2, m2 sum = 0.9 → m1 ranks first
    expect(result[0]?.memId).toBe('m1');
    expect(result[0]?.score).toBeCloseTo(1.2);
    expect(result[1]?.memId).toBe('m2');
    expect(result[1]?.score).toBeCloseTo(0.9);
  });

  it('axisCount reflects distinct axes', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.4)]],
      ['cause', [makeEntry('m1', 0.3)]],
    ]);
    const result = aggregateSumAcrossAxes(input);
    expect(result[0]?.axisCount).toBe(2);
  });
});

// ── aggregateIntersection ─────────────────────────────────────────────────────

describe('aggregateIntersection', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateIntersection(new Map())).toEqual([]);
  });

  it('returns single mem from single axis', () => {
    const input = toMap([['theme', [makeEntry('m1', 0.8)]]]);
    const result = aggregateIntersection(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ memId: 'm1', axisCount: 1 });
  });

  it('primary sort by axisCount descending — multi-axis beats single-axis regardless of similarity', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.95), makeEntry('m2', 0.5)]],
      ['emotion', [makeEntry('m2', 0.6)]],
      ['cause', [makeEntry('m2', 0.7)]],
    ]);
    const result = aggregateIntersection(input);
    // m2 is on 3 axes → ranks first despite lower individual similarity
    expect(result[0]?.memId).toBe('m2');
    expect(result[0]?.axisCount).toBe(3);
    expect(result[1]?.memId).toBe('m1');
    expect(result[1]?.axisCount).toBe(1);
  });

  it('tie-breaks equal axisCount by sum of similarities descending', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.8), makeEntry('m2', 0.5)]],
      ['emotion', [makeEntry('m1', 0.3), makeEntry('m2', 0.7)]],
    ]);
    const result = aggregateIntersection(input);
    // Both m1 and m2 are on 2 axes. m1 sum=1.1, m2 sum=1.2 → m2 ranks first
    expect(result[0]?.memId).toBe('m2');
    expect(result[1]?.memId).toBe('m1');
  });

  it('1-axis mems are included but ranked below multi-axis mems', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.99), makeEntry('m2', 0.4)]],
      ['cause', [makeEntry('m2', 0.4)]],
    ]);
    const result = aggregateIntersection(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.memId).toBe('m2');
    expect(result[1]?.memId).toBe('m1');
  });

  it('score field equals sum of similarities (used for tie-breaking)', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.6)]],
      ['emotion', [makeEntry('m1', 0.5)]],
    ]);
    const result = aggregateIntersection(input);
    expect(result[0]?.score).toBeCloseTo(1.1);
    expect(result[0]?.axisCount).toBe(2);
  });

  it('handles many axes with varying presence', () => {
    const input = toMap([
      ['chronos', [makeEntry('m1', 0.5), makeEntry('m2', 0.6), makeEntry('m3', 0.8)]],
      ['topos', [makeEntry('m1', 0.4), makeEntry('m2', 0.7)]],
      ['agents', [makeEntry('m1', 0.6)]],
      ['theme', [makeEntry('m3', 0.5)]],
    ]);
    const result = aggregateIntersection(input);
    // m1: 3 axes (sum=1.5), m2: 2 axes (sum=1.3), m3: 2 axes (sum=1.3)
    expect(result[0]?.memId).toBe('m1');
    expect(result[0]?.axisCount).toBe(3);
    // m2 and m3 both on 2 axes; m2 sum=1.3, m3 sum=1.3 — order between them is stable-sum-based
    const second = result[1];
    const third = result[2];
    expect([second?.memId, third?.memId].sort()).toEqual(['m2', 'm3']);
  });
});

// ── Type contract ──────────────────────────────────────────────────────────────

describe('AggregatedEntry shape', () => {
  it('all three aggregators return AggregatedEntry array with correct fields', () => {
    const input = toMap([
      ['theme', [makeEntry('m1', 0.7), makeEntry('m2', 0.5)]],
      ['emotion', [makeEntry('m1', 0.4)]],
    ]);

    const checkShape = (entries: AggregatedEntry[]): void => {
      for (const e of entries) {
        expect(typeof e.memId).toBe('string');
        expect(typeof e.score).toBe('number');
        expect(typeof e.axisCount).toBe('number');
        expect(e.axisCount).toBeGreaterThanOrEqual(1);
      }
    };

    checkShape(aggregateMaxPerAxis(input));
    checkShape(aggregateSumAcrossAxes(input));
    checkShape(aggregateIntersection(input));
  });
});
