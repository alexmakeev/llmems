// scripts/benchmark-recall.ts
// Comprehensive benchmark that runs all 100 test questions against the recall system.
// Collects per-axis, per-category statistics for A/B testing different graph configurations.
//
// Usage:
//   npx tsx scripts/benchmark-recall.ts
//
// Configurable via env vars:
//   HIT_THRESHOLD    (default 0.5)  — minimum similarity to count as a "hit"
//   GRAPH_NEIGHBORS  (default 10)   — override MAX_GRAPH_NEIGHBORS
//   TEST_NAME        (default "baseline") — label for this run
//
// Output:
//   sandboxes/benchmark-{TEST_NAME}.json — full raw results
//   console — per-axis and per-category summary

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
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

const HIT_THRESHOLD = parseFloat(process.env['HIT_THRESHOLD'] ?? '0.5');
const GRAPH_NEIGHBORS = parseInt(process.env['GRAPH_NEIGHBORS'] ?? '10', 10);
const TEST_NAME = process.env['TEST_NAME'] ?? 'baseline';

const QUESTIONS_FILE = '/home/alexmak/llmems-old/main/sandboxes/recall-test-questions.json';
const RESULTS_FILE = `/home/alexmak/llmems/main/sandboxes/benchmark-${TEST_NAME}.json`;

const MEMSTORE_ID = requireEnvInt('MEMSTORE_ID');
const CONTEXT_ID = 'benchmark-katya-year';

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
  hitCount: number;  // matches with similarity >= HIT_THRESHOLD
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
  error?: string;
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
  /** % of questions where this axis returned at least 1 hit >= HIT_THRESHOLD */
  hitRate: number;
  hitCount: number;
  totalQueries: number;
  top3Matches: TopMatch[];
  similarityDistribution: SimilarityBuckets;
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
  /** % of questions in this category with at least 1 hit (any axis) >= HIT_THRESHOLD */
  hitRate: number;
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
    hitThreshold: number;
    graphNeighbors: number;
  };
  overall: {
    avgVectorRecallCount: number;
    avgProjectionMatchCount: number;
    avgGraphEnrichedCount: number;
    avgGraphAddedCount: number;
    /** % of questions where vectorRecall returned >= 1 result */
    vectorHitRate: number;
    /** % of questions where any axis returned >= 1 match >= HIT_THRESHOLD */
    projectionHitRate: number;
    /** % of questions where graph enrichment added at least 1 node */
    graphEnrichmentRate: number;
  };
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

async function runBenchmark(
  pool: Pool,
  memStore: PostgresMemStore,
  graphRecall: GraphRecall,
  openai: OpenAI,
  projectionExtractor: ProjectionExtractor,
  questions: TestQuestion[],
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (question === undefined) continue;

    const progress = `[${String(i + 1).padStart(3)}/${questions.length}]`;
    process.stdout.write(`${progress} ${question.id} (${question.category}/${question.difficulty}): ${question.question.slice(0, 50)}...\n`);

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
    try {
      const enrichedResult = await graphRecall.enrichRecall(vectorResult, CONTEXT_ID);
      if (enrichedResult.ok) {
        graphEnrichedCount = enrichedResult.value.nodes.length;
        graphAddedCount = graphEnrichedCount - vectorNodes.length;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`  graphRecall failed: ${message}`);
    }

    // ── Per-axis projection recall ──────────────────────────────────────────
    const axisResults: QuestionAxisResult[] = [];
    for (const axis of SEMANTIC_AXES) {
      const matches = await runAxisRecall(pool, questionEmbedding, axis);
      const hitCount = matches.filter(m => m.similarity >= HIT_THRESHOLD).length;
      axisResults.push({ axis, matches, hitCount });
    }

    const totalAxisMatches = axisResults.reduce((sum, ar) => sum + ar.matches.length, 0);
    const totalAxisHits = axisResults.reduce((sum, ar) => sum + ar.hitCount, 0);

    // ── True per-axis projection recall + 3 aggregation strategies ─────────────
    const perAxisResults = await runTrueProjectionRecall(
      pool,
      projectionExtractor,
      question.question,
    );

    const projectionMaxPerAxis = aggregateMaxPerAxis(perAxisResults).slice(0, PROJECTION_AGGREGATION_TOP_K);
    const projectionSumAcrossAxes = aggregateSumAcrossAxes(perAxisResults).slice(0, PROJECTION_AGGREGATION_TOP_K);
    const projectionIntersection = aggregateIntersection(perAxisResults).slice(0, PROJECTION_AGGREGATION_TOP_K);

    console.log(
      `  vec:${vectorNodes.length} graph+:${graphAddedCount}` +
      ` axisMatches:${totalAxisMatches} axisHits:${totalAxisHits}` +
      ` projAxes:${perAxisResults.size}` +
      ` projTop:${projectionMaxPerAxis.length}/${projectionSumAcrossAxes.length}/${projectionIntersection.length}`,
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
    });
  }

  return results;
}

// ── Statistics aggregation ─────────────────────────────────────────────────────

async function aggregateStats(
  pool: Pool,
  questionResults: QuestionResult[],
  allQuestions: TestQuestion[],
): Promise<BenchmarkOutput> {
  const succeeded = questionResults.filter(r => r.error === undefined);
  const failed = questionResults.filter(r => r.error !== undefined);

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

    const hitCount = succeeded.filter(qr => {
      const axisResult = qr.axisResults.find(ar => ar.axis === axis);
      return axisResult !== undefined &&
        axisResult.matches.some(m => m.similarity >= HIT_THRESHOLD);
    }).length;

    const allSimilarities = allMatches.map(m => m.match.similarity);
    const avgSimilarity = allSimilarities.length > 0
      ? allSimilarities.reduce((s, v) => s + v, 0) / allSimilarities.length
      : 0;

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
      hitRate: succeeded.length > 0 ? hitCount / succeeded.length : 0,
      hitCount,
      totalQueries: succeeded.length,
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
        hitRate: 0,
      });
      continue;
    }

    const avgVectorRecallCount =
      catResults.reduce((s, r) => s + r.vectorRecallCount, 0) / catResults.length;
    const avgGraphEnrichedCount =
      catResults.reduce((s, r) => s + r.graphEnrichedCount, 0) / catResults.length;
    const avgGraphAddedCount =
      catResults.reduce((s, r) => s + r.graphAddedCount, 0) / catResults.length;

    const catHitCount = catResults.filter(qr =>
      qr.axisResults.some(ar => ar.matches.some(m => m.similarity >= HIT_THRESHOLD)),
    ).length;
    const hitRate = catHitCount / catResults.length;

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
        const avg = sims.reduce((s, v) => s + v, 0) / sims.length;
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
      hitRate,
    });
  }

  // ── Overall stats ────────────────────────────────────────────────────────
  const avgVectorRecallCount = succeeded.length > 0
    ? succeeded.reduce((s, r) => s + r.vectorRecallCount, 0) / succeeded.length
    : 0;

  const allAxisMatches = succeeded.flatMap(qr => qr.axisResults.flatMap(ar => ar.matches));
  const avgProjectionMatchCount = succeeded.length > 0
    ? allAxisMatches.length / succeeded.length
    : 0;

  const avgGraphEnrichedCount = succeeded.length > 0
    ? succeeded.reduce((s, r) => s + r.graphEnrichedCount, 0) / succeeded.length
    : 0;

  const avgGraphAddedCount = succeeded.length > 0
    ? succeeded.reduce((s, r) => s + r.graphAddedCount, 0) / succeeded.length
    : 0;

  const vectorHitRate = succeeded.length > 0
    ? succeeded.filter(r => r.vectorRecallCount > 0).length / succeeded.length
    : 0;

  const projectionHitRate = succeeded.length > 0
    ? succeeded.filter(r =>
        r.axisResults.some(ar => ar.matches.some(m => m.similarity >= HIT_THRESHOLD)),
      ).length / succeeded.length
    : 0;

  const graphEnrichmentRate = succeeded.length > 0
    ? succeeded.filter(r => r.graphAddedCount > 0).length / succeeded.length
    : 0;

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
      hitThreshold: HIT_THRESHOLD,
      graphNeighbors: GRAPH_NEIGHBORS,
    },
    overall: {
      avgVectorRecallCount,
      avgProjectionMatchCount,
      avgGraphEnrichedCount,
      avgGraphAddedCount,
      vectorHitRate,
      projectionHitRate,
      graphEnrichmentRate,
    },
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
  const o = results.overall;

  console.log('── Configuration ─────────────────────────────────────────────────────');
  console.log(`  Test name:         ${m.testName}`);
  console.log(`  Hit threshold:     ${m.hitThreshold}`);
  console.log(`  Graph neighbors:   ${m.graphNeighbors}`);
  console.log(`  Projection limit:  5 per axis (min threshold ${m.projectionThreshold})`);

  console.log('\n── Overall ───────────────────────────────────────────────────────────');
  console.log(`  Questions total:        ${m.questionsTotal}`);
  console.log(`  Questions succeeded:    ${m.questionsSucceeded}`);
  console.log(`  Questions failed:       ${m.questionsFailed}`);
  console.log(`  Avg vector recall:      ${o.avgVectorRecallCount.toFixed(1)} mems`);
  console.log(`  Avg projection matches: ${o.avgProjectionMatchCount.toFixed(1)} (all axes combined)`);
  console.log(`  Avg graph enriched:     ${o.avgGraphEnrichedCount.toFixed(1)} mems (+${o.avgGraphAddedCount.toFixed(1)} via edges)`);
  console.log(`  Vector hit rate:        ${(o.vectorHitRate * 100).toFixed(1)}%`);
  console.log(`  Projection hit rate:    ${(o.projectionHitRate * 100).toFixed(1)}% (any axis >= ${m.hitThreshold})`);
  console.log(`  Graph enrichment rate:  ${(o.graphEnrichmentRate * 100).toFixed(1)}% (added >= 1 node via graph)`);

  console.log('\n── Per-Axis Statistics ───────────────────────────────────────────────');
  console.log('  Axis          DBProj  HitRate  AvgSim  TopSim  Dist[0.3..0.8+]');
  console.log('  ' + dash);
  for (const stat of results.axisStats) {
    const topSim = stat.top3Matches[0]?.similarity ?? 0;
    const dist = stat.similarityDistribution;
    const distStr = `[${dist['0.3-0.4']},${dist['0.4-0.5']},${dist['0.5-0.6']},${dist['0.6-0.7']},${dist['0.7-0.8']},${dist['0.8+']}]`;
    console.log(
      `  ${stat.axis.padEnd(13)} ${String(stat.totalProjectionsInDB).padStart(6)}  ` +
      `${(stat.hitRate * 100).toFixed(1).padStart(6)}%  ` +
      `${stat.avgSimilarity.toFixed(3)}  ` +
      `${topSim.toFixed(3)}  ` +
      `${distStr}`,
    );
  }

  console.log('\n── Per-Category Statistics ───────────────────────────────────────────');
  console.log('  Category         N    VecRecall  Graph+  HitRate  BestAxis');
  console.log('  ' + dash);
  for (const cat of results.categoryStats) {
    console.log(
      `  ${cat.category.padEnd(16)} ${(cat.successCount + '/' + cat.questionCount).padStart(5)}  ` +
      `${cat.avgVectorRecallCount.toFixed(1).padStart(9)}  ` +
      `${cat.avgGraphAddedCount.toFixed(1).padStart(6)}  ` +
      `${(cat.hitRate * 100).toFixed(1).padStart(6)}%  ` +
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
  console.log(`Hit threshold: ${HIT_THRESHOLD}`);
  console.log(`Graph neighbors: ${GRAPH_NEIGHBORS}`);
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
  );

  // Aggregate stats
  console.log('\nAggregating statistics...');
  const output = await aggregateStats(pool, questionResults, allQuestions);

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
