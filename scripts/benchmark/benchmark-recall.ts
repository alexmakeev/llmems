// scripts/benchmark/benchmark-recall.ts — 1C recall benchmark, vectorRecall arm
// only, CURRENT v0.4.0 library (bead llmems-g3a; replaces the orphaned
// graph-era pipeline — that one survives untracked in
// feature-context-factory/sandboxes/benchmark/ as reference only).
//
// Usage (stand, LiteLLM scoped key; see docs/benchmark.md):
//   POSTGRES_URL=... MEMSTORE_ID=4 \
//   BENCHMARK_LLM_BASE_URL=<stand LiteLLM>/v1 \
//   BENCHMARK_LLM_API_KEY=sk-... \
//   BENCHMARK_EMBEDDING_MODEL=openai-embedding-small \
//   BENCHMARK_GOLDSET_FILE=sandboxes/gold-set-4.json \
//   [QUESTION_LIMIT=10] [TEST_NAME=baseline] \
//   npx tsx scripts/benchmark/benchmark-recall.ts
//
// Input:  BENCHMARK_GOLDSET_FILE — frozen gold set JSON (transferred per dnh from
//         the generation machine; gitignored, location owner-chosen → explicit
//         required env, no hardcoded path; NEVER regenerate between arms)
// Output: sandboxes/benchmark-{TEST_NAME}.json + console summary with deviation
//         vs the archived baseline (R@5 0.524 / R@10 0.668) — the .10 sanity gate.
//
// SAME-SPACE CONDITION (runbook §6): BENCHMARK_EMBEDDING_MODEL must resolve to
// the same embedding space as the corpus mems (text-embedding-3-small, 1536-dim).
// The script verifies dimensionality (1536) and echoes the model name into the
// report; model IDENTITY beyond the name cannot be verified client-side.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import { PostgresMemStore } from '../../src/services/postgres-mem-store.js';
import { requireEnv, requireEnvInt } from '../lib/require-env.js';
import { loadGoldSet, runBenchmark } from './lib/benchmark-core.js';

const EXPECTED_DIMENSIONS = 1536;

async function main(): Promise<number> {
  // ── Config (fail-fast, no defaults for anything machine-specific) ──────────
  const postgresUrl = requireEnv('POSTGRES_URL');
  const baseURL = requireEnv('BENCHMARK_LLM_BASE_URL');
  const apiKey = requireEnv('BENCHMARK_LLM_API_KEY');
  const embeddingModel = requireEnv('BENCHMARK_EMBEDDING_MODEL');
  const memstoreId = requireEnvInt('MEMSTORE_ID');
  const questionLimit =
    process.env['QUESTION_LIMIT'] !== undefined && process.env['QUESTION_LIMIT'] !== ''
      ? requireEnvInt('QUESTION_LIMIT')
      : undefined;
  const testName = process.env['TEST_NAME'] ?? 'baseline';

  const goldSetFile = requireEnv('BENCHMARK_GOLDSET_FILE');
  const resultsFile = `sandboxes/benchmark-${testName}.json`;

  if (!existsSync(goldSetFile)) {
    throw new Error(
      `Gold set not found: ${goldSetFile} (frozen input — transferred per llmems-dnh; ` +
        'NEVER regenerate between arms).',
    );
  }
  const goldSet = loadGoldSet(readFileSync(goldSetFile, 'utf8'), memstoreId);
  console.log(
    `Gold set: ${Object.keys(goldSet.questions).length} questions, ` +
      `judge=${goldSet.judgeModel}, generated=${goldSet.generatedAt}`,
  );

  // ── Collaborators ───────────────────────────────────────────────────────────
  const pool = new Pool({ connectionString: postgresUrl });
  const store = new PostgresMemStore(postgresUrl);
  const openai = new OpenAI({ baseURL, apiKey });

  try {
    // Verify the memstore EXISTS and resolve its name (= contextId for the
    // store API). Never rely on on-demand memstore creation here: a typo'd id
    // would silently benchmark an empty corpus.
    const memstoreResult = await pool.query<{ name: string }>(
      'SELECT name FROM memstores WHERE id = $1',
      [memstoreId],
    );
    const contextId = memstoreResult.rows[0]?.name;
    if (contextId === undefined) {
      throw new Error(
        `Memstore id=${memstoreId} not found in this database — corpus not migrated? (llmems-ad0)`,
      );
    }
    const memsCount = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM mems WHERE memstore_id = $1 AND embedding IS NOT NULL',
      [memstoreId],
    );
    console.log(`Corpus: memstore ${memstoreId} ("${contextId}"), ${memsCount.rows[0]?.count} embedded mems`);

    const embed = async (question: string): Promise<number[]> => {
      const response = await openai.embeddings.create({ model: embeddingModel, input: question });
      const vector = response.data[0]?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error('Embeddings response malformed: data[0].embedding missing');
      }
      if (vector.length !== EXPECTED_DIMENSIONS) {
        throw new Error(
          `Embedding dimension mismatch: got ${vector.length}, expected ${EXPECTED_DIMENSIONS} — ` +
            'BENCHMARK_EMBEDDING_MODEL is not in the corpus embedding space (runbook §6).',
        );
      }
      return vector;
    };

    const search = (vector: number[]) => store.searchMemsByVector(vector, 10, contextId);

    // ── Run ───────────────────────────────────────────────────────────────────
    const result = await runBenchmark({
      goldSet,
      embed,
      search,
      kValues: [5, 10],
      ...(questionLimit !== undefined ? { questionLimit } : {}),
    });

    // ── Report ────────────────────────────────────────────────────────────────
    const report = {
      testName,
      memstoreId,
      contextId,
      runAt: new Date().toISOString(),
      goldSet: {
        file: goldSetFile,
        generatedAt: goldSet.generatedAt,
        judgeModel: goldSet.judgeModel,
        questionCount: Object.keys(goldSet.questions).length,
      },
      embedding: { model: embeddingModel, baseURL, dimensions: EXPECTED_DIMENSIONS },
      config: { questionLimit: questionLimit ?? null, kValues: [5, 10] },
      ...result,
    };
    mkdirSync('sandboxes', { recursive: true });
    writeFileSync(resultsFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const a = result.aggregate;
    console.log('');
    console.log(`vectorRecall arm (${a.evaluated} evaluated, ${a.excludedZeroExpected} excluded):`);
    console.log(`  recall@5  = ${a.recallAt5.toFixed(3)}  (archived 0.524, deviation ${result.deviation.recallAt5.toFixed(3)})`);
    console.log(`  recall@10 = ${a.recallAt10.toFixed(3)}  (archived 0.668, deviation ${result.deviation.recallAt10.toFixed(3)})`);
    console.log(`  precision@5 = ${a.precisionAt5.toFixed(3)}, precision@10 = ${a.precisionAt10.toFixed(3)}`);
    console.log(`Results written: ${resultsFile}`);
    return 0;
  } finally {
    await store.close();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`BENCHMARK FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
