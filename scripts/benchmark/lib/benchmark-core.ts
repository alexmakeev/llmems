// scripts/benchmark/lib/benchmark-core.ts — pure benchmark orchestration (bead llmems-g3a).
//
// vectorRecall arm ONLY, for the CURRENT v0.4.0 library. embed/search are
// injected ports so the whole core is offline-testable. Fail-fast: any embed or
// search error aborts the run loudly — no silent partial aggregates (cheap
// retries are what QUESTION_LIMIT is for).

import { recallAtK, precisionAtK, meanOf } from './recall-metrics.js';

/** Archived A-arm baseline (docs/axis-experiment.md, katya-year, gold-set-4). */
export const ARCHIVED_BASELINE = {
  recallAt5: 0.524,
  recallAt10: 0.668,
  source: 'docs/axis-experiment.md (vectorRecall, katya-year, 100 questions)',
} as const;

export interface GoldQuestion {
  expectedMemIds: string[];
}

export interface GoldSet {
  memstoreId: number;
  generatedAt: string;
  judgeModel: string;
  questions: Record<string, GoldQuestion>;
}

/** Parse + validate gold-set JSON; verify it belongs to the expected memstore. */
export function loadGoldSet(content: string, expectedMemstoreId: number): GoldSet {
  const parsed: unknown = JSON.parse(content);
  const goldSet = parsed as Partial<GoldSet>;
  if (goldSet.questions === undefined || typeof goldSet.questions !== 'object') {
    throw new Error('Gold set invalid: missing "questions" object');
  }
  if (goldSet.memstoreId !== expectedMemstoreId) {
    throw new Error(
      `Gold set memstoreId mismatch: file says ${String(goldSet.memstoreId)}, ` +
        `MEMSTORE_ID is ${expectedMemstoreId} — wrong gold set for this corpus.`,
    );
  }
  for (const [question, gold] of Object.entries(goldSet.questions)) {
    if (!Array.isArray((gold as GoldQuestion).expectedMemIds)) {
      throw new Error(`Gold set invalid: question "${question.slice(0, 60)}" lacks expectedMemIds[]`);
    }
  }
  return goldSet as GoldSet;
}

/** Embedding port: question text → opaque embedded query (passed to search). */
export type EmbedFn<V> = (question: string) => Promise<V>;
/** Search port: embedded query → ranked mems (descending relevance). */
export type SearchFn<V> = (embedded: V) => Promise<{ id: string; summary?: string }[]>;

export interface QuestionResult {
  question: string;
  expectedCount: number;
  retrievedIds: string[];
  /** null = excluded from recall averaging (empty gold). */
  recallAt5: number | null;
  recallAt10: number | null;
  precisionAt5: number;
  precisionAt10: number;
}

export interface BenchmarkResult {
  aggregate: {
    evaluated: number;
    excludedZeroExpected: number;
    recallAt5: number;
    recallAt10: number;
    precisionAt5: number;
    precisionAt10: number;
  };
  archivedBaseline: typeof ARCHIVED_BASELINE;
  deviation: { recallAt5: number; recallAt10: number };
  perQuestion: QuestionResult[];
}

export interface RunBenchmarkOptions<V> {
  goldSet: GoldSet;
  embed: EmbedFn<V>;
  search: SearchFn<V>;
  /** K windows; recall/precision computed for 5 and 10 (kValues must cover max K used). */
  kValues: number[];
  /** Optional cap on questions processed (cheap-subset-first). Unset = all. */
  questionLimit?: number;
}

export async function runBenchmark<V>(opts: RunBenchmarkOptions<V>): Promise<BenchmarkResult> {
  if (opts.questionLimit !== undefined && (!Number.isInteger(opts.questionLimit) || opts.questionLimit < 1)) {
    throw new Error(
      `questionLimit must be a positive integer, got ${opts.questionLimit} — ` +
        'a zero/negative cap would produce empty or silently truncated aggregates.',
    );
  }
  const entries = Object.entries(opts.goldSet.questions);
  const limited =
    opts.questionLimit !== undefined ? entries.slice(0, opts.questionLimit) : entries;

  const perQuestion: QuestionResult[] = [];
  for (const [question, gold] of limited) {
    // Fail-fast by design: embed/search errors propagate and abort the run.
    const embedded = await opts.embed(question);
    const ranked = await opts.search(embedded);
    const rankedIds = ranked.map((m) => m.id);
    const expected = new Set(gold.expectedMemIds);

    perQuestion.push({
      question,
      expectedCount: expected.size,
      retrievedIds: rankedIds,
      recallAt5: recallAtK(rankedIds, expected, 5),
      recallAt10: recallAtK(rankedIds, expected, 10),
      precisionAt5: precisionAtK(rankedIds, expected, 5),
      precisionAt10: precisionAtK(rankedIds, expected, 10),
    });
  }

  const evaluatedQuestions = perQuestion.filter((q) => q.recallAt5 !== null);
  const aggregate = {
    evaluated: evaluatedQuestions.length,
    excludedZeroExpected: perQuestion.length - evaluatedQuestions.length,
    recallAt5: meanOf(evaluatedQuestions.map((q) => q.recallAt5 as number)),
    recallAt10: meanOf(evaluatedQuestions.map((q) => q.recallAt10 as number)),
    precisionAt5: meanOf(evaluatedQuestions.map((q) => q.precisionAt5)),
    precisionAt10: meanOf(evaluatedQuestions.map((q) => q.precisionAt10)),
  };

  return {
    aggregate,
    archivedBaseline: ARCHIVED_BASELINE,
    deviation: {
      recallAt5: aggregate.recallAt5 - ARCHIVED_BASELINE.recallAt5,
      recallAt10: aggregate.recallAt10 - ARCHIVED_BASELINE.recallAt10,
    },
    perQuestion,
  };
}
