// src/services/postgres-mem-store.ts
// PostgreSQL + pgvector implementation of IMemStore.
// Persists active chunks, closed mems, and general summary across process restarts.

import { Pool } from 'pg';
import pgvector from 'pgvector/pg';
import type { MemChunk, Mem, MemContextData, IMemStore } from '../types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse a pgvector value returned from the DB.
 * pgvector returns vectors as strings like "[1.0,2.0,3.0]" when not parsed automatically.
 * With pgvector.registerType() it may return an array directly.
 */
function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(Number);
  }
  return [];
}

/**
 * Map a DB row from mems table to the Mem type.
 */
function rowToMem(row: {
  id: number;
  summary: string;
  chunk_ids: number[] | null;
  embedding: unknown;
  embedding_compact: unknown;
  embedding_micro: unknown;
  closed_at: Date;
}): Mem {
  return {
    id: String(row.id),
    summary: row.summary,
    chunkIds: (row.chunk_ids ?? []).map(String),
    embeddings: {
      full: parseVector(row.embedding),
      compact: parseVector(row.embedding_compact),
      micro: parseVector(row.embedding_micro),
    },
    closedAt: row.closed_at,
  };
}

/**
 * Map a DB row from mem_chunks table to the MemChunk type.
 */
function rowToMemChunk(row: { id: number; content: string; timestamp: Date }): MemChunk {
  return {
    id: String(row.id),
    content: row.content,
    timestamp: row.timestamp,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// PostgresMemStore
// ──────────────────────────────────────────────────────────────────────────────

/**
 * PostgreSQL + pgvector implementation of IMemStore.
 *
 * contextId maps to memstores.name (human-readable string, UNIQUE).
 * The numeric memstores.id is cached in-memory for performance.
 *
 * Schema (must exist):
 *   memstores(id, name, general_summary, created_at)
 *   mems(id, memstore_id, summary, chunk_ids, embedding, embedding_compact, embedding_micro, closed_at)
 *   mem_chunks(id, memstore_id, content, timestamp, status)
 */
export class PostgresMemStore implements IMemStore {
  private readonly pool: Pool;
  /** Cache: contextId (memstore name) → memstores.id */
  private readonly memstoreIdCache = new Map<string, number>();

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    // NOTE: pgvector.registerType is NOT called on pool connect events.
    // The async registerType call conflicts with pg@8's connection lifecycle,
    // causing concurrent query warnings and potential deadlocks.
    // Instead, parseVector() handles raw string vectors returned by PostgreSQL.
  }

  /**
   * Drain the connection pool. Call on application shutdown.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private: resolve contextId → memstore row id
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Resolve contextId to memstores.id, creating the row if it does not exist.
   * Result is cached in-memory to avoid repeated DB lookups.
   */
  private async resolveMemstoreId(contextId: string): Promise<number> {
    const cached = this.memstoreIdCache.get(contextId);
    if (cached !== undefined) return cached;

    const client = await this.pool.connect();
    try {
      // Create row if not exists
      await client.query(
        `INSERT INTO memstores (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [contextId],
      );

      const result = await client.query<{ id: number }>(
        `SELECT id FROM memstores WHERE name = $1`,
        [contextId],
      );

      const id = result.rows[0]!.id;
      this.memstoreIdCache.set(contextId, id);
      return id;
    } finally {
      client.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // IMemStore implementation
  // ──────────────────────────────────────────────────────────────────────────

  async addChunk(content: string, timestamp: Date, contextId: string): Promise<MemChunk> {
    const memstoreId = await this.resolveMemstoreId(contextId);

    const result = await this.pool.query<{ id: number; content: string; timestamp: Date }>(
      `INSERT INTO mem_chunks (memstore_id, content, timestamp, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, content, timestamp`,
      [memstoreId, content, timestamp],
    );

    return rowToMemChunk(result.rows[0]!);
  }

  async getActiveChunks(contextId: string): Promise<MemChunk[]> {
    const memstoreId = await this.resolveMemstoreId(contextId);

    const result = await this.pool.query<{ id: number; content: string; timestamp: Date }>(
      `SELECT id, content, timestamp
       FROM mem_chunks
       WHERE memstore_id = $1 AND status = 'active'
       ORDER BY timestamp ASC`,
      [memstoreId],
    );

    return result.rows.map(rowToMemChunk);
  }

  async getClosedMems(contextId: string, limit?: number): Promise<Mem[]> {
    const memstoreId = await this.resolveMemstoreId(contextId);

    const queryText = limit !== undefined
      ? `SELECT id, summary, chunk_ids, embedding, embedding_compact, embedding_micro, closed_at
         FROM mems
         WHERE memstore_id = $1
         ORDER BY closed_at DESC
         LIMIT $2`
      : `SELECT id, summary, chunk_ids, embedding, embedding_compact, embedding_micro, closed_at
         FROM mems
         WHERE memstore_id = $1
         ORDER BY closed_at DESC`;

    const params = limit !== undefined ? [memstoreId, limit] : [memstoreId];
    const result = await this.pool.query(queryText, params);

    // DESC order gives newest first — reverse to get chronological order (oldest first)
    // so callers see [S1, S2, S3] matching InMemoryMemStore behavior
    return result.rows.map(rowToMem).reverse();
  }

  async getGeneralSummary(contextId: string): Promise<string> {
    const result = await this.pool.query<{ general_summary: string }>(
      `SELECT general_summary FROM memstores WHERE name = $1`,
      [contextId],
    );

    return result.rows[0]?.general_summary ?? '';
  }

  async updateGeneralSummary(summary: string, contextId: string): Promise<void> {
    await this.resolveMemstoreId(contextId); // ensure row exists

    await this.pool.query(
      `UPDATE memstores SET general_summary = $1 WHERE name = $2`,
      [summary, contextId],
    );
  }

  async getBehaviorInstructions(contextId: string): Promise<string> {
    const result = await this.pool.query<{ behavior_instructions: string }>(
      `SELECT behavior_instructions FROM memstores WHERE name = $1`,
      [contextId],
    );

    return result.rows[0]?.behavior_instructions ?? '';
  }

  async setBehaviorInstructions(instructions: string, contextId: string): Promise<void> {
    await this.resolveMemstoreId(contextId); // ensure row exists

    await this.pool.query(
      `UPDATE memstores SET behavior_instructions = $1 WHERE name = $2`,
      [instructions, contextId],
    );
  }

  async removeOldestClosedMem(contextId: string): Promise<void> {
    const memstoreId = await this.resolveMemstoreId(contextId);

    await this.pool.query(
      `DELETE FROM mems
       WHERE id = (
         SELECT id FROM mems
         WHERE memstore_id = $1
         ORDER BY closed_at ASC
         LIMIT 1
       )`,
      [memstoreId],
    );
  }

  async getLastClosedMem(contextId: string): Promise<Mem | null> {
    const memstoreId = await this.resolveMemstoreId(contextId);

    const result = await this.pool.query(
      `SELECT id, summary, chunk_ids, embedding, embedding_compact, embedding_micro, closed_at
       FROM mems
       WHERE memstore_id = $1
       ORDER BY closed_at DESC
       LIMIT 1`,
      [memstoreId],
    );

    if (result.rows.length === 0) return null;
    return rowToMem(result.rows[0]);
  }

  /** Maximum number of closed mems loaded in buildMemContext to prevent unbounded queries. */
  private static readonly BUILD_CONTEXT_MEM_LIMIT = 100;

  async buildMemContext(contextId: string): Promise<MemContextData> {
    const [activeChunks, allClosed, generalSummary] = await Promise.all([
      this.getActiveChunks(contextId),
      this.getClosedMems(contextId, PostgresMemStore.BUILD_CONTEXT_MEM_LIMIT),
      this.getGeneralSummary(contextId),
    ]);

    let recentClosedMems: Mem[];
    let lastClosedMem: Mem | null;

    if (allClosed.length === 0) {
      recentClosedMems = [];
      lastClosedMem = null;
    } else {
      lastClosedMem = allClosed[allClosed.length - 1] ?? null;
      recentClosedMems = allClosed.slice(0, -1);
    }

    return {
      generalSummary,
      recentClosedMems,
      lastClosedMem,
      activeChunks,
    };
  }

  /**
   * Apply background summarization result in a single transaction:
   * 1. Insert new closed mems with embeddings
   * 2. Archive tail chunks (mark as 'archived')
   * 3. Update general summary (if provided)
   *
   * Follows the same ordering as InMemoryMemStore.applyBackgroundResult:
   * summary first → mems → archive chunks.
   */
  async applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] } }[],
    _tailChunkIds: string[],
    newGeneralSummary: string | null,
    contextId: string,
  ): Promise<void> {
    const memstoreId = await this.resolveMemstoreId(contextId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Update general summary FIRST (same ordering as InMemoryMemStore)
      if (newGeneralSummary !== null) {
        await client.query(
          `UPDATE memstores SET general_summary = $1 WHERE id = $2`,
          [newGeneralSummary, memstoreId],
        );
      }

      // 2. Insert closed mems
      // Collect all chunk IDs referenced by mems (for archiving)
      const allMemChunkIds = new Set<string>();

      for (const mem of mems) {
        const chunkIdsInt = mem.chunkIds.map(Number);

        for (const id of mem.chunkIds) {
          allMemChunkIds.add(id);
        }

        const embeddingFull = mem.embeddings.full.length > 0
          ? pgvector.toSql(mem.embeddings.full)
          : null;
        const embeddingCompact = mem.embeddings.compact.length > 0
          ? pgvector.toSql(mem.embeddings.compact)
          : null;
        const embeddingMicro = mem.embeddings.micro.length > 0
          ? pgvector.toSql(mem.embeddings.micro)
          : null;

        await client.query(
          `INSERT INTO mems (memstore_id, summary, chunk_ids, embedding, embedding_compact, embedding_micro)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [memstoreId, mem.summary, chunkIdsInt, embeddingFull, embeddingCompact, embeddingMicro],
        );
      }

      // 3. Archive ALL chunks referenced by mems
      // tailChunkIds are informational only — same behavior as InMemoryMemStore
      if (allMemChunkIds.size > 0) {
        const idsToArchive = Array.from(allMemChunkIds).map(Number);
        await client.query(
          `UPDATE mem_chunks SET status = 'archived'
           WHERE id = ANY($1::int[]) AND memstore_id = $2`,
          [idsToArchive, memstoreId],
        );
      }

      // tailChunkIds: archive them too (they are part of the mem's chunkIds per interface contract)
      // but they are already handled above via allMemChunkIds.
      // The parameter exists for forward compatibility; no separate action needed.

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
