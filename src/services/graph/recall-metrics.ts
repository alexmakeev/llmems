// src/services/graph/recall-metrics.ts
// Pure functions for the frozen gold-set recall benchmark.
// No I/O, no side effects — all functions are exported and unit-tested.

// ── Session date extraction ────────────────────────────────────────────────────

const SESSION_DATE_PATTERN = /Session:\s*katya-(\d{4}-\d{2}-\d{2})/g;

/**
 * Extract all distinct session dates from the concatenated content of a mem's chunks.
 *
 * The real session date is embedded in mem_chunks.content as a prefix of the form:
 *   "Session: katya-YYYY-MM-DD"
 *
 * A mem may map to one or more session dates (e.g. a boundary mem spanning two sessions).
 * Returns deduplicated, stable-order list of ISO date strings.
 */
export function extractSessionDates(content: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  SESSION_DATE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SESSION_DATE_PATTERN.exec(content)) !== null) {
    const date = match[1];
    if (date !== undefined && !seen.has(date)) {
      seen.add(date);
      result.push(date);
    }
  }

  return result;
}

// ── Recall and precision metrics ───────────────────────────────────────────────

/**
 * Compute recall@K for a single question.
 *
 * recall@K = |topK ∩ expected| / |expected|
 *
 * Returns null when |expected| = 0 — the question is EXCLUDED from recall averaging
 * and must be counted separately. Never returns 0.0 for the empty-expected case,
 * since dividing by zero is undefined and treating it as 0 would bias the metric.
 *
 * @param rankedMemIds - Full ranked list of memIds (descending relevance).
 * @param expectedMemIds - Gold set of expected memIds for this question.
 * @param K - Window size.
 * @returns recall in [0, 1] or null if expectedMemIds is empty.
 */
export function recallAtK(
  rankedMemIds: string[],
  expectedMemIds: Set<string>,
  K: number,
): number | null {
  if (expectedMemIds.size === 0) return null;

  const topK = rankedMemIds.slice(0, K);
  const hits = topK.filter(id => expectedMemIds.has(id)).length;
  return hits / expectedMemIds.size;
}

/**
 * Compute precision@K for a single question.
 *
 * precision@K = |topK ∩ expected| / min(K, |topK|)
 *
 * Returns 0.0 when the ranked list is empty (nothing to evaluate).
 * Returns 0.0 when expectedMemIds is empty (no expected mems → no hits possible).
 *
 * @param rankedMemIds - Full ranked list of memIds (descending relevance).
 * @param expectedMemIds - Gold set of expected memIds for this question.
 * @param K - Window size.
 * @returns precision in [0, 1].
 */
export function precisionAtK(
  rankedMemIds: string[],
  expectedMemIds: Set<string>,
  K: number,
): number {
  const topK = rankedMemIds.slice(0, K);
  const denominator = Math.min(K, topK.length);
  if (denominator === 0) return 0;

  const hits = topK.filter(id => expectedMemIds.has(id)).length;
  return hits / denominator;
}

// ── Judge response parser ──────────────────────────────────────────────────────

/** Structured output the LLM judge returns for each mem evaluation. */
export interface JudgeResponse {
  evaluations: Array<{
    factIndex: number;
    covered: boolean;
  }>;
}

/** Parsed judge result for a single mem. */
export interface ParsedJudgeResult {
  /** Set of factIndex values (0-based) that the mem semantically covers. */
  coveredFactIndices: Set<number>;
}

/**
 * Parse the LLM judge's JSON response into a structured result.
 *
 * Handles:
 * - Plain JSON
 * - JSON wrapped in markdown code fences (```json ... ```)
 * - Out-of-range factIndex values (silently ignored)
 * - Missing or malformed evaluations field
 *
 * Returns null on any parse failure so the caller can retry.
 *
 * @param raw - Raw string response from the LLM.
 * @param factCount - Total number of expected_facts (for range validation).
 * @returns Parsed result or null on failure.
 */
export function parseJudgeResponse(
  raw: string,
  factCount: number,
): ParsedJudgeResult | null {
  // Strip markdown code fences if present
  const stripped = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('evaluations' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>)['evaluations'])
  ) {
    return null;
  }

  const evaluations = (parsed as Record<string, unknown>)['evaluations'] as unknown[];
  const coveredFactIndices = new Set<number>();

  for (const entry of evaluations) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('factIndex' in entry) ||
      !('covered' in entry)
    ) {
      continue;
    }

    const e = entry as Record<string, unknown>;
    const factIndex = e['factIndex'];
    const covered = e['covered'];

    if (
      typeof factIndex !== 'number' ||
      !Number.isInteger(factIndex) ||
      factIndex < 0 ||
      factIndex >= factCount
    ) {
      continue;
    }

    if (covered === true) {
      coveredFactIndices.add(factIndex);
    }
  }

  return { coveredFactIndices };
}
