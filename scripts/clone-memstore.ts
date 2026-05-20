// scripts/clone-memstore.ts
// Clones a memstore (registry row + all mems + all mem_chunks) to a new memstore,
// assigning new IDs and remapping mems.chunk_ids to the new chunk IDs.
// mem_projections and mem_edges are NOT copied — they are regenerated for the new arm.
//
// Usage (CLI args take priority over env vars):
//   npx tsx scripts/clone-memstore.ts <source_id> <target_name>
//   SOURCE_MEMSTORE_ID=4 TARGET_MEMSTORE_NAME="benchmark-katya-year-mece" npx tsx scripts/clone-memstore.ts
//
// Env vars:
//   POSTGRES_URL            — DB connection (default: branch DB)
//   SOURCE_MEMSTORE_ID      — integer ID of the source memstore
//   TARGET_MEMSTORE_NAME    — name for the new cloned memstore
//
// Fails fast if:
//   - source memstore does not exist
//   - target name already exists in memstores table
//   - any integrity constraint is violated

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { remapChunkIds } from '../src/shared/remap.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const POSTGRES_URL = process.env['POSTGRES_URL'] ??
  'postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems_axis_projections';

/**
 * Parse CLI args or fall back to env vars.
 * CLI args: clone-memstore.ts <source_id> <target_name>
 */
function parseArgs(): { sourceId: number; targetName: string } {
  const cliArgs = process.argv.slice(2);

  let sourceId: number;
  let targetName: string;

  if (cliArgs.length >= 2) {
    // CLI mode: <source_id> <target_name>
    const rawId = cliArgs[0] as string;
    const parsed = parseInt(rawId, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== rawId.trim()) {
      throw new Error(`CLI arg 1 (source_id) must be a valid integer, got: "${rawId}"`);
    }
    sourceId = parsed;
    targetName = (cliArgs[1] as string).trim();
    if (targetName === '') {
      throw new Error('CLI arg 2 (target_name) must not be empty');
    }
  } else {
    // Env var mode
    const rawSourceId = process.env['SOURCE_MEMSTORE_ID'];
    if (rawSourceId === undefined || rawSourceId === '') {
      throw new Error(
        'SOURCE_MEMSTORE_ID env var is required (or pass <source_id> <target_name> as CLI args)',
      );
    }
    const parsed = parseInt(rawSourceId, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== rawSourceId.trim()) {
      throw new Error(`SOURCE_MEMSTORE_ID must be a valid integer, got: "${rawSourceId}"`);
    }
    sourceId = parsed;

    const rawTargetName = process.env['TARGET_MEMSTORE_NAME'];
    if (rawTargetName === undefined || rawTargetName === '') {
      throw new Error(
        'TARGET_MEMSTORE_NAME env var is required (or pass <source_id> <target_name> as CLI args)',
      );
    }
    targetName = rawTargetName.trim();
  }

  return { sourceId, targetName };
}

// ── Clone logic ────────────────────────────────────────────────────────────────

interface MemstoreRow {
  id: number;
  name: string;
  general_summary: string | null;
  behavior_instructions: string | null;
}

interface MemRow {
  id: number;
  memstore_id: number;
  summary: string;
  chunk_ids: number[] | null;
  embedding: unknown;
  closed_at: Date | null;
}

interface ChunkRow {
  id: number;
  memstore_id: number;
  content: string;
  timestamp: Date | null;
  status: string;
}

async function cloneMemstore(
  client: PoolClient,
  sourceId: number,
  targetName: string,
): Promise<{ targetId: number; memCount: number; chunkCount: number }> {
  // 1. Verify source exists
  const sourceResult = await client.query<MemstoreRow>(
    'SELECT id, name, general_summary, behavior_instructions FROM memstores WHERE id = $1',
    [sourceId],
  );
  if (sourceResult.rows.length === 0) {
    throw new Error(`Source memstore with id=${sourceId} does not exist`);
  }
  const source = sourceResult.rows[0] as MemstoreRow;
  console.log(`Source memstore: id=${source.id}, name="${source.name}"`);

  // 2. Fail fast if target name already exists
  const existsResult = await client.query<{ id: number }>(
    'SELECT id FROM memstores WHERE name = $1',
    [targetName],
  );
  if (existsResult.rows.length > 0) {
    throw new Error(
      `Target memstore name "${targetName}" already exists (id=${existsResult.rows[0]?.id}). ` +
      'Refusing to overwrite. Drop the existing memstore first if intentional.',
    );
  }

  // 3. Clone memstore registry row
  const newMemstoreResult = await client.query<{ id: number }>(
    `INSERT INTO memstores (name, general_summary, behavior_instructions)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [targetName, source.general_summary, source.behavior_instructions],
  );
  const targetId = (newMemstoreResult.rows[0] as { id: number }).id;
  console.log(`Created target memstore: id=${targetId}, name="${targetName}"`);

  // 4. Load all source mem_chunks
  const chunksResult = await client.query<ChunkRow>(
    `SELECT id, memstore_id, content, timestamp, status
     FROM mem_chunks
     WHERE memstore_id = $1
     ORDER BY id`,
    [sourceId],
  );
  const sourceChunks = chunksResult.rows;
  console.log(`Loaded ${sourceChunks.length} mem_chunks from source.`);

  // 5. Insert chunks into target memstore and build old→new ID map
  const chunkIdMap = new Map<number, number>();
  for (const chunk of sourceChunks) {
    const insertResult = await client.query<{ id: number }>(
      `INSERT INTO mem_chunks (memstore_id, content, timestamp, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [targetId, chunk.content, chunk.timestamp, chunk.status],
    );
    const newChunkId = (insertResult.rows[0] as { id: number }).id;
    chunkIdMap.set(chunk.id, newChunkId);
  }
  console.log(`Inserted ${chunkIdMap.size} mem_chunks into target.`);

  // 6. Load all source mems
  const memsResult = await client.query<MemRow>(
    `SELECT id, memstore_id, summary, chunk_ids, embedding, closed_at
     FROM mems
     WHERE memstore_id = $1
     ORDER BY id`,
    [sourceId],
  );
  const sourceMems = memsResult.rows;
  console.log(`Loaded ${sourceMems.length} mems from source.`);

  // 7. Insert mems into target memstore with remapped chunk_ids
  for (const mem of sourceMems) {
    const newChunkIds = remapChunkIds(mem.chunk_ids, chunkIdMap);
    await client.query(
      `INSERT INTO mems (memstore_id, summary, chunk_ids, embedding, closed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [targetId, mem.summary, newChunkIds, mem.embedding, mem.closed_at],
    );
  }
  console.log(`Inserted ${sourceMems.length} mems into target.`);

  return {
    targetId,
    memCount: sourceMems.length,
    chunkCount: sourceChunks.length,
  };
}

// ── Post-clone integrity check ─────────────────────────────────────────────────

interface IntegrityReport {
  sourceMems: number;
  targetMems: number;
  sourceChunks: number;
  targetChunks: number;
  allChunkIdsResolved: boolean;
  issues: string[];
}

async function verifyIntegrity(
  client: PoolClient,
  sourceId: number,
  targetId: number,
): Promise<IntegrityReport> {
  const issues: string[] = [];

  const sourceMemCount = (await client.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM mems WHERE memstore_id = $1',
    [sourceId],
  )).rows[0]?.count ?? '0';

  const targetMemCount = (await client.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM mems WHERE memstore_id = $1',
    [targetId],
  )).rows[0]?.count ?? '0';

  const sourceChunkCount = (await client.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM mem_chunks WHERE memstore_id = $1',
    [sourceId],
  )).rows[0]?.count ?? '0';

  const targetChunkCount = (await client.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM mem_chunks WHERE memstore_id = $1',
    [targetId],
  )).rows[0]?.count ?? '0';

  if (sourceMemCount !== targetMemCount) {
    issues.push(`Mem count mismatch: source=${sourceMemCount}, target=${targetMemCount}`);
  }
  if (sourceChunkCount !== targetChunkCount) {
    issues.push(`Chunk count mismatch: source=${sourceChunkCount}, target=${targetChunkCount}`);
  }

  // Verify chunk_ids integrity: every chunk ID referenced in target mems
  // must exist in target mem_chunks with the correct memstore_id
  const orphanResult = await client.query<{ bad_chunk_id: number; mem_id: number }>(
    `SELECT unnested_id AS bad_chunk_id, m.id AS mem_id
     FROM mems m
     CROSS JOIN LATERAL unnest(m.chunk_ids) AS unnested_id
     LEFT JOIN mem_chunks mc
       ON mc.id = unnested_id AND mc.memstore_id = m.memstore_id
     WHERE m.memstore_id = $1
       AND mc.id IS NULL`,
    [targetId],
  );

  if (orphanResult.rows.length > 0) {
    for (const row of orphanResult.rows) {
      issues.push(
        `chunk_id ${row.bad_chunk_id} in mem ${row.mem_id} not found in target mem_chunks`,
      );
    }
  }

  return {
    sourceMems: parseInt(sourceMemCount, 10),
    targetMems: parseInt(targetMemCount, 10),
    sourceChunks: parseInt(sourceChunkCount, 10),
    targetChunks: parseInt(targetChunkCount, 10),
    allChunkIdsResolved: orphanResult.rows.length === 0,
    issues,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sourceId, targetName } = parseArgs();

  console.log('=== Clone Memstore ===');
  console.log(`Source memstore ID: ${sourceId}`);
  console.log(`Target memstore name: "${targetName}"`);
  console.log('');

  const pool = new Pool({ connectionString: POSTGRES_URL });

  // Verify connection
  const versionRow = await pool.query<{ version: string }>('SELECT version()');
  console.log(
    `PostgreSQL: ${versionRow.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? 'unknown'}`,
  );
  console.log('');

  const client = await pool.connect();
  let targetId: number;

  try {
    await client.query('BEGIN');

    const result = await cloneMemstore(client, sourceId, targetName);
    targetId = result.targetId;

    await client.query('COMMIT');
    console.log('');
    console.log('Transaction committed.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Post-clone integrity verification (outside transaction, read-only)
  console.log('');
  console.log('=== Post-Clone Integrity Check ===');
  const verifyClient = await pool.connect();
  let report: IntegrityReport;
  try {
    report = await verifyIntegrity(verifyClient, sourceId, targetId);
  } finally {
    verifyClient.release();
  }

  console.log(`Source mems:   ${report.sourceMems}`);
  console.log(`Target mems:   ${report.targetMems}`);
  console.log(`Source chunks: ${report.sourceChunks}`);
  console.log(`Target chunks: ${report.targetChunks}`);
  console.log(`chunk_ids integrity: ${report.allChunkIdsResolved ? 'OK' : 'FAIL'}`);

  if (report.issues.length > 0) {
    console.error('');
    console.error('INTEGRITY ISSUES:');
    for (const issue of report.issues) {
      console.error(`  - ${issue}`);
    }
    await pool.end();
    process.exit(1);
  }

  console.log('');
  console.log('=== Result ===');
  console.log(`Target memstore ID: ${targetId}`);
  console.log(`Target memstore name: "${targetName}"`);
  console.log(`Mems cloned: ${report.targetMems}`);
  console.log(`Chunks cloned: ${report.targetChunks}`);
  console.log('All integrity checks passed.');

  await pool.end();
}

main().catch((e: unknown) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
