// scripts/benchmark/longmemeval.ts — LongMemEval-S benchmark CLI (bead llmems-mdg).
// Thin shell wiring REAL collaborators; all logic lives in the offline-tested
// lib/longmemeval-core.ts. Retrieval-only recall_any@K — NO LLM judge, the only
// paid calls are embeddings, and every embedding call is behind the spend gate.
//
// Usage (heap: the pinned dataset is 265 MB JSON — give node room):
//   export NODE_OPTIONS=--max-old-space-size=4096
//
//   # 1. Offline spend preflight — no DB, no network, no credentials:
//   npx tsx scripts/benchmark/longmemeval.ts preflight [--category info-extraction]
//
//   # 2. Seed (ingestion; idempotent top-up — resumes after interruption):
//   POSTGRES_URL=...           # llmems_bench DB on the AM32 stand
//   BENCHMARK_LLM_BASE_URL=... BENCHMARK_LLM_API_KEY=... BENCHMARK_EMBEDDING_MODEL=... \
//   LLMEMS_BENCH_BUDGET_USD=1 \
//   npx tsx scripts/benchmark/longmemeval.ts seed [--category info-extraction]
//
//   # 3. Recall scoring (sanity-gated: aborts if ingestion is broken):
//   <same env> npx tsx scripts/benchmark/longmemeval.ts recall [--category info-extraction]
//
// Optional: --dataset <path> overrides the pinned dataset location (sha256 is
// ALWAYS verified against the yn7 pin — a different file aborts loudly).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import { PostgresMemStore } from '../../src/services/postgres-mem-store.js';
import { requireEnv, requireEnvNumber } from '../lib/require-env.js';
import {
  parseDataset,
  computePreflight,
  assertBudget,
  runSeed,
  runRecallScoring,
  decodeProvenance,
  LONGMEMEVAL_S_SHA256,
  DEFAULT_DATASET_PATH,
  type LmeQuestion,
} from './lib/longmemeval-core.js';

const EXPECTED_DIMENSIONS = 1536;
/** Dedicated memstore name (= contextId) for this dataset in llmems_bench. */
const LONGMEMEVAL_CONTEXT_ID = 'longmemeval-s';
/** Sessions per embeddings request: 32 × ≤7k tok ≈ 224k tok worst case per call. */
const SEED_BATCH_SIZE = 32;
/** Provenance marker + session id comfortably fit in this summary prefix. */
const PROVENANCE_HEAD_CHARS = 200;

// ── Args ──────────────────────────────────────────────────────────────────────

interface CliArgs {
  command: 'preflight' | 'seed' | 'recall';
  category: string | undefined;
  datasetPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const [command] = argv;
  if (command !== 'preflight' && command !== 'seed' && command !== 'recall') {
    throw new Error(
      `Usage: longmemeval.ts <preflight|seed|recall> [--category <c>] [--dataset <path>] — got "${command ?? ''}"`,
    );
  }
  const readFlag = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  return {
    command,
    category: readFlag('--category'),
    datasetPath: readFlag('--dataset') ?? DEFAULT_DATASET_PATH,
  };
}

// ── Dataset load (sha256-pinned) ──────────────────────────────────────────────

function loadPinnedDataset(datasetPath: string): LmeQuestion[] {
  if (!existsSync(datasetPath)) {
    throw new Error(
      `Dataset not found: ${datasetPath} — pinned LongMemEval-S file ` +
        '(bead llmems-yn7; see docs/benchmark.md).',
    );
  }
  const raw = readFileSync(datasetPath);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== LONGMEMEVAL_S_SHA256) {
    throw new Error(
      `Dataset sha256 mismatch at ${datasetPath}: got ${sha256}, pinned ${LONGMEMEVAL_S_SHA256} ` +
        '(bead llmems-yn7). Results on an unpinned file are non-comparable — aborting.',
    );
  }
  return parseDataset(JSON.parse(raw.toString('utf8')));
}

function writeReport(name: string, report: unknown): string {
  mkdirSync('sandboxes', { recursive: true });
  const file = `sandboxes/${name}.json`;
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

function suffix(category: string | undefined): string {
  return category === undefined ? 'full' : category;
}

// ── Shared store collaborators (seed + recall) ───────────────────────────────

function buildStoreCollaborators(postgresUrl: string) {
  const pool = new Pool({ connectionString: postgresUrl });
  const store = new PostgresMemStore(postgresUrl);

  /** All session ids in the benchmark memstore, via the provenance markers. */
  const storedSessionIds = async (): Promise<Set<string>> => {
    const memstore = await pool.query<{ id: number }>(
      'SELECT id FROM memstores WHERE name = $1',
      [LONGMEMEVAL_CONTEXT_ID],
    );
    const memstoreId = memstore.rows[0]?.id;
    if (memstoreId === undefined) return new Set();
    const result = await pool.query<{ head: string }>(
      'SELECT left(summary, $2) AS head FROM mems WHERE memstore_id = $1',
      [memstoreId, PROVENANCE_HEAD_CHARS],
    );
    // decodeProvenance throws on a marker-less mem — a foreign mem in this
    // dedicated memstore means pollution; abort loudly rather than mis-score.
    return new Set(result.rows.map((r) => decodeProvenance(r.head)));
  };

  const close = async (): Promise<void> => {
    await store.close();
    await pool.end();
  };

  return { pool, store, storedSessionIds, close };
}

function buildEmbedder() {
  const baseURL = requireEnv('BENCHMARK_LLM_BASE_URL');
  const apiKey = requireEnv('BENCHMARK_LLM_API_KEY');
  const model = requireEnv('BENCHMARK_EMBEDDING_MODEL');
  const openai = new OpenAI({ baseURL, apiKey });

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    const response = await openai.embeddings.create({ model, input: texts });
    const vectors = response.data.map((d) => d.embedding);
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== EXPECTED_DIMENSIONS) {
        throw new Error(
          `Embedding dimension mismatch: got ${Array.isArray(vector) ? vector.length : 'none'}, ` +
            `expected ${EXPECTED_DIMENSIONS} — BENCHMARK_EMBEDDING_MODEL is not in the expected space.`,
        );
      }
    }
    return vectors;
  };

  return { embedBatch, model, baseURL };
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdPreflight(questions: LmeQuestion[], args: CliArgs): number {
  const preflight = computePreflight(questions, args.category);
  console.log(`LongMemEval-S spend preflight (category: ${preflight.category ?? 'ALL'})`);
  console.log(`  questions selected: ${preflight.questionsSelected}`);
  console.log(`  questions scored (non-abstention denominator): ${preflight.questionsScored}`);
  console.log(`  unique sessions to embed: ${preflight.uniqueSessions}`);
  console.log(`  sessions truncated at embed time: ${preflight.truncatedSessions}`);
  console.log(`  estimated tokens (sessions + questions): ${preflight.estimatedTokens}`);
  console.log(`  projected cost: $${preflight.projectedUsd.toFixed(4)}`);

  const budgetRaw = process.env['LLMEMS_BENCH_BUDGET_USD'];
  if (budgetRaw !== undefined && budgetRaw !== '') {
    const budgetUsd = requireEnvNumber('LLMEMS_BENCH_BUDGET_USD');
    assertBudget(preflight.projectedUsd, budgetUsd);
    console.log(`  budget gate: PASS (within $${budgetUsd.toFixed(4)})`);
  } else {
    console.log('  budget gate: not evaluated (LLMEMS_BENCH_BUDGET_USD unset) — seed WILL require it');
  }

  const file = writeReport(`longmemeval-preflight-${suffix(args.category)}`, preflight);
  console.log(`Preflight written: ${file}`);
  return 0;
}

async function cmdSeed(questions: LmeQuestion[], args: CliArgs): Promise<number> {
  const postgresUrl = requireEnv('POSTGRES_URL');
  const budgetUsd = requireEnvNumber('LLMEMS_BENCH_BUDGET_USD');
  const embedder = buildEmbedder();
  const collab = buildStoreCollaborators(postgresUrl);

  try {
    const report = await runSeed({
      questions,
      ...(args.category !== undefined ? { category: args.category } : {}),
      budgetUsd,
      batchSize: SEED_BATCH_SIZE,
      log: (message) => console.log(message),
      ports: {
        embedBatch: embedder.embedBatch,
        existingSessionIds: collab.storedSessionIds,
        storeMems: async (mems) => {
          await collab.store.applyBackgroundResult(
            mems.map((m) => ({
              summary: m.summary,
              chunkIds: [],
              embeddings: { full: m.embedding },
            })),
            [],
            null,
            LONGMEMEVAL_CONTEXT_ID,
          );
        },
      },
    });

    // Implementation-sanity: ingested-session count vs expected, post-write.
    const storedAfter = await collab.storedSessionIds();
    if (storedAfter.size < report.alreadyPresent + report.embedded) {
      throw new Error(
        `SEED SANITY FAILED: store has ${storedAfter.size} sessions, expected at least ` +
          `${report.alreadyPresent + report.embedded} — ingestion lost rows.`,
      );
    }

    const file = writeReport(`longmemeval-seed-${suffix(args.category)}`, {
      contextId: LONGMEMEVAL_CONTEXT_ID,
      datasetSha256: LONGMEMEVAL_S_SHA256,
      embedding: { model: embedder.model, baseURL: embedder.baseURL, dimensions: EXPECTED_DIMENSIONS },
      storedSessionsAfterSeed: storedAfter.size,
      ...report,
    });
    console.log(
      `seed done: ${report.embedded} embedded (+${report.alreadyPresent} already present, ` +
        `${report.truncated} truncated), store now holds ${storedAfter.size} sessions`,
    );
    console.log(`Seed report written: ${file}`);
    return 0;
  } finally {
    await collab.close();
  }
}

async function cmdRecall(questions: LmeQuestion[], args: CliArgs): Promise<number> {
  const postgresUrl = requireEnv('POSTGRES_URL');
  const budgetUsd = requireEnvNumber('LLMEMS_BENCH_BUDGET_USD');
  const embedder = buildEmbedder();
  const collab = buildStoreCollaborators(postgresUrl);

  try {
    const result = await runRecallScoring({
      questions,
      ...(args.category !== undefined ? { category: args.category } : {}),
      budgetUsd,
      log: (message) => console.log(message),
      ports: {
        embedQuestion: async (text) => (await embedder.embedBatch([text]))[0]!,
        searchMems: (vector, fetchK) =>
          collab.store.searchMemsByVector(vector, fetchK, LONGMEMEVAL_CONTEXT_ID),
        storedSessionIds: collab.storedSessionIds,
      },
    });

    const file = writeReport(`longmemeval-recall-${suffix(args.category)}`, {
      contextId: LONGMEMEVAL_CONTEXT_ID,
      datasetSha256: LONGMEMEVAL_S_SHA256,
      embedding: { model: embedder.model, baseURL: embedder.baseURL, dimensions: EXPECTED_DIMENSIONS },
      category: args.category ?? null,
      ...result,
    });

    const a = result.aggregate;
    console.log('');
    console.log(`LongMemEval-S retrieval-only (${a.scored} scored, ${a.abstentionExcluded} abstention excluded):`);
    console.log(`  recall_any@10 = ${a.recallAnyAt10.toFixed(3)}  (primary)`);
    console.log(`  recall_any@5  = ${a.recallAnyAt5.toFixed(3)}`);
    console.log(`  recall_any@20 = ${a.recallAnyAt20.toFixed(3)}`);
    console.log(`  recall_any@30 = ${a.recallAnyAt30.toFixed(3)}`);
    for (const [type, bucket] of Object.entries(a.byCategory)) {
      console.log(
        `    ${type}: @10=${bucket.recallAnyAt10.toFixed(3)} @20=${bucket.recallAnyAt20.toFixed(3)} ` +
          `@30=${bucket.recallAnyAt30.toFixed(3)} @5=${bucket.recallAnyAt5.toFixed(3)} (n=${bucket.scored})`,
      );
    }
    console.log(
      `  sanity: ${result.sanity.storedSessions} stored / ${result.sanity.expectedSessions} expected sessions, ` +
        'all evidence present',
    );
    console.log(`Results written: ${file}`);
    return 0;
  } finally {
    await collab.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const questions = loadPinnedDataset(args.datasetPath);
  console.log(`Dataset: ${args.datasetPath} (${questions.length} questions, sha256 verified)`);

  if (args.command === 'preflight') return cmdPreflight(questions, args);
  if (args.command === 'seed') return cmdSeed(questions, args);
  return cmdRecall(questions, args);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`LONGMEMEVAL FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
