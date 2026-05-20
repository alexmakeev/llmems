// scripts/re-extract-projections.ts
// Re-extracts semantic projections for all mems in memstore_id=4,
// deletes old projections, embeds new ones, and saves to DB.
//
// Usage:
//   OPENROUTER_API_KEY=<key> npx tsx scripts/re-extract-projections.ts
//
// Env vars:
//   POSTGRES_URL       — DB connection (default: branch DB)
//   OPENROUTER_API_KEY — required for Gemini extraction and OpenAI embeddings

import { Pool } from 'pg';

import { ProjectionExtractor } from '../src/services/graph/projection-extractor.js';
import { GraphEmbeddingService } from '../src/services/graph/embedding-service.js';
import { GraphStore } from '../src/services/graph/graph-store.js';
import { SEMANTIC_AXES } from '../src/services/graph/types.js';
import type { SemanticAxis, MemProjection } from '../src/services/graph/types.js';
import { requireEnvInt } from '../src/shared/env.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const POSTGRES_URL = process.env['POSTGRES_URL'] ??
  'postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems_axis_projections';

const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'] ?? '';
if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY is required');
  process.exit(1);
}

const MEMSTORE_ID = requireEnvInt('MEMSTORE_ID');
const GEMINI_MODEL = 'google/gemini-2.5-flash';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Re-Extract Projections ===');
  console.log(`Memstore ID: ${MEMSTORE_ID}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Embedding model: ${EMBEDDING_MODEL}`);
  console.log('');

  const pool = new Pool({ connectionString: POSTGRES_URL });

  // Verify connection
  const versionRow = await pool.query<{ version: string }>('SELECT version()');
  console.log(`PostgreSQL: ${versionRow.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? 'unknown'}`);

  // Load all mems for memstore_id=4
  const memsResult = await pool.query<{ id: number; summary: string }>(
    `SELECT id, summary FROM mems WHERE memstore_id = $1 ORDER BY id`,
    [MEMSTORE_ID],
  );
  const mems = memsResult.rows;
  console.log(`Loaded ${mems.length} mems.`);
  console.log('');

  if (mems.length === 0) {
    console.log('No mems to process. Exiting.');
    await pool.end();
    return;
  }

  const memIds = mems.map(m => m.id);

  // Delete all existing projections for these mems
  console.log('Deleting existing projections...');
  const deleteResult = await pool.query(
    `DELETE FROM mem_projections WHERE mem_id = ANY($1::int[])`,
    [memIds],
  );
  console.log(`Deleted ${deleteResult.rowCount ?? 0} projections.`);
  console.log('');

  // Instantiate services
  const extractor = new ProjectionExtractor({
    geminiApiKey: undefined,          // use OpenRouter fallback
    openaiApiKey: OPENROUTER_API_KEY,
    geminiModel: GEMINI_MODEL,
  });

  const embedder = new GraphEmbeddingService({
    openaiApiKey: OPENROUTER_API_KEY,
    openaiBaseUrl: OPENROUTER_BASE_URL,
    openaiModel: EMBEDDING_MODEL,
  });

  const store = new GraphStore(pool);

  // Per-axis counters for summary
  const axisCounters = new Map<SemanticAxis, number>();
  for (const axis of SEMANTIC_AXES) {
    axisCounters.set(axis, 0);
  }

  let totalProjections = 0;
  let memsProcessed = 0;
  let memsErrored = 0;

  // Process each mem
  for (let i = 0; i < mems.length; i++) {
    const mem = mems[i];
    if (mem === undefined) continue;

    const memText = mem.summary;

    // Step 1: Extract projections via Gemini
    const extractResult = await extractor.extractProjections(String(mem.id), memText);
    if (!extractResult.ok) {
      console.error(`  ERROR extracting mem ${mem.id}: ${extractResult.error.message}`);
      memsErrored++;
      continue;
    }
    const projections = extractResult.value;

    if (projections.length === 0) {
      console.log(`Processed mem ${mem.id} (${i + 1}/${mems.length}): 0 projections (none extracted)`);
      memsProcessed++;
      continue;
    }

    // Step 2: Embed all projection texts in one batch
    const texts = projections.map(p => p.text);
    const embedResult = await embedder.embedTexts(texts);
    if (!embedResult.ok) {
      console.error(`  ERROR embedding mem ${mem.id}: ${embedResult.error.message}`);
      memsErrored++;
      continue;
    }
    const embeddings = embedResult.value;

    // Step 3: Attach embeddings to projections
    const projsWithEmbeddings: MemProjection[] = projections.map((proj, idx) => {
      const embedding = embeddings[idx];
      return embedding !== undefined ? { ...proj, embedding } : proj;
    });

    // Step 4: Save projections to DB
    const saveResult = await store.saveProjections(projsWithEmbeddings, MEMSTORE_ID);
    if (!saveResult.ok) {
      console.error(`  ERROR saving mem ${mem.id}: ${saveResult.error.message}`);
      memsErrored++;
      continue;
    }

    // Update counters
    for (const proj of projsWithEmbeddings) {
      axisCounters.set(proj.axis, (axisCounters.get(proj.axis) ?? 0) + 1);
    }
    totalProjections += projsWithEmbeddings.length;
    memsProcessed++;

    console.log(`Processed mem ${mem.id} (${i + 1}/${mems.length}): ${projsWithEmbeddings.length} projections`);
  }

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`Total mems processed:   ${memsProcessed}`);
  console.log(`Total mems errored:     ${memsErrored}`);
  console.log(`Total projections created: ${totalProjections}`);
  console.log('');
  console.log('Per-axis counts:');
  for (const axis of SEMANTIC_AXES) {
    const count = axisCounters.get(axis) ?? 0;
    console.log(`  ${axis.padEnd(12)}: ${count}`);
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
