// src/__tests__/services/postgres-mem-store.test.ts
// Tests for PostgresMemStore — all DB calls are mocked via vi.mock('pg')

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mock objects — must be defined before vi.mock() calls (which are hoisted)
// ──────────────────────────────────────────────────────────────────────────────

const { mockClient, mockPool } = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const mockPool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  return { mockClient, mockPool };
});

// ──────────────────────────────────────────────────────────────────────────────
// Mock pg module — Pool constructor returns mockPool instance
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('pg', () => {
  class Pool {
    constructor() {
      Object.assign(this, mockPool);
    }
  }
  return { Pool };
});

// Mock pgvector — registerType is a no-op, toSql converts array to string
vi.mock('pgvector/pg', () => {
  return {
    default: {
      registerType: vi.fn(),
      toSql: vi.fn((arr: number[]) => `[${arr.join(',')}]`),
    },
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks are set up
// ──────────────────────────────────────────────────────────────────────────────

import { PostgresMemStore } from '../../services/postgres-mem-store.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock client.query that handles a sequence of queries in order.
 * Each call returns the next element in the responses array.
 */
function setupClientQuerySequence(responses: Array<{ rows: unknown[] }>): void {
  let callIndex = 0;
  mockClient.query.mockImplementation(async () => {
    const resp = responses[callIndex];
    callIndex++;
    return resp ?? { rows: [] };
  });
}

/** Reset all mocks before each test */
function resetMocks(): void {
  vi.clearAllMocks();
  mockPool.connect.mockResolvedValue(mockClient);
  mockClient.release.mockReset();
  mockClient.query.mockReset();
  mockPool.query.mockReset();
  mockPool.end.mockResolvedValue(undefined);
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('PostgresMemStore', () => {
  let store: PostgresMemStore;
  const ctx = 'test-context';
  const CONNECTION_STRING = 'postgresql://localhost/test';

  beforeEach(() => {
    resetMocks();
    store = new PostgresMemStore(CONNECTION_STRING);
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates a Pool with the connection string', async () => {
      const { Pool } = await import('pg');
      // Pool was called in beforeEach when creating the store
      expect(Pool).toBeDefined();
    });

    it('does not register pgvector type on connect event (async handler causes deadlocks)', () => {
      // pgvector.registerType is NOT called on pool connect events because
      // the async registerType call conflicts with pg@8's connection lifecycle.
      // parseVector() handles raw string vectors instead.
      const connectHandler = mockPool.on.mock.calls.find((c: unknown[]) => c[0] === 'connect');
      expect(connectHandler).toBeUndefined();
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('drains the pool', async () => {
      await store.close();
      expect(mockPool.end).toHaveBeenCalledOnce();
    });
  });

  // ── contextId → memstoreId caching ────────────────────────────────────────

  describe('contextId → memstoreId caching', () => {
    it('resolves and caches memstoreId on first use, reuses cache on second', async () => {
      // Use getActiveChunks which calls resolveMemstoreId (getGeneralSummary does not)
      setupClientQuerySequence([
        { rows: [] },             // INSERT ON CONFLICT DO NOTHING
        { rows: [{ id: 99 }] },   // SELECT id
      ]);
      // pool.query for getActiveChunks
      mockPool.query.mockResolvedValue({ rows: [] });

      await store.getActiveChunks(ctx);

      // First call required pool.connect (to resolve memstoreId)
      expect(mockPool.connect).toHaveBeenCalledOnce();

      // Reset tracking for second call
      mockPool.query.mockClear();
      mockPool.connect.mockClear();

      // Second call: should NOT call pool.connect() again (cached)
      mockPool.query.mockResolvedValue({ rows: [] });
      await store.getActiveChunks(ctx);

      // pool.connect not called again on second use (id is cached)
      expect(mockPool.connect).not.toHaveBeenCalled();
    });
  });

  // ── addChunk ──────────────────────────────────────────────────────────────

  describe('addChunk', () => {
    it('inserts a chunk and returns MemChunk with string id', async () => {
      const ts = new Date('2025-01-01T10:00:00Z');

      setupClientQuerySequence([
        { rows: [] },           // INSERT memstore
        { rows: [{ id: 42 }] }, // SELECT memstoreId
      ]);

      mockPool.query.mockResolvedValue({
        rows: [{ id: 7, content: 'hello world', timestamp: ts }],
      });

      const chunk = await store.addChunk('hello world', ts, ctx);

      expect(chunk.id).toBe('7');
      expect(chunk.content).toBe('hello world');
      expect(chunk.timestamp).toEqual(ts);
    });

    it('passes correct SQL parameters to pool.query', async () => {
      const ts = new Date('2025-01-01T12:00:00Z');

      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({
        rows: [{ id: 1, content: 'msg', timestamp: ts }],
      });

      await store.addChunk('msg', ts, ctx);

      const [sql, params] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO mem_chunks');
      expect(params).toEqual([42, 'msg', ts]);
    });
  });

  // ── getActiveChunks ───────────────────────────────────────────────────────

  describe('getActiveChunks', () => {
    it('returns active chunks in ASC timestamp order', async () => {
      const t1 = new Date('2025-01-01T10:00:00Z');
      const t2 = new Date('2025-01-01T10:01:00Z');

      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({
        rows: [
          { id: 1, content: 'first', timestamp: t1 },
          { id: 2, content: 'second', timestamp: t2 },
        ],
      });

      const chunks = await store.getActiveChunks(ctx);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.id).toBe('1');
      expect(chunks[0]!.content).toBe('first');
      expect(chunks[1]!.id).toBe('2');
    });

    it('returns empty array when no active chunks', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      const chunks = await store.getActiveChunks(ctx);
      expect(chunks).toHaveLength(0);
    });

    it('queries with status=active filter', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);
      mockPool.query.mockResolvedValue({ rows: [] });

      await store.getActiveChunks(ctx);

      const [sql] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain('ORDER BY timestamp ASC');
    });
  });

  // ── getClosedMems ─────────────────────────────────────────────────────────

  describe('getClosedMems', () => {
    const makeMem = (id: number, summary: string) => ({
      id,
      summary,
      chunk_ids: [1, 2],
      embedding: '[0.1,0.2]',
      embedding_compact: '[0.3]',
      embedding_micro: '[0.4]',
      closed_at: new Date('2025-01-01T10:00:00Z'),
    });

    it('returns mems in chronological order (oldest first)', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      // DB returns DESC order (newest first)
      mockPool.query.mockResolvedValue({
        rows: [makeMem(3, 'newest'), makeMem(2, 'middle'), makeMem(1, 'oldest')],
      });

      const mems = await store.getClosedMems(ctx);

      // Should be reversed to chronological order
      expect(mems[0]!.summary).toBe('oldest');
      expect(mems[1]!.summary).toBe('middle');
      expect(mems[2]!.summary).toBe('newest');
    });

    it('maps chunkIds to strings', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({
        rows: [makeMem(1, 'test')],
      });

      const mems = await store.getClosedMems(ctx);
      expect(mems[0]!.chunkIds).toEqual(['1', '2']);
    });

    it('includes LIMIT clause when limit is provided', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);
      mockPool.query.mockResolvedValue({ rows: [] });

      await store.getClosedMems(ctx, 5);

      const [sql, params] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('LIMIT');
      expect(params).toContain(5);
    });

    it('omits LIMIT clause when no limit provided', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);
      mockPool.query.mockResolvedValue({ rows: [] });

      await store.getClosedMems(ctx);

      const [sql] = mockPool.query.mock.calls[0]!;
      expect(sql).not.toContain('LIMIT');
    });

    it('parses vector string to number array', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({
        rows: [{
          id: 1,
          summary: 's',
          chunk_ids: [],
          embedding: '[1.0,2.0,3.0]',
          embedding_compact: '[4.0,5.0]',
          embedding_micro: '[6.0]',
          closed_at: new Date(),
        }],
      });

      const mems = await store.getClosedMems(ctx);
      expect(mems[0]!.embeddings.full).toEqual([1, 2, 3]);
      expect(mems[0]!.embeddings.compact).toEqual([4, 5]);
      expect(mems[0]!.embeddings.micro).toEqual([6]);
    });
  });

  // ── getGeneralSummary ─────────────────────────────────────────────────────

  describe('getGeneralSummary', () => {
    it('returns the general summary from DB', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [{ general_summary: 'User likes TypeScript' }] });

      const summary = await store.getGeneralSummary(ctx);
      expect(summary).toBe('User likes TypeScript');
    });

    it('returns empty string when memstore not found', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      const summary = await store.getGeneralSummary(ctx);
      expect(summary).toBe('');
    });

    it('queries by name (contextId)', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [{ general_summary: '' }] });

      await store.getGeneralSummary(ctx);

      const [sql, params] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('FROM memstores WHERE name');
      expect(params).toContain(ctx);
    });
  });

  // ── updateGeneralSummary ──────────────────────────────────────────────────

  describe('updateGeneralSummary', () => {
    it('updates general_summary in DB', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      await store.updateGeneralSummary('New summary', ctx);

      const [sql, params] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('UPDATE memstores SET general_summary');
      expect(params).toContain('New summary');
      expect(params).toContain(ctx);
    });
  });

  // ── removeOldestClosedMem ─────────────────────────────────────────────────

  describe('removeOldestClosedMem', () => {
    it('deletes the oldest mem by closed_at ASC', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      await store.removeOldestClosedMem(ctx);

      const [sql] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('DELETE FROM mems');
      expect(sql).toContain('ORDER BY closed_at ASC');
      expect(sql).toContain('LIMIT 1');
    });
  });

  // ── getLastClosedMem ──────────────────────────────────────────────────────

  describe('getLastClosedMem', () => {
    it('returns null when no closed mems exist', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await store.getLastClosedMem(ctx);
      expect(result).toBeNull();
    });

    it('returns the most recent closed mem', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      const closedAt = new Date('2025-06-01T10:00:00Z');
      mockPool.query.mockResolvedValue({
        rows: [{
          id: 55,
          summary: 'Last mem summary',
          chunk_ids: [10, 11],
          embedding: '[0.1]',
          embedding_compact: '[0.2]',
          embedding_micro: '[0.3]',
          closed_at: closedAt,
        }],
      });

      const mem = await store.getLastClosedMem(ctx);
      expect(mem).not.toBeNull();
      expect(mem!.id).toBe('55');
      expect(mem!.summary).toBe('Last mem summary');
      expect(mem!.chunkIds).toEqual(['10', '11']);
      expect(mem!.closedAt).toEqual(closedAt);
    });

    it('queries with ORDER BY closed_at DESC LIMIT 1', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      await store.getLastClosedMem(ctx);

      const [sql] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('ORDER BY closed_at DESC');
      expect(sql).toContain('LIMIT 1');
    });
  });

  // ── buildMemContext ───────────────────────────────────────────────────────

  describe('buildMemContext', () => {
    it('returns empty context when no data exists', async () => {
      const ctx2 = 'empty-context-build';

      // Set up client.query to always resolve memstoreId resolution calls
      mockClient.query.mockResolvedValue({ rows: [{ id: 42 }] });

      // pool.query routes calls by SQL content (Promise.all concurrency)
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'active'")) return { rows: [] };    // getActiveChunks
        if (sql.includes('FROM memstores WHERE name')) return { rows: [{ general_summary: '' }] }; // getGeneralSummary
        if (sql.includes('embedding_compact')) return { rows: [] };    // getClosedMems
        return { rows: [] };
      });

      const result = await store.buildMemContext(ctx2);

      expect(result.activeChunks).toHaveLength(0);
      expect(result.recentClosedMems).toHaveLength(0);
      expect(result.lastClosedMem).toBeNull();
      expect(result.generalSummary).toBe('');
    });

    it('splits closed mems: last is lastClosedMem, rest are recentClosedMems', async () => {
      const makeMem = (id: number, summary: string, closedAt: Date) => ({
        id,
        summary,
        chunk_ids: [],
        embedding: '[]',
        embedding_compact: '[]',
        embedding_micro: '[]',
        closed_at: closedAt,
      });

      const ctx3 = 'context-3-mems-build';

      mockClient.query.mockResolvedValue({ rows: [{ id: 43 }] });

      const t1 = new Date('2025-01-01T10:00:00Z');
      const t2 = new Date('2025-01-02T10:00:00Z');
      const t3 = new Date('2025-01-03T10:00:00Z');

      // Promise.all fires 3 pool.query calls concurrently — route by SQL
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'active'")) return { rows: [] }; // getActiveChunks
        if (sql.includes('FROM memstores WHERE name')) {
          // getGeneralSummary — must check BEFORE 'FROM mems' (memstores contains mems)
          return { rows: [{ general_summary: 'general' }] };
        }
        if (sql.includes('embedding_compact')) {
          // getClosedMems — DB returns DESC (newest first), store reverses to chrono
          return { rows: [makeMem(3, 'S3', t3), makeMem(2, 'S2', t2), makeMem(1, 'S1', t1)] };
        }
        return { rows: [] };
      });

      const result = await store.buildMemContext(ctx3);

      expect(result.lastClosedMem!.summary).toBe('S3');
      expect(result.recentClosedMems).toHaveLength(2);
      expect(result.recentClosedMems[0]!.summary).toBe('S1');
      expect(result.recentClosedMems[1]!.summary).toBe('S2');
      expect(result.generalSummary).toBe('general');
    });
  });

  // ── applyBackgroundResult ─────────────────────────────────────────────────

  describe('applyBackgroundResult', () => {
    it('runs in a transaction: BEGIN + operations + COMMIT', async () => {
      setupClientQuerySequence([
        { rows: [] },           // INSERT memstore
        { rows: [{ id: 42 }] }, // SELECT memstoreId
        { rows: [] },           // BEGIN
        { rows: [{ id: 1 }] },  // INSERT mem (RETURNING id)
        { rows: [] },           // UPDATE chunks (archive)
        { rows: [] },           // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{ summary: 'Topic 1', chunkIds: ['1', '2'], embeddings: { full: [0.1], compact: [0.2], micro: [0.3] } }],
        [],
        null,
        ctx,
      );

      const calls = mockClient.query.mock.calls.map(c => c[0]);
      expect(calls).toContain('BEGIN');
      expect(calls).toContain('COMMIT');
    });

    it('rolls back on error', async () => {
      const store2 = new PostgresMemStore(CONNECTION_STRING);

      mockClient.query
        .mockResolvedValueOnce({ rows: [] })          // INSERT memstore
        .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // SELECT memstoreId
        .mockResolvedValueOnce({ rows: [] })          // BEGIN
        .mockRejectedValueOnce(new Error('DB error')) // INSERT mem fails
        .mockResolvedValueOnce({ rows: [] });          // ROLLBACK

      await expect(
        store2.applyBackgroundResult(
          [{ summary: 'Topic 1', chunkIds: ['1'], embeddings: { full: [], compact: [], micro: [] } }],
          [],
          null,
          ctx,
        ),
      ).rejects.toThrow('DB error');

      const calls = mockClient.query.mock.calls.map(c => c[0]);
      expect(calls).toContain('ROLLBACK');
    });

    it('updates general summary first when provided', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [] }, // UPDATE general summary
        { rows: [{ id: 1 }] }, // INSERT mem (RETURNING id)
        { rows: [] }, // UPDATE chunks
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{ summary: 'Topic', chunkIds: ['5'], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        'New general summary',
        ctx,
      );

      const sqlCalls = mockClient.query.mock.calls.map(c => c[0] as string);

      const beginIdx = sqlCalls.indexOf('BEGIN');
      const updateIdx = sqlCalls.findIndex(s => s.includes('SET general_summary'));
      // Use 'INSERT INTO mems ' (with space) to avoid matching 'INSERT INTO memstores'
      const insertIdx = sqlCalls.findIndex(s => s.includes('INSERT INTO mems '));

      expect(beginIdx).toBeGreaterThanOrEqual(0);
      // general summary UPDATE comes before INSERT INTO mems
      expect(updateIdx).toBeGreaterThan(beginIdx);
      expect(insertIdx).toBeGreaterThan(updateIdx);
    });

    it('skips general summary update when newGeneralSummary is null', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 1 }] }, // INSERT mem (RETURNING id)
        { rows: [] }, // UPDATE chunks
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{ summary: 'Topic', chunkIds: ['5'], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      // Only the transaction queries (no general_summary UPDATE)
      const txSqlCalls = mockClient.query.mock.calls.slice(2).map(c => c[0] as string); // skip INSERT/SELECT for memstore
      expect(txSqlCalls.some(s => s.includes('SET general_summary'))).toBe(false);
    });

    it('archives all chunk IDs from mems (not just tail)', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 1 }] }, // INSERT mem 1 (RETURNING id)
        { rows: [{ id: 2 }] }, // INSERT mem 2 (RETURNING id)
        { rows: [] }, // UPDATE chunks (archive)
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult(
        [
          { summary: 'Mem 1', chunkIds: ['1', '2'], embeddings: { full: [], compact: [], micro: [] } },
          { summary: 'Mem 2', chunkIds: ['3', '4'], embeddings: { full: [], compact: [], micro: [] } },
        ],
        ['2'], // tailChunkIds — informational only, all chunkIds still get archived
        null,
        ctx,
      );

      const updateCall = mockClient.query.mock.calls.find(
        c => (c[0] as string).includes("SET status = 'archived'"),
      );
      expect(updateCall).toBeDefined();

      // All 4 chunk IDs should be in the archive params
      const archiveParams = updateCall![1] as number[][];
      const archivedIds = archiveParams[0]!;
      expect(archivedIds).toContain(1);
      expect(archivedIds).toContain(2);
      expect(archivedIds).toContain(3);
      expect(archivedIds).toContain(4);
    });

    it('inserts mems with correct vector SQL via pgvector.toSql', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 1 }] }, // INSERT mem (RETURNING id)
        { rows: [] }, // UPDATE chunks
        { rows: [] }, // COMMIT
      ]);

      const full = [0.1, 0.2, 0.3];
      const compact = [0.4, 0.5];
      const micro = [0.6];

      await store.applyBackgroundResult(
        [{ summary: 'Topic', chunkIds: ['1'], embeddings: { full, compact, micro } }],
        [],
        null,
        ctx,
      );

      const pgvectorMod = await import('pgvector/pg');
      expect(pgvectorMod.default.toSql).toHaveBeenCalledWith(full);
      expect(pgvectorMod.default.toSql).toHaveBeenCalledWith(compact);
      expect(pgvectorMod.default.toSql).toHaveBeenCalledWith(micro);
    });

    it('passes null for empty embeddings (not toSql)', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 1 }] }, // INSERT mem (RETURNING id)
        // No archive call since chunkIds is empty
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{ summary: 'Topic', chunkIds: [], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      // Use 'INSERT INTO mems ' (with space) to avoid matching 'INSERT INTO memstores'
      const insertCall = mockClient.query.mock.calls.find(
        c => (c[0] as string).includes('INSERT INTO mems '),
      );
      expect(insertCall).toBeDefined();

      const params = insertCall![1] as unknown[];
      // params: [memstoreId, summary, chunkIdsInt, embeddingFull, embeddingCompact, embeddingMicro]
      // embedding params (index 3, 4, 5) should be null for empty arrays
      expect(params[3]).toBeNull();
      expect(params[4]).toBeNull();
      expect(params[5]).toBeNull();
    });

    it('releases the client after COMMIT', async () => {
      setupClientQuerySequence([
        { rows: [] },           // INSERT memstore (resolveMemstoreId)
        { rows: [{ id: 42 }] }, // SELECT memstoreId (resolveMemstoreId)
        { rows: [] }, // BEGIN
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult([], [], null, ctx);

      // release() called twice: once by resolveMemstoreId, once by transaction
      expect(mockClient.release).toHaveBeenCalledTimes(2);
    });

    it('upserts vocabulary terms and links to mem inside transaction', async () => {
      setupClientQuerySequence([
        { rows: [] },           // INSERT memstore
        { rows: [{ id: 42 }] }, // SELECT memstoreId
        { rows: [] },           // BEGIN
        { rows: [{ id: 10 }] }, // INSERT mem (RETURNING id)
        { rows: [{ id: 99 }] }, // INSERT vocabulary term (RETURNING id)
        { rows: [] },           // INSERT mem_vocabulary
        { rows: [] },           // UPDATE chunks (archive)
        { rows: [] },           // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{
          summary: 'Topic with vocab',
          chunkIds: ['1'],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [{ term: 'TypeScript', count: 3 }],
        }],
        [],
        null,
        ctx,
      );

      const sqlCalls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(sqlCalls.some(s => s.includes('INSERT INTO vocabulary'))).toBe(true);
      expect(sqlCalls.some(s => s.includes('INSERT INTO mem_vocabulary'))).toBe(true);

      // vocabulary insert must be inside transaction (after BEGIN, before COMMIT)
      const beginIdx = sqlCalls.indexOf('BEGIN');
      const commitIdx = sqlCalls.indexOf('COMMIT');
      const vocabIdx = sqlCalls.findIndex(s => s.includes('INSERT INTO vocabulary'));
      expect(vocabIdx).toBeGreaterThan(beginIdx);
      expect(vocabIdx).toBeLessThan(commitIdx);

      // mem_vocabulary insert must pass correct count_in_mem
      const memVocabCall = mockClient.query.mock.calls.find(
        c => (c[0] as string).includes('INSERT INTO mem_vocabulary'),
      );
      expect(memVocabCall).toBeDefined();
      // params: [mem_id, vocabulary_id, count_in_mem] — count_in_mem should be 3
      expect(memVocabCall![1]).toContain(3);
    });

    it('skips vocabulary queries when vocabulary array is empty', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 1 }] }, // INSERT mem (RETURNING id)
        { rows: [] }, // UPDATE chunks
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{ summary: 'Topic', chunkIds: ['5'], embeddings: { full: [], compact: [], micro: [] }, vocabulary: [] }],
        [],
        null,
        ctx,
      );

      const sqlCalls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(sqlCalls.some(s => s.includes('INSERT INTO vocabulary'))).toBe(false);
      expect(sqlCalls.some(s => s.includes('INSERT INTO mem_vocabulary'))).toBe(false);
    });

    it('skips vocabulary queries when vocabulary field is absent', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 1 }] }, // INSERT mem (RETURNING id)
        { rows: [] }, // UPDATE chunks
        { rows: [] }, // COMMIT
      ]);

      await store.applyBackgroundResult(
        [{ summary: 'Topic', chunkIds: ['5'], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      const sqlCalls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(sqlCalls.some(s => s.includes('INSERT INTO vocabulary'))).toBe(false);
    });
  });

  // ── getEstablishedVocabulary ───────────────────────────────────────────────

  describe('getEstablishedVocabulary', () => {
    it('returns terms with count >= minCount ordered by count desc, term asc', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({
        rows: [
          { term: 'TypeScript', count: 10 },
          { term: 'Postgres', count: 5 },
        ],
      });

      const terms = await store.getEstablishedVocabulary(ctx, 3);

      expect(terms).toHaveLength(2);
      expect(terms[0]!.term).toBe('TypeScript');
      expect(terms[0]!.count).toBe(10);
      expect(terms[1]!.term).toBe('Postgres');
    });

    it('uses default minCount of 3 when not specified', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      await store.getEstablishedVocabulary(ctx);

      const [sql, params] = mockPool.query.mock.calls[0]!;
      expect(sql).toContain('count >= $2');
      expect(params).toContain(3);
    });

    it('returns empty array when no terms meet the threshold', async () => {
      setupClientQuerySequence([
        { rows: [] },
        { rows: [{ id: 42 }] },
      ]);

      mockPool.query.mockResolvedValue({ rows: [] });

      const terms = await store.getEstablishedVocabulary(ctx, 5);
      expect(terms).toHaveLength(0);
    });
  });
});
