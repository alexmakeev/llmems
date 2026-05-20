// src/__tests__/services/recall-metrics.test.ts
// Unit tests for date extraction, recall metrics, and judge response parser.
// All offline — no DB, no LLM.

import { describe, it, expect } from 'vitest';
import {
  extractSessionDates,
  recallAtK,
  precisionAtK,
  parseJudgeResponse,
} from '../../services/graph/recall-metrics.js';
import type { JudgeResponse } from '../../services/graph/recall-metrics.js';

// ── extractSessionDates ────────────────────────────────────────────────────────

describe('extractSessionDates', () => {
  it('returns empty array for empty content', () => {
    expect(extractSessionDates('')).toEqual([]);
  });

  it('returns empty array when no Session marker present', () => {
    const content = 'Some conversation without any session marker.';
    expect(extractSessionDates(content)).toEqual([]);
  });

  it('extracts a single session date', () => {
    const content = 'Session: katya-2025-09-11\nSome content here.';
    expect(extractSessionDates(content)).toEqual(['2025-09-11']);
  });

  it('extracts multiple distinct session dates', () => {
    const content = [
      'Session: katya-2025-09-11',
      'Some content.',
      'Session: katya-2025-09-12',
      'More content.',
    ].join('\n');
    const result = extractSessionDates(content);
    expect(result.sort()).toEqual(['2025-09-11', '2025-09-12'].sort());
  });

  it('deduplicates repeated session dates', () => {
    const content = [
      'Session: katya-2025-09-11',
      'Session: katya-2025-09-11',
      'Content.',
    ].join('\n');
    expect(extractSessionDates(content)).toEqual(['2025-09-11']);
  });

  it('handles whitespace around the date prefix', () => {
    const content = 'Session:  katya-2025-10-05\nContent.';
    expect(extractSessionDates(content)).toEqual(['2025-10-05']);
  });

  it('does not extract dates without the katya- prefix', () => {
    const content = 'Session: 2025-09-11\nContent.';
    expect(extractSessionDates(content)).toEqual([]);
  });

  it('handles content with no newlines', () => {
    const content = 'Session: katya-2025-01-15 Some inline content.';
    expect(extractSessionDates(content)).toEqual(['2025-01-15']);
  });
});

// ── recallAtK ─────────────────────────────────────────────────────────────────

describe('recallAtK', () => {
  it('returns null when expectedMemIds is empty (excluded question)', () => {
    const result = recallAtK(['m1', 'm2'], new Set<string>(), 5);
    expect(result).toBeNull();
  });

  it('returns 1.0 when all expected mems appear in top K', () => {
    const expected = new Set(['m1', 'm2']);
    const ranked = ['m1', 'm2', 'm3'];
    expect(recallAtK(ranked, expected, 5)).toBeCloseTo(1.0);
  });

  it('returns 0.0 when no expected mems appear in top K', () => {
    const expected = new Set(['m5', 'm6']);
    const ranked = ['m1', 'm2', 'm3'];
    expect(recallAtK(ranked, expected, 5)).toBeCloseTo(0.0);
  });

  it('returns partial recall correctly', () => {
    const expected = new Set(['m1', 'm2', 'm3', 'm4']);
    const ranked = ['m1', 'm2', 'm5', 'm6'];
    // top 5 = all 4 items, 2 of 4 expected found → recall = 0.5
    expect(recallAtK(ranked, expected, 5)).toBeCloseTo(0.5);
  });

  it('only counts up to K items from ranked list', () => {
    const expected = new Set(['m1', 'm4']);
    const ranked = ['m1', 'm2', 'm3', 'm4', 'm5'];
    // top 3 = [m1, m2, m3], only m1 found → recall = 0.5
    expect(recallAtK(ranked, expected, 3)).toBeCloseTo(0.5);
  });

  it('handles K larger than ranked list length', () => {
    const expected = new Set(['m1', 'm2']);
    const ranked = ['m1'];
    // top K=10 but only 1 item in list; m1 found, m2 not → recall = 0.5
    expect(recallAtK(ranked, expected, 10)).toBeCloseTo(0.5);
  });

  it('handles empty ranked list', () => {
    const expected = new Set(['m1', 'm2']);
    expect(recallAtK([], expected, 5)).toBeCloseTo(0.0);
  });

  it('returns 1.0 for single expected mem found at position K', () => {
    const expected = new Set(['m5']);
    const ranked = ['m1', 'm2', 'm3', 'm4', 'm5'];
    expect(recallAtK(ranked, expected, 5)).toBeCloseTo(1.0);
  });

  it('excludes item at position K+1 from top-K window', () => {
    const expected = new Set(['m6']);
    const ranked = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    // K=5, m6 is at position 6 (index 5) → not in top 5 → recall = 0
    expect(recallAtK(ranked, expected, 5)).toBeCloseTo(0.0);
  });
});

// ── precisionAtK ──────────────────────────────────────────────────────────────

describe('precisionAtK', () => {
  it('returns 1.0 when all top-K items are expected', () => {
    const expected = new Set(['m1', 'm2', 'm3']);
    const ranked = ['m1', 'm2', 'm3'];
    expect(precisionAtK(ranked, expected, 5)).toBeCloseTo(1.0);
  });

  it('returns 0.0 when no top-K items are expected', () => {
    const expected = new Set(['m5', 'm6']);
    const ranked = ['m1', 'm2', 'm3'];
    expect(precisionAtK(ranked, expected, 5)).toBeCloseTo(0.0);
  });

  it('returns correct partial precision', () => {
    const expected = new Set(['m1', 'm3']);
    const ranked = ['m1', 'm2', 'm3', 'm4', 'm5'];
    // top 5 = 5 items, 2 expected found → precision = 2/5
    expect(precisionAtK(ranked, expected, 5)).toBeCloseTo(0.4);
  });

  it('denominates by min(K, |topK|) — uses ranked list length when smaller', () => {
    const expected = new Set(['m1', 'm2']);
    const ranked = ['m1', 'm2'];
    // K=10, but only 2 items → denominator = min(10, 2) = 2 → precision = 1.0
    expect(precisionAtK(ranked, expected, 10)).toBeCloseTo(1.0);
  });

  it('handles empty expected set — returns 0.0', () => {
    const ranked = ['m1', 'm2'];
    expect(precisionAtK(ranked, new Set<string>(), 5)).toBeCloseTo(0.0);
  });

  it('handles empty ranked list — returns 0.0', () => {
    const expected = new Set(['m1']);
    expect(precisionAtK([], expected, 5)).toBeCloseTo(0.0);
  });

  it('uses exactly K items as denominator when ranked list >= K', () => {
    const expected = new Set(['m1']);
    const ranked = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    // K=5, top 5 = [m1..m5], 1 of 5 found → precision = 0.2
    expect(precisionAtK(ranked, expected, 5)).toBeCloseTo(0.2);
  });
});

// ── parseJudgeResponse ─────────────────────────────────────────────────────────

describe('parseJudgeResponse', () => {
  const sampleFacts = ['Катя посетила кафе', 'Встреча была в понедельник', 'Они обсуждали книги'];

  it('parses valid JSON with all facts covered', () => {
    const raw: JudgeResponse = {
      evaluations: [
        { factIndex: 0, covered: true },
        { factIndex: 1, covered: true },
        { factIndex: 2, covered: true },
      ],
    };
    const result = parseJudgeResponse(JSON.stringify(raw), sampleFacts.length);
    expect(result).not.toBeNull();
    expect(result?.coveredFactIndices).toEqual(new Set([0, 1, 2]));
  });

  it('parses valid JSON with some facts covered', () => {
    const raw: JudgeResponse = {
      evaluations: [
        { factIndex: 0, covered: true },
        { factIndex: 1, covered: false },
        { factIndex: 2, covered: true },
      ],
    };
    const result = parseJudgeResponse(JSON.stringify(raw), sampleFacts.length);
    expect(result).not.toBeNull();
    expect(result?.coveredFactIndices).toEqual(new Set([0, 2]));
  });

  it('parses valid JSON with no facts covered', () => {
    const raw: JudgeResponse = {
      evaluations: [
        { factIndex: 0, covered: false },
        { factIndex: 1, covered: false },
      ],
    };
    const result = parseJudgeResponse(JSON.stringify(raw), sampleFacts.length);
    expect(result).not.toBeNull();
    expect(result?.coveredFactIndices).toEqual(new Set());
  });

  it('returns null for invalid JSON', () => {
    expect(parseJudgeResponse('not json at all', sampleFacts.length)).toBeNull();
  });

  it('returns null when evaluations field is missing', () => {
    const raw = JSON.stringify({ something: 'else' });
    expect(parseJudgeResponse(raw, sampleFacts.length)).toBeNull();
  });

  it('returns null when evaluations is not an array', () => {
    const raw = JSON.stringify({ evaluations: 'invalid' });
    expect(parseJudgeResponse(raw, sampleFacts.length)).toBeNull();
  });

  it('ignores entries with out-of-range factIndex', () => {
    const raw: JudgeResponse = {
      evaluations: [
        { factIndex: 0, covered: true },
        { factIndex: 99, covered: true },  // out of range for 3 facts
        { factIndex: -1, covered: true },  // negative
      ],
    };
    const result = parseJudgeResponse(JSON.stringify(raw), sampleFacts.length);
    expect(result).not.toBeNull();
    // Only factIndex 0 is valid
    expect(result?.coveredFactIndices).toEqual(new Set([0]));
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const inner: JudgeResponse = {
      evaluations: [{ factIndex: 0, covered: true }],
    };
    const fenced = '```json\n' + JSON.stringify(inner) + '\n```';
    const result = parseJudgeResponse(fenced, sampleFacts.length);
    expect(result).not.toBeNull();
    expect(result?.coveredFactIndices).toEqual(new Set([0]));
  });

  it('handles empty evaluations array', () => {
    const raw = JSON.stringify({ evaluations: [] });
    const result = parseJudgeResponse(raw, sampleFacts.length);
    expect(result).not.toBeNull();
    expect(result?.coveredFactIndices).toEqual(new Set());
  });
});
