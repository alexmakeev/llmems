// scripts/generate-gold-set.ts
// Generates a frozen gold set for the recall benchmark.
//
// The gold set maps each test question to the set of mems that semantically
// cover at least one of its expected facts, as judged by an LLM (Gemini Flash).
//
// Usage:
//   MEMSTORE_ID=4 OPENROUTER_API_KEY=... npx tsx scripts/generate-gold-set.ts
//
// Required env vars:
//   MEMSTORE_ID          — integer memstore ID to evaluate (e.g. 4)
//   OPENROUTER_API_KEY   — API key for OpenRouter (used for Gemini Flash judge)
//
// Optional env vars:
//   POSTGRES_URL         — PostgreSQL connection string (defaults to local dev DB)
//   JUDGE_MODEL          — model for judging (default: google/gemini-2.5-flash)
//   JUDGE_CONCURRENCY    — max parallel judge calls (default: 5)
//
// Output:
//   sandboxes/gold-set-{MEMSTORE_ID}.json — frozen gold set (DO NOT auto-regenerate)
//   stdout — coverage summary

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import { requireEnvInt } from '../src/shared/env.js';
import {
  extractSessionDates,
  parseJudgeResponse,
} from '../src/services/graph/recall-metrics.js';
import type { ParsedJudgeResult } from '../src/services/graph/recall-metrics.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const MEMSTORE_ID = requireEnvInt('MEMSTORE_ID');

const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'];
if (!OPENROUTER_API_KEY) {
  throw new Error('Required env var OPENROUTER_API_KEY is not set');
}

const POSTGRES_URL = process.env['POSTGRES_URL'] ??
  'postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems_axis_projections';

const JUDGE_MODEL = process.env['JUDGE_MODEL'] ?? 'google/gemini-2.5-flash';
const JUDGE_CONCURRENCY = parseInt(process.env['JUDGE_CONCURRENCY'] ?? '5', 10);

const QUESTIONS_FILE = '/home/alexmak/llmems-old/main/sandboxes/recall-test-questions.json';
const OUTPUT_FILE = `/home/alexmak/llmems/main/sandboxes/gold-set-${MEMSTORE_ID}.json`;

// ── Types ──────────────────────────────────────────────────────────────────────

interface TestQuestion {
  id: string;
  category: string;
  question: string;
  difficulty: string;
  expected_facts: string[];
  source_sessions: string[];
}

interface CandidateMem {
  id: string;
  summary: string;
  chunkContent: string; // concatenated chunk content (Russian original)
}

interface QuestionGold {
  sourceSessions: string[];
  candidateMemIds: string[];
  expectedMemIds: string[];
  /** factCoverage[factIndex] = list of memIds that cover that fact */
  factCoverage: Record<number, string[]>;
}

interface GoldSetStats {
  questionsWithZeroExpected: number;
  meanExpected: number;
  medianExpected: number;
  maxExpected: number;
}

interface GoldSetOutput {
  memstoreId: number;
  generatedAt: string;
  judgeModel: string;
  questions: Record<string, QuestionGold>;
  stats: GoldSetStats;
}

// ── Database helpers ───────────────────────────────────────────────────────────

/**
 * Fetch all mems for the given memstore, with their concatenated chunk content.
 * Session date is extracted from chunk content via the Session: katya-YYYY-MM-DD prefix.
 */
async function fetchMemsWithChunks(pool: Pool): Promise<Map<string, CandidateMem & { sessionDates: string[] }>> {
  // Fetch mems
  const memsResult = await pool.query<{ id: number; summary: string }>(
    `SELECT id, summary FROM mems WHERE memstore_id = $1`,
    [MEMSTORE_ID],
  );

  // Fetch all chunks in one query, joined via mems.chunk_ids (array FK),
  // ordered by mc.id for consistent concatenation
  const chunksResult = await pool.query<{ mem_id: number; content: string }>(
    `SELECT m.id AS mem_id, mc.content
     FROM mems m
     JOIN mem_chunks mc ON mc.id = ANY(m.chunk_ids)
     WHERE m.memstore_id = $1
     ORDER BY mc.id ASC`,
    [MEMSTORE_ID],
  );

  // Group chunks by mem_id
  const chunksByMem = new Map<number, string[]>();
  for (const row of chunksResult.rows) {
    const existing = chunksByMem.get(row.mem_id);
    if (existing !== undefined) {
      existing.push(row.content);
    } else {
      chunksByMem.set(row.mem_id, [row.content]);
    }
  }

  // Build mem map with concatenated chunks and extracted session dates
  const result = new Map<string, CandidateMem & { sessionDates: string[] }>();
  for (const mem of memsResult.rows) {
    const chunks = chunksByMem.get(mem.id) ?? [];
    const chunkContent = chunks.join('\n');
    const sessionDates = extractSessionDates(chunkContent);
    result.set(String(mem.id), {
      id: String(mem.id),
      summary: mem.summary,
      chunkContent,
      sessionDates,
    });
  }

  return result;
}

// ── LLM judge ─────────────────────────────────────────────────────────────────

/**
 * System prompt for the judge. Conservative: only mark a fact as covered
 * if the chunk genuinely states or supports it.
 */
const JUDGE_SYSTEM_PROMPT = `You are a precise fact-coverage judge evaluating whether a memory segment covers specific facts.

You will receive:
1. MEMORY CONTENT: the original Russian conversation segment (mem chunks)
2. FACTS TO CHECK: a numbered list of Russian facts from a test question's expected_facts

Your task: for each fact, determine whether the MEMORY CONTENT semantically covers it — meaning the memory genuinely states, supports, or provides clear evidence for that fact.

CONSERVATIVE standard — only mark covered=true when:
- The memory explicitly mentions the fact (directly or with minor paraphrase)
- OR the memory provides clear, unambiguous support for the fact
- NOT when the fact could merely be inferred by reading between the lines
- NOT when the fact is only tangentially related

Return a JSON object with this exact schema:
{
  "evaluations": [
    { "factIndex": 0, "covered": true },
    { "factIndex": 1, "covered": false },
    ...
  ]
}

Include ALL facts in the evaluations array. Use the same factIndex as given.
Respond ONLY with valid JSON. No explanation, no markdown fences.`;

/**
 * Build the user prompt for judging a single mem against a question's expected facts.
 */
function buildJudgePrompt(chunkContent: string, expectedFacts: string[]): string {
  const factsList = expectedFacts
    .map((fact, i) => `${i}. ${fact}`)
    .join('\n');

  return `MEMORY CONTENT:
${chunkContent}

---

FACTS TO CHECK (0-indexed):
${factsList}

Evaluate which facts this memory covers. Return JSON only.`;
}

/**
 * Call the LLM judge for a single mem and parse the response.
 * Retries once on parse failure (as specified in task).
 */
async function judgeMemCoversFacts(
  client: OpenAI,
  chunkContent: string,
  expectedFacts: string[],
): Promise<ParsedJudgeResult | null> {
  const userPrompt = buildJudgePrompt(chunkContent, expectedFacts);

  for (let attempt = 0; attempt < 2; attempt++) {
    let rawContent: string;
    try {
      const response = await client.chat.completions.create({
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      const choice = response.choices[0];
      if (choice === undefined || choice.message.content === null) {
        console.warn(`  [judge] Empty LLM response (attempt ${attempt + 1})`);
        continue;
      }
      rawContent = choice.message.content;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  [judge] LLM call failed (attempt ${attempt + 1}): ${msg}`);
      continue;
    }

    const parsed = parseJudgeResponse(rawContent, expectedFacts.length);
    if (parsed !== null) return parsed;

    console.warn(`  [judge] Parse failed (attempt ${attempt + 1}), retrying...`);
  }

  return null;
}

// ── Concurrency helper ─────────────────────────────────────────────────────────

/**
 * Process an array of async tasks with bounded concurrency.
 */
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Statistics helpers ─────────────────────────────────────────────────────────

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Generate Gold Set ===');
  console.log(`Memstore ID: ${MEMSTORE_ID}`);
  console.log(`Judge model: ${JUDGE_MODEL}`);
  console.log(`Concurrency: ${JUDGE_CONCURRENCY}`);
  console.log('');

  // Connect to DB
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const dbClient = await pool.connect();
  const versionResult = await dbClient.query<{ version: string }>('SELECT version()');
  const version = versionResult.rows[0]?.version ?? 'unknown';
  console.log(`PostgreSQL: ${version.split(' ').slice(0, 2).join(' ')}`);
  dbClient.release();

  // Create OpenRouter client (Gemini Flash via OpenRouter)
  const client = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    timeout: 60_000,
  });

  // Load test questions
  const questionsContent = readFileSync(QUESTIONS_FILE, 'utf-8');
  const questionsData = JSON.parse(questionsContent) as { questions: TestQuestion[] };
  const questions = questionsData.questions;
  console.log(`Loaded ${questions.length} questions`);

  // Fetch all mems with chunks
  console.log('Fetching mems and chunks from DB...');
  const allMems = await fetchMemsWithChunks(pool);
  console.log(`Loaded ${allMems.size} mems total`);
  console.log('');

  // Process each question
  const goldQuestions: Record<string, QuestionGold> = {};
  let processedCount = 0;
  let totalJudgeCalls = 0;

  for (const question of questions) {
    processedCount++;
    const progress = `[${String(processedCount).padStart(3)}/${questions.length}]`;
    process.stdout.write(`${progress} ${question.id}: ${question.question.slice(0, 60)}...\n`);

    // Step (a): candidate mems = mems whose session dates ∩ question.source_sessions
    const sourceSessionSet = new Set(question.source_sessions);
    const candidates: Array<CandidateMem & { sessionDates: string[] }> = [];

    for (const mem of allMems.values()) {
      const hasMatchingSession = mem.sessionDates.some(d => sourceSessionSet.has(d));
      if (hasMatchingSession) {
        candidates.push(mem);
      }
    }

    console.log(`  Sessions: ${question.source_sessions.join(', ')} → ${candidates.length} candidates`);

    if (candidates.length === 0) {
      console.log('  No candidates — question will have zero expected mems');
      goldQuestions[question.id] = {
        sourceSessions: question.source_sessions,
        candidateMemIds: [],
        expectedMemIds: [],
        factCoverage: {},
      };
      continue;
    }

    // Step (b): LLM judge each candidate mem
    // factCoverage[factIndex] = list of memIds covering that fact
    const factCoverage: Record<number, string[]> = {};
    for (let i = 0; i < question.expected_facts.length; i++) {
      factCoverage[i] = [];
    }

    const expectedMemIdSet = new Set<string>();

    // Process candidates in parallel with concurrency limit
    const judgeResults = await withConcurrency(
      candidates,
      JUDGE_CONCURRENCY,
      async (candidate) => {
        totalJudgeCalls++;
        const result = await judgeMemCoversFacts(
          client,
          candidate.chunkContent,
          question.expected_facts,
        );
        return { memId: candidate.id, result };
      },
    );

    for (const { memId, result } of judgeResults) {
      if (result === null) {
        console.warn(`  WARNING: judge failed for mem ${memId}, treating as no coverage`);
        continue;
      }

      if (result.coveredFactIndices.size > 0) {
        // Step (c): mem covers ≥1 fact → include in expectedMemIds
        expectedMemIdSet.add(memId);
      }

      for (const factIdx of result.coveredFactIndices) {
        const existing = factCoverage[factIdx];
        if (existing !== undefined) {
          existing.push(memId);
        }
      }
    }

    const expectedMemIds = [...expectedMemIdSet];
    console.log(`  Expected mems: ${expectedMemIds.length}/${candidates.length} (${question.expected_facts.length} facts)`);

    goldQuestions[question.id] = {
      sourceSessions: question.source_sessions,
      candidateMemIds: candidates.map(c => c.id),
      expectedMemIds,
      factCoverage,
    };
  }

  // Compute statistics
  const expectedCounts = Object.values(goldQuestions).map(q => q.expectedMemIds.length);
  const questionsWithZeroExpected = expectedCounts.filter(c => c === 0).length;
  const nonZeroCounts = expectedCounts.filter(c => c > 0);
  const meanExpected = nonZeroCounts.length > 0
    ? nonZeroCounts.reduce((s, c) => s + c, 0) / nonZeroCounts.length
    : 0;
  const medianExpected = computeMedian(nonZeroCounts);
  const maxExpected = nonZeroCounts.length > 0 ? Math.max(...nonZeroCounts) : 0;

  const stats: GoldSetStats = {
    questionsWithZeroExpected,
    meanExpected,
    medianExpected,
    maxExpected,
  };

  // Write output
  const output: GoldSetOutput = {
    memstoreId: MEMSTORE_ID,
    generatedAt: new Date().toISOString(),
    judgeModel: JUDGE_MODEL,
    questions: goldQuestions,
    stats,
  };

  mkdirSync('/home/alexmak/llmems/main/sandboxes', { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  // Print coverage summary
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log(`║  GOLD SET COVERAGE SUMMARY — memstore ${MEMSTORE_ID.toString().padEnd(28)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  console.log(`  Total questions:            ${questions.length}`);
  console.log(`  Questions with 0 expected:  ${stats.questionsWithZeroExpected} (excluded from recall avg)`);
  console.log(`  Questions with ≥1 expected: ${questions.length - stats.questionsWithZeroExpected}`);
  console.log(`  Mean expected mems:         ${stats.meanExpected.toFixed(2)} (among non-zero)`);
  console.log(`  Median expected mems:       ${stats.medianExpected.toFixed(1)} (among non-zero)`);
  console.log(`  Max expected mems:          ${stats.maxExpected}`);
  console.log(`  Total judge calls:          ${totalJudgeCalls}`);
  console.log(`\nGold set saved to: ${OUTPUT_FILE}`);

  await pool.end();
  console.log('\nDone.');
}

main().catch((e: unknown) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
