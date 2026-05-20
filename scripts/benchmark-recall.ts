// scripts/benchmark-recall.ts
// Comprehensive benchmark that runs all 100 test questions against the recall system.
// Collects per-axis, per-category statistics for A/B testing different graph configurations.
//
// Usage:
//   npx tsx scripts/benchmark-recall.ts
//
// Configurable via env vars:
//   GRAPH_NEIGHBORS  (default 10)   — override MAX_GRAPH_NEIGHBORS
//   TEST_NAME        (default "baseline") — label for this run
//
// Requires:
//   sandboxes/gold-set-{MEMSTORE_ID}.json — frozen gold set (generate with generate-gold-set.ts)
//
// Output:
//   sandboxes/benchmark-{TEST_NAME}.json — full raw results with recall@K / precision@K metrics
//   console — per-strategy recall summary

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import pgvector from 'pgvector/pg';

import { PostgresMemStore } from '../src/services/postgres-mem-store.js';
import { GraphStore } from '../src/services/graph/graph-store.js';
import { GraphRecall } from '../src/services/graph/graph-recall.js';
import { ProjectionExtractor } from '../src/services/graph/projection-extractor.js';
import { SEMANTIC_AXES } from '../src/services/graph/types.js';
import type { SemanticAxis } from '../src/services/graph/types.js';
import type { RecallResult } from '../src/types.js';
import { requireEnvInt } from '../src/shared/env.js';
import {
  aggregateMaxPerAxis,
  aggregateSumAcrossAxes,
  aggregateIntersection,
} from '../src/services/graph/benchmark-aggregation.js';
import type { AggregatedEntry, PerAxisResults } from '../src/services/graph/benchmark-aggregation.js';
import { recallAtK, precisionAtK } from '../src/services/graph/recall-metrics.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const POSTGRES_URL = process.env['POSTGRES_URL'] ??
  'postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems_axis_projections';
const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'] ?? '';
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'] ?? '';

if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY is required');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is required (used for query projection embeddings)');
  process.exit(1);
}

const GRAPH_NEIGHBORS = parseInt(process.env['GRAPH_NEIGHBORS'] ?? '10', 10);
const TEST_NAME = process.env['TEST_NAME'] ?? 'baseline';

const MEMSTORE_ID = requireEnvInt('MEMSTORE_ID');
const CONTEXT_ID = 'benchmark-katya-year';

const QUESTIONS_FILE = '/home/alexmak/llmems-old/main/sandboxes/recall-test-questions.json';
const RESULTS_FILE = `/home/alexmak/llmems/main/sandboxes/benchmark-${TEST_NAME}.json`;
const GOLD_SET_FILE = `/home/alexmak/llmems/main/sandboxes/gold-set-${MEMSTORE_ID}.json`;

// Fail fast if gold set is missing — do NOT silently fall back to similarity-based hits
if (!existsSync(GOLD_SET_FILE)) {
  throw new Error(
    `Gold set file not found: ${GOLD_SET_FILE}\n` +
    `Generate it first with: MEMSTORE_ID=${MEMSTORE_ID} OPENROUTER_API_KEY=... npx tsx scripts/generate-gold-set.ts`,
  );
}

const PROJECTION_THRESHOLD = 0.3;   // min similarity to even return from DB
const PROJECTION_LIMIT = 5;         // top-N per axis
const VECTOR_RECALL_LIMIT = 10;

/** Delay between OpenRouter embedding calls to avoid rate limits */
const API_DELAY_MS = 100;

// ── Types ──────────────────────────────────────────────────────────────────────

interface TestQuestion {
  id: string;
  category: string;
  question: string;
  difficulty: string;
  expected_facts: string[];
  source_sessions: string[];
}

interface AxisMatch {
  memId: string;
  summary: string;
  projectionText: string;
  similarity: number;
}

interface QuestionAxisResult {
  axis: SemanticAxis;
  matches: AxisMatch[];
}

/** Per-strategy recall@K and precision@K metrics for one question. */
interface QuestionMetrics {
  /** null = excluded (expectedMemIds was empty for this question) */
  recallAt5: number | null;
  recallAt10: number | null;
  precisionAt5: number;
  precisionAt10: number;
}

interface QuestionResult {
  questionId: string;
  category: string;
  difficulty: string;
  question: string;
  vectorRecallCount: number;
  vectorRecallNodes: Array<{ id: string; summary: string; similarity: number }>;
  axisResults: QuestionAxisResult[];
  graphEnrichedCount: number;
  graphAddedCount: number;
  /** Per-axis true projection recall: each axis searched with its own query-axis embedding. */
  projectionMaxPerAxis: AggregatedEntry[];
  projectionSumAcrossAxes: AggregatedEntry[];
  projectionIntersection: AggregatedEntry[];
  /** Per-strategy recall@K / precision@K metrics vs gold set. */
  metrics: {
    vectorRecall: QuestionMetrics;
    graphEnrichedRecall: QuestionMetrics;
    projectionMaxPerAxis: QuestionMetrics;
    projectionSumAcrossAxes: QuestionMetrics;
    projectionIntersection: QuestionMetrics;
  };
  /** Number of expected mems in gold set for this question (0 = excluded from recall avg). */
  goldExpectedCount: number;
  error?: string;
}

/** Gold set file format */
interface GoldSetFile {
  memstoreId: number;
  generatedAt: string;
  judgeModel: string;
  questions: Record<string, {
    sourceSessions: string[];
    candidateMemIds: string[];
    expectedMemIds: string[];
    factCoverage: Record<string, string[]>;
  }>;
  stats: {
    questionsWithZeroExpected: number;
    meanExpected: number;
    medianExpected: number;
    maxExpected: number;
  };
}

interface SimilarityBuckets {
  '0.3-0.4': number;
  '0.4-0.5': number;
  '0.5-0.6': number;
  '0.6-0.7': number;
  '0.7-0.8': number;
  '0.8+': number;
}

interface TopMatch {
  questionId: string;
  question: string;
  projectionText: string;
  memSummary: string;
  similarity: number;
}

interface AxisStats {
  axis: SemanticAxis;
  totalProjectionsInDB: number;
  avgSimilarity: number;
  top3Matches: TopMatch[];
  similarityDistribution: SimilarityBuckets;
}

/** Aggregate recall@K and precision@K for one strategy across all questions. */
interface StrategyAggregate {
  strategy: string;
  /** Mean recall@5 across questions with non-empty expectedMemIds (excluded count in excludedQuestions). */
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanPrecisionAt5: number;
  meanPrecisionAt10: number;
  /** Number of questions excluded from recall averaging (expectedMemIds was empty). */
  excludedQuestions: number;
}

interface CategoryStats {
  category: string;
  questionCount: number;
  successCount: number;
  avgVectorRecallCount: number;
  avgGraphEnrichedCount: number;
  avgGraphAddedCount: number;
  /** Axis with highest avg similarity for this category */
  bestAxis: SemanticAxis | null;
}

interface BenchmarkOutput {
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
  /** Per-strategy aggregate recall@K / precision@K across all non-excluded questions. */
  strategyAggregates: StrategyAggregate[];
  axisStats: AxisStats[];
  categoryStats: CategoryStats[];
  questionResults: QuestionResult[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bucketSimilarity(sim: number): keyof SimilarityBuckets {
  if (sim >= 0.8) return '0.8+';
  if (sim >= 0.7) return '0.7-0.8';
  if (sim >= 0.6) return '0.6-0.7';
  if (sim >= 0.5) return '0.5-0.6';
  if (sim >= 0.4) return '0.4-0.5';
  return '0.3-0.4';
}

function emptyBuckets(): SimilarityBuckets {
  return {
    '0.3-0.4': 0,
    '0.4-0.5': 0,
    '0.5-0.6': 0,
    '0.6-0.7': 0,
    '0.7-0.8': 0,
    '0.8+': 0,
  };
}

// ── Recall helpers ─────────────────────────────────────────────────────────────

async function runVectorRecall(
  memStore: PostgresMemStore,
  queryEmbedding: number[],
): Promise<RecallResult> {
  const result = await memStore.vectorRecall(MEMSTORE_ID, queryEmbedding, VECTOR_RECALL_LIMIT);
  if (!result.ok) {
    console.warn(`  vectorRecall failed: ${result.error.message}`);
    return { nodes: [], edges: [] };
  }
  return result.value;
}

async function runAxisRecall(
  pool: Pool,
  queryEmbedding: number[],
  axis: SemanticAxis,
): Promise<AxisMatch[]> {
  const embeddingSql = pgvector.toSql(queryEmbedding);
  try {
    const result = await pool.query<{
      mem_id: number;
      projection_text: string;
      summary: string;
      similarity: number;
    }>(
      `SELECT mp.mem_id, mp.text AS projection_text, m.summary,
              1 - (mp.embedding <=> $1::vector) AS similarity
       FROM mem_projections mp
       JOIN mems m ON m.id = mp.mem_id
       WHERE mp.memstore_id = $2
         AND mp.axis = $3
         AND 1 - (mp.embedding <=> $1::vector) >= $4
       ORDER BY similarity DESC
       LIMIT $5`,
      [embeddingSql, MEMSTORE_ID, axis, PROJECTION_THRESHOLD, PROJECTION_LIMIT],
    );
    return result.rows.map(row => ({
      memId: String(row.mem_id),
      summary: row.summary,
      projectionText: row.projection_text,
      similarity: row.similarity,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`  axisRecall(${axis}) failed: ${message}`);
    return [];
  }
}

/**
 * Run per-axis projection recall for a query using true per-axis query projections.
 *
 * 1. Decomposes the query into per-axis projections (each with its own embedding).
 * 2. For each axis present in the query projections, runs a pgvector cosine search
 *    against mem_projections using THAT axis's query embedding.
 * 3. Returns a PerAxisResults map (axis → ranked AxisRecallEntry list).
 *
 * If queryToProjections fails, returns an empty map (not a hard error — benchmark continues).
 */
async function runTrueProjectionRecall(
  pool: Pool,
  projectionExtractor: ProjectionExtractor,
  query: string,
): Promise<PerAxisResults> {
  const queryProjResult = await projectionExtractor.queryToProjections(query);
  if (!queryProjResult.ok) {
    console.warn(`  queryToProjections failed: ${queryProjResult.error.message}`);
    return new Map();
  }

  const perAxisResults: PerAxisResults = new Map();

  for (const queryProj of queryProjResult.value) {
    if (queryProj.embedding === undefined) continue;

    const matches = await runAxisRecall(pool, queryProj.embedding, queryProj.axis);
    // Convert AxisMatch to AxisRecallEntry (drop summary/projectionText — not needed for aggregation)
    perAxisResults.set(queryProj.axis, matches.map(m => ({
      memId: m.memId,
      similarity: m.similarity,
    })));
  }

  return perAxisResults;
}

// ── Top-K constant for aggregated projection results ──────────────────────────

const PROJECTION_AGGREGATION_TOP_K = GRAPH_NEIGHBORS;

// ── Main benchmark loop ────────────────────────────────────────────────────────

/** Null metric stub for error cases (question failed to embed/run). */
function nullMetrics(): QuestionMetrics {
  return { recallAt5: null, recallAt10: null, precisionAt5: 0, precisionAt10: 0 };
}

async function runBenchmark(
  pool: Pool,
  memStore: PostgresMemStore,
  graphRecall: GraphRecall,
  openai: OpenAI,
  projectionExtractor: ProjectionExtractor,
  questions: TestQuestion[],
  goldSet: GoldSetFile['questions'],
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (question === undefined) continue;

    const progress = `[${String(i + 1).padStart(3)}/${questions.length}]`;
    process.stdout.write(`${progress} ${question.id} (${question.category}/${question.difficulty}): ${question.question.slice(0, 50)}...\n`);

    const emptyMetrics = {
      vectorRecall: nullMetrics(),
      graphEnrichedRecall: nullMetrics(),
      projectionMaxPerAxis: nullMetrics(),
      projectionSumAcrossAxes: nullMetrics(),
      projectionIntersection: nullMetrics(),
    };

    // ── Embed question ──────────────────────────────────────────────────────
    let questionEmbedding: number[];
    try {
      const embedResponse = await openai.embeddings.create({
        model: 'openai/text-embedding-3-small',
        input: question.question,
        dimensions: 1536,
      });
      const embData = embedResponse.data[0];
      if (embData === undefined) {
        console.warn(`  Skipping: empty embedding response`);
        results.push({
          questionId: question.id,
          category: question.category,
          difficulty: question.difficulty,
          question: question.question,
          vectorRecallCount: 0,
          vectorRecallNodes: [],
          axisResults: [],
          graphEnrichedCount: 0,
          graphAddedCount: 0,
          projectionMaxPerAxis: [],
          projectionSumAcrossAxes: [],
          projectionIntersection: [],
          metrics: emptyMetrics,
          goldExpectedCount: 0,
          error: 'empty embedding response',
        });
        continue;
      }
      questionEmbedding = embData.embedding;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`  Error embedding: ${message}`);
      results.push({
        questionId: question.id,
        category: question.category,
        difficulty: question.difficulty,
        question: question.question,
        vectorRecallCount: 0,
        vectorRecallNodes: [],
        axisResults: [],
        graphEnrichedCount: 0,
        graphAddedCount: 0,
        projectionMaxPerAxis: [],
        projectionSumAcrossAxes: [],
        projectionIntersection: [],
        metrics: emptyMetrics,
        goldExpectedCount: 0,
        error: message,
      });
      if (i + 1 < questions.length) await sleep(API_DELAY_MS);
      continue;
    }

    // Rate limit delay
    if (i + 1 < questions.length) {
      await sleep(API_DELAY_MS);
    }

    // ── Vector recall ───────────────────────────────────────────────────────
    const vectorResult = await runVectorRecall(memStore, questionEmbedding);
    const vectorNodes = vectorResult.nodes.map(n => ({
      id: n.id,
      summary: n.text,
      similarity: n.similarity ?? 0,
    }));

    // ── Graph enrichment ────────────────────────────────────────────────────
    let graphEnrichedCount = vectorNodes.length;
    let graphAddedCount = 0;
    let graphEnrichedNodeIds: string[] = vectorNodes.map(n => n.id);

    try {
      const enrichedResult = await graphRecall.enrichRecall(vectorResult, CONTEXT_ID);
      if (enrichedResult.ok) {
        const enrichedNodes = enrichedResult.value.nodes;
        graphEnrichedCount = enrichedNodes.length;
        graphAddedCount = graphEnrichedCount - vectorNodes.length;
        graphEnrichedNodeIds = enrichedNodes.map(n => n.id);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`  graphRecall failed: ${message}`);
    }

    // ── Per-axis projection recall ──────────────────────────────────────────
    const axisResults: QuestionAxisResult[] = [];
    for (const axis of SEMANTIC_AXES) {
      const matches = await runAxisRecall(pool, questionEmbedding, axis);
      axisResults.push({ axis, matches });
    }

    const totalAxisMatches = axisResults.reduce((sum, ar) => sum + ar.matches.length, 0);

    // ── True per-axis projection recall + 3 aggregation strategies ─────────────
    const perAxisResults = await runTrueProjectionRecall(
      pool,
      projectionExtractor,
      question.question,
    );

    const projectionMaxPerAxis = aggregateMaxPerAxis(perAxisResults).slice(0, PROJECTION_AGGREGATION_TOP_K);
    const projectionSumAcrossAxes = aggregateSumAcrossAxes(perAxisResults).slice(0, PROJECTION_AGGREGATION_TOP_K);
    const projectionIntersection = aggregateIntersection(perAxisResults).slice(0, PROJECTION_AGGREGATION_TOP_K);

    // ── Compute recall@K and precision@K vs gold set ────────────────────────
    const goldEntry = goldSet[question.id];
    const expectedMemIds = new Set(goldEntry?.expectedMemIds ?? []);
    const goldExpectedCount = expectedMemIds.size;

    const computeMetrics = (ranked: string[]): QuestionMetrics => ({
      recallAt5: recallAtK(ranked, expectedMemIds, 5),
      recallAt10: recallAtK(ranked, expectedMemIds, 10),
      precisionAt5: precisionAtK(ranked, expectedMemIds, 5),
      precisionAt10: precisionAtK(ranked, expectedMemIds, 10),
    });

    const metrics = {
      vectorRecall: computeMetrics(vectorNodes.map(n => n.id)),
      graphEnrichedRecall: computeMetrics(graphEnrichedNodeIds),
      projectionMaxPerAxis: computeMetrics(projectionMaxPerAxis.map(e => e.memId)),
      projectionSumAcrossAxes: computeMetrics(projectionSumAcrossAxes.map(e => e.memId)),
      projectionIntersection: computeMetrics(projectionIntersection.map(e => e.memId)),
    };

    console.log(
      `  vec:${vectorNodes.length} graph+:${graphAddedCount}` +
      ` axisMatches:${totalAxisMatches}` +
      ` projAxes:${perAxisResults.size}` +
      ` projTop:${projectionMaxPerAxis.length}/${projectionSumAcrossAxes.length}/${projectionIntersection.length}` +
      ` gold:${goldExpectedCount} recall@10:${metrics.vectorRecall.recallAt10?.toFixed(2) ?? 'excl'}`,
    );

    results.push({
      questionId: question.id,
      category: question.category,
      difficulty: question.difficulty,
      question: question.question,
      vectorRecallCount: vectorNodes.length,
      vectorRecallNodes: vectorNodes,
      axisResults,
      graphEnrichedCount,
      graphAddedCount,
      projectionMaxPerAxis,
      projectionSumAcrossAxes,
      projectionIntersection,
      metrics,
      goldExpectedCount,
    });
  }

  return results;
}

// ── Statistics aggregation ─────────────────────────────────────────────────────

/**
 * Compute mean of an array of non-null numbers.
 * Returns 0 for empty input.
 */
function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Build StrategyAggregate for one strategy key across all succeeded question results.
 * Questions where expectedMemIds was empty (recall = null) are excluded from recall averaging
 * and counted in excludedQuestions.
 */
function buildStrategyAggregate(
  strategy: string,
  key: keyof QuestionResult['metrics'],
  succeeded: QuestionResult[],
): StrategyAggregate {
  const recallAt5Values: number[] = [];
  const recallAt10Values: number[] = [];
  const precisionAt5Values: number[] = [];
  const precisionAt10Values: number[] = [];
  let excludedQuestions = 0;

  for (const qr of succeeded) {
    const m = qr.metrics[key];
    if (m.recallAt5 === null) {
      // Excluded question: expectedMemIds was empty
      excludedQuestions++;
    } else {
      recallAt5Values.push(m.recallAt5);
    }
    if (m.recallAt10 !== null) {
      recallAt10Values.push(m.recallAt10);
    }
    precisionAt5Values.push(m.precisionAt5);
    precisionAt10Values.push(m.precisionAt10);
  }

  return {
    strategy,
    meanRecallAt5: meanOf(recallAt5Values),
    meanRecallAt10: meanOf(recallAt10Values),
    meanPrecisionAt5: meanOf(precisionAt5Values),
    meanPrecisionAt10: meanOf(precisionAt10Values),
    excludedQuestions,
  };
}

async function aggregateStats(
  pool: Pool,
  questionResults: QuestionResult[],
  allQuestions: TestQuestion[],
  goldFile: GoldSetFile,
): Promise<BenchmarkOutput> {
  const succeeded = questionResults.filter(r => r.error === undefined);
  const failed = questionResults.filter(r => r.error !== undefined);

  // ── Per-strategy recall aggregates ──────────────────────────────────────
  const strategyAggregates: StrategyAggregate[] = [
    buildStrategyAggregate('vectorRecall', 'vectorRecall', succeeded),
    buildStrategyAggregate('graphEnrichedRecall', 'graphEnrichedRecall', succeeded),
    buildStrategyAggregate('projectionMaxPerAxis', 'projectionMaxPerAxis', succeeded),
    buildStrategyAggregate('projectionSumAcrossAxes', 'projectionSumAcrossAxes', succeeded),
    buildStrategyAggregate('projectionIntersection', 'projectionIntersection', succeeded),
  ];

  // ── Per-axis projection counts from DB ──────────────────────────────────
  const projCountResult = await pool.query<{ axis: string; count: string }>(
    `SELECT axis, COUNT(*) AS count FROM mem_projections WHERE memstore_id = $1 GROUP BY axis`,
    [MEMSTORE_ID],
  );
  const projCountByAxis = new Map<string, number>();
  for (const row of projCountResult.rows) {
    projCountByAxis.set(row.axis, parseInt(row.count, 10));
  }

  // ── Per-axis stats ───────────────────────────────────────────────────────
  const axisStats: AxisStats[] = [];

  for (const axis of SEMANTIC_AXES) {
    const allMatches: Array<{ questionId: string; question: string; match: AxisMatch }> = [];

    for (const qr of succeeded) {
      const axisResult = qr.axisResults.find(ar => ar.axis === axis);
      if (axisResult === undefined) continue;
      for (const match of axisResult.matches) {
        allMatches.push({ questionId: qr.questionId, question: qr.question, match });
      }
    }

    const allSimilarities = allMatches.map(m => m.match.similarity);
    const avgSimilarity = meanOf(allSimilarities);

    const distribution = emptyBuckets();
    for (const sim of allSimilarities) {
      distribution[bucketSimilarity(sim)]++;
    }

    const sortedMatches = [...allMatches].sort((a, b) => b.match.similarity - a.match.similarity);
    const top3: TopMatch[] = sortedMatches.slice(0, 3).map(m => ({
      questionId: m.questionId,
      question: m.question,
      projectionText: m.match.projectionText,
      memSummary: m.match.summary,
      similarity: m.match.similarity,
    }));

    axisStats.push({
      axis,
      totalProjectionsInDB: projCountByAxis.get(axis) ?? 0,
      avgSimilarity,
      top3Matches: top3,
      similarityDistribution: distribution,
    });
  }

  // ── Per-category stats ───────────────────────────────────────────────────
  const categories = [...new Set(allQuestions.map(q => q.category))].sort();
  const categoryStats: CategoryStats[] = [];

  for (const category of categories) {
    const catResults = succeeded.filter(qr => qr.category === category);
    const catTotal = allQuestions.filter(q => q.category === category).length;

    if (catResults.length === 0) {
      categoryStats.push({
        category,
        questionCount: catTotal,
        successCount: 0,
        avgVectorRecallCount: 0,
        avgGraphEnrichedCount: 0,
        avgGraphAddedCount: 0,
        bestAxis: null,
      });
      continue;
    }

    const avgVectorRecallCount =
      catResults.reduce((s, r) => s + r.vectorRecallCount, 0) / catResults.length;
    const avgGraphEnrichedCount =
      catResults.reduce((s, r) => s + r.graphEnrichedCount, 0) / catResults.length;
    const avgGraphAddedCount =
      catResults.reduce((s, r) => s + r.graphAddedCount, 0) / catResults.length;

    // Best axis by avg similarity for this category
    let bestAxis: SemanticAxis | null = null;
    let bestAvgSim = -1;

    for (const axis of SEMANTIC_AXES) {
      const sims: number[] = [];
      for (const qr of catResults) {
        const axisResult = qr.axisResults.find(ar => ar.axis === axis);
        if (axisResult !== undefined) {
          for (const m of axisResult.matches) sims.push(m.similarity);
        }
      }
      if (sims.length > 0) {
        const avg = meanOf(sims);
        if (avg > bestAvgSim) {
          bestAvgSim = avg;
          bestAxis = axis;
        }
      }
    }

    categoryStats.push({
      category,
      questionCount: catTotal,
      successCount: catResults.length,
      avgVectorRecallCount,
      avgGraphEnrichedCount,
      avgGraphAddedCount,
      bestAxis,
    });
  }

  return {
    metadata: {
      testName: TEST_NAME,
      runAt: new Date().toISOString(),
      questionsTotal: allQuestions.length,
      questionsSucceeded: succeeded.length,
      questionsFailed: failed.length,
      memstoreId: MEMSTORE_ID,
      contextId: CONTEXT_ID,
      projectionThreshold: PROJECTION_THRESHOLD,
      graphNeighbors: GRAPH_NEIGHBORS,
      goldSetFile: GOLD_SET_FILE,
      goldSetGeneratedAt: goldFile.generatedAt,
      goldSetJudgeModel: goldFile.judgeModel,
    },
    strategyAggregates,
    axisStats,
    categoryStats,
    questionResults,
  };
}

// ── Summary printer ────────────────────────────────────────────────────────────

function printSummary(results: BenchmarkOutput): void {
  const dash = '─'.repeat(66);

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log(`║  BENCHMARK RECALL SUMMARY — ${results.metadata.testName.padEnd(36)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const m = results.metadata;

  console.log('── Configuration ─────────────────────────────────────────────────────');
  console.log(`  Test name:         ${m.testName}`);
  console.log(`  Graph neighbors:   ${m.graphNeighbors}`);
  console.log(`  Projection limit:  5 per axis (min threshold ${m.projectionThreshold})`);
  console.log(`  Gold set:          ${m.goldSetFile}`);
  console.log(`  Gold set model:    ${m.goldSetJudgeModel}`);

  console.log('\n── Overall ───────────────────────────────────────────────────────────');
  console.log(`  Questions total:        ${m.questionsTotal}`);
  console.log(`  Questions succeeded:    ${m.questionsSucceeded}`);
  console.log(`  Questions failed:       ${m.questionsFailed}`);

  console.log('\n── Strategy Recall@K / Precision@K ──────────────────────────────────');
  console.log('  Strategy                  R@5    R@10   P@5    P@10   Excl');
  console.log('  ' + dash);
  for (const agg of results.strategyAggregates) {
    console.log(
      `  ${agg.strategy.padEnd(25)}` +
      ` ${(agg.meanRecallAt5 * 100).toFixed(1).padStart(5)}%` +
      ` ${(agg.meanRecallAt10 * 100).toFixed(1).padStart(5)}%` +
      ` ${(agg.meanPrecisionAt5 * 100).toFixed(1).padStart(5)}%` +
      ` ${(agg.meanPrecisionAt10 * 100).toFixed(1).padStart(5)}%` +
      ` ${String(agg.excludedQuestions).padStart(5)}`,
    );
  }

  console.log('\n── Per-Axis Statistics ───────────────────────────────────────────────');
  console.log('  Axis          DBProj  AvgSim  TopSim  Dist[0.3..0.8+]');
  console.log('  ' + dash);
  for (const stat of results.axisStats) {
    const topSim = stat.top3Matches[0]?.similarity ?? 0;
    const dist = stat.similarityDistribution;
    const distStr = `[${dist['0.3-0.4']},${dist['0.4-0.5']},${dist['0.5-0.6']},${dist['0.6-0.7']},${dist['0.7-0.8']},${dist['0.8+']}]`;
    console.log(
      `  ${stat.axis.padEnd(13)} ${String(stat.totalProjectionsInDB).padStart(6)}  ` +
      `${stat.avgSimilarity.toFixed(3)}  ` +
      `${topSim.toFixed(3)}  ` +
      `${distStr}`,
    );
  }

  console.log('\n── Per-Category Statistics ───────────────────────────────────────────');
  console.log('  Category         N    VecRecall  Graph+  BestAxis');
  console.log('  ' + dash);
  for (const cat of results.categoryStats) {
    console.log(
      `  ${cat.category.padEnd(16)} ${(cat.successCount + '/' + cat.questionCount).padStart(5)}  ` +
      `${cat.avgVectorRecallCount.toFixed(1).padStart(9)}  ` +
      `${cat.avgGraphAddedCount.toFixed(1).padStart(6)}  ` +
      `${cat.bestAxis ?? 'none'}`,
    );
  }

  console.log('\n── Top Matches Per Axis ──────────────────────────────────────────────');
  for (const stat of results.axisStats) {
    if (stat.top3Matches.length === 0) {
      console.log(`  [${stat.axis}] No matches above threshold`);
      continue;
    }
    console.log(`  [${stat.axis}]`);
    for (const m2 of stat.top3Matches) {
      console.log(`    sim=${m2.similarity.toFixed(3)}  Q: ${m2.question.slice(0, 55)}...`);
      console.log(`             P: ${m2.projectionText.slice(0, 60)}...`);
    }
  }

  console.log(`\nResults saved to: ${RESULTS_FILE}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Benchmark Recall ===');
  console.log(`Test name: ${TEST_NAME}`);
  console.log(`Graph neighbors: ${GRAPH_NEIGHBORS}`);
  console.log('');

  // Load frozen gold set — fail fast if missing (checked at startup above)
  const goldFile = JSON.parse(readFileSync(GOLD_SET_FILE, 'utf-8')) as GoldSetFile;
  console.log(`Gold set: ${Object.keys(goldFile.questions).length} questions, judge=${goldFile.judgeModel}, generated=${goldFile.generatedAt}`);
  console.log('');

  const pool = new Pool({ connectionString: POSTGRES_URL });

  // Verify DB connection
  const dbClient = await pool.connect();
  const versionResult = await dbClient.query<{ version: string }>('SELECT version()');
  const version = versionResult.rows[0]?.version ?? 'unknown';
  console.log(`PostgreSQL: ${version.split(' ').slice(0, 2).join(' ')}`);

  // Print DB state for sanity check
  const memsResult = await dbClient.query<{ count: string }>(
    `SELECT COUNT(*) FROM mems WHERE memstore_id = $1 AND embedding IS NOT NULL`,
    [MEMSTORE_ID],
  );
  const projectionsResult = await dbClient.query<{ count: string }>(
    `SELECT COUNT(*) FROM mem_projections WHERE memstore_id = $1`,
    [MEMSTORE_ID],
  );
  const edgesResult = await dbClient.query<{ count: string }>(
    `SELECT COUNT(*) FROM mem_edges WHERE memstore_id = $1`,
    [MEMSTORE_ID],
  );
  console.log(`Mems with embeddings: ${memsResult.rows[0]?.count ?? 0}`);
  console.log(`Projections: ${projectionsResult.rows[0]?.count ?? 0}`);
  console.log(`Edges: ${edgesResult.rows[0]?.count ?? 0}`);
  dbClient.release();

  const openai = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    timeout: 30_000,
  });

  const memStore = new PostgresMemStore(POSTGRES_URL);
  const graphStore = new GraphStore(pool);
  const graphRecall = new GraphRecall(graphStore);
  const projectionExtractor = new ProjectionExtractor({
    geminiApiKey: OPENROUTER_API_KEY,
    geminiModel: 'google/gemini-2.5-flash',
    openaiApiKey: OPENAI_API_KEY,
  });

  // Load all 100 questions
  const questionsContent = readFileSync(QUESTIONS_FILE, 'utf-8');
  const questionsData = JSON.parse(questionsContent) as { questions: TestQuestion[] };
  const allQuestions = questionsData.questions;
  console.log(`\nLoaded ${allQuestions.length} test questions`);

  const categoryCounts = new Map<string, number>();
  for (const q of allQuestions) {
    categoryCounts.set(q.category, (categoryCounts.get(q.category) ?? 0) + 1);
  }
  console.log('Categories:', [...categoryCounts.entries()].map(([k, v]) => `${k}(${v})`).join(', '));
  console.log('');

  // Run benchmark on all questions
  console.log(`Running benchmark on all ${allQuestions.length} questions...\n`);
  const questionResults = await runBenchmark(
    pool,
    memStore,
    graphRecall,
    openai,
    projectionExtractor,
    allQuestions,
    goldFile.questions,
  );

  // Aggregate stats
  console.log('\nAggregating statistics...');
  const output = await aggregateStats(pool, questionResults, allQuestions, goldFile);

  // Save results
  mkdirSync('/home/alexmak/llmems/main/sandboxes', { recursive: true });
  writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2), 'utf-8');

  // Print summary
  printSummary(output);

  // Cleanup
  await memStore.close();
  await pool.end();

  console.log('\nDone.');
}

main().catch((e: unknown) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
