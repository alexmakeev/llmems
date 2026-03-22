import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemStore, MemManager } from '../../services/mem-manager.ts';

describe('MemManager + InMemoryMemStore', () => {
  let store: InMemoryMemStore;
  let manager: MemManager;
  const ctx = 'test-context';

  beforeEach(() => {
    store = new InMemoryMemStore();
    manager = new MemManager(store);
  });

  // ── addChunk ────────────────────────────────────────────────────────

  describe('addChunk', () => {
    it('adds chunks and returns them via getActiveChunks', async () => {
      const t1 = new Date('2025-01-01T10:00:00Z');
      const t2 = new Date('2025-01-01T10:01:00Z');

      const chunk1 = await manager.addChunk('Hello', t1, ctx);
      const chunk2 = await manager.addChunk('Hi there', t2, ctx);

      const active = await manager.getActiveChunks(ctx);
      expect(active).toHaveLength(2);
      expect(active[0]).toEqual({ id: chunk1.id, content: 'Hello', timestamp: t1 });
      expect(active[1]).toEqual({ id: chunk2.id, content: 'Hi there', timestamp: t2 });
    });

    it('returns a MemChunk with generated UUID', async () => {
      const chunk = await manager.addChunk('Hello', new Date(), ctx);
      expect(chunk.id).toBeTruthy();
      expect(typeof chunk.id).toBe('string');
      expect(chunk.id.length).toBeGreaterThan(0);
      expect(chunk.content).toBe('Hello');
    });
  });

  // ── applyBackgroundResult ────────────────────────────────────────────

  describe('applyBackgroundResult', () => {
    it('closes mem, removes summarized chunks from active, grows closed mems', async () => {
      const chunk1 = await manager.addChunk('msg1', new Date(), ctx);
      const chunk2 = await manager.addChunk('reply1', new Date(), ctx);

      await manager.applyBackgroundResult(
        [{ summary: 'Summary of mem 1', chunkIds: [chunk1.id, chunk2.id], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      expect(await manager.getActiveChunks(ctx)).toHaveLength(0);
      expect(await manager.getClosedMemCount(ctx)).toBe(1);
    });

    it('closed mem has correct summary', async () => {
      const chunk1 = await manager.addChunk('msg1', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{ summary: 'Mem summary', chunkIds: [chunk1.id], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.lastClosedMem).not.toBeNull();
      expect(ctxData.lastClosedMem!.summary).toBe('Mem summary');
      expect(ctxData.lastClosedMem!.id).toBeTruthy();
      expect(ctxData.lastClosedMem!.closedAt).toBeInstanceOf(Date);
    });

    it('closed mem stores chunkIds', async () => {
      const chunk1 = await manager.addChunk('msg1', new Date(), ctx);
      const chunk2 = await manager.addChunk('reply1', new Date(), ctx);
      const chunk3 = await manager.addChunk('msg2', new Date(), ctx);

      await manager.applyBackgroundResult(
        [{ summary: 'Summary', chunkIds: [chunk1.id, chunk2.id, chunk3.id], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      const closed = await manager.getAllClosedMems(ctx);
      expect(closed).toHaveLength(1);
      expect(closed[0]!.chunkIds).toEqual([chunk1.id, chunk2.id, chunk3.id]);
    });

    it('tail chunks are removed along with all other mem chunks', async () => {
      const c1 = await manager.addChunk('chunk1', new Date(), ctx);
      const c2 = await manager.addChunk('chunk2', new Date(), ctx);
      const c3 = await manager.addChunk('chunk3', new Date(), ctx);

      await manager.applyBackgroundResult(
        [{ summary: 'mem1', chunkIds: [c1.id, c2.id], embeddings: { full: [], compact: [], micro: [] } }],
        [c2.id],    // c2 is in tailChunkIds — but tailChunkIds are informational only, does NOT prevent removal
        null,
        ctx,
      );

      const active = await manager.getActiveChunks(ctx);
      // c1 is removed (in mem chunkIds)
      // c2 is removed (in mem chunkIds — tailChunkIds no longer prevent removal)
      // c3 stays (not part of any mem)
      expect(active.map(c => c.id)).not.toContain(c1.id);
      expect(active.map(c => c.id)).not.toContain(c2.id);
      expect(active.map(c => c.id)).toContain(c3.id);

      const closed = await manager.getAllClosedMems(ctx);
      expect(closed).toHaveLength(1);
      expect(closed[0]!.summary).toBe('mem1');
    });
  });

  // ── getContextData ────────────────────────────────────────────────────

  describe('getContextData', () => {
    it('with 0 closed mems — lastClosedMem is null, recentClosedMems empty', async () => {
      await manager.addChunk('active msg', new Date(), ctx);

      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.lastClosedMem).toBeNull();
      expect(ctxData.recentClosedMems).toHaveLength(0);
      expect(ctxData.activeChunks).toHaveLength(1);
      expect(ctxData.generalSummary).toBe('');
    });

    it('with 1 closed mem — lastClosedMem set, recentClosedMems empty', async () => {
      await manager.addChunk('msg', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{ summary: 'S1', chunkIds: [], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.lastClosedMem).not.toBeNull();
      expect(ctxData.lastClosedMem!.summary).toBe('S1');
      expect(ctxData.recentClosedMems).toHaveLength(0);
    });

    it('with 2 closed mems — lastClosedMem is newest, recentClosedMems has 1', async () => {
      await manager.addChunk('msg1', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{ summary: 'S1', chunkIds: [], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );
      await manager.addChunk('msg2', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{ summary: 'S2', chunkIds: [], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.lastClosedMem!.summary).toBe('S2');
      expect(ctxData.recentClosedMems).toHaveLength(1);
      expect(ctxData.recentClosedMems[0]!.summary).toBe('S1');
    });

    it('with 3+ closed mems — lastClosedMem is newest, recentClosedMems has rest', async () => {
      for (let i = 1; i <= 4; i++) {
        await manager.addChunk(`msg${i}`, new Date(), ctx);
        await manager.applyBackgroundResult(
          [{ summary: `S${i}`, chunkIds: [], embeddings: { full: [], compact: [], micro: [] } }],
          [],
          null,
          ctx,
        );
      }

      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.lastClosedMem!.summary).toBe('S4');
      expect(ctxData.recentClosedMems).toHaveLength(3);
      expect(ctxData.recentClosedMems[0]!.summary).toBe('S1');
      expect(ctxData.recentClosedMems[1]!.summary).toBe('S2');
      expect(ctxData.recentClosedMems[2]!.summary).toBe('S3');
    });
  });

  // ── removeOldestClosedMem ───────────────────────────────────────────

  describe('removeOldestClosedMem', () => {
    it('removes the first (oldest) closed mem', async () => {
      for (let i = 1; i <= 3; i++) {
        await manager.addChunk(`msg${i}`, new Date(), ctx);
        await manager.applyBackgroundResult(
          [{ summary: `S${i}`, chunkIds: [], embeddings: { full: [], compact: [], micro: [] } }],
          [],
          null,
          ctx,
        );
      }

      expect(await manager.getClosedMemCount(ctx)).toBe(3);

      await manager.removeOldestClosedMem(ctx);

      expect(await manager.getClosedMemCount(ctx)).toBe(2);
      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.recentClosedMems[0]!.summary).toBe('S2');
      expect(ctxData.lastClosedMem!.summary).toBe('S3');
    });
  });

  // ── updateGeneralSummary ──────────────────────────────────────────────

  describe('updateGeneralSummary', () => {
    it('sets and gets general summary', async () => {
      expect((await manager.getContextData(ctx)).generalSummary).toBe('');

      await manager.updateGeneralSummary('User prefers dark themes and TypeScript', ctx);

      expect((await manager.getContextData(ctx)).generalSummary).toBe('User prefers dark themes and TypeScript');
    });
  });

  // ── Mem lifecycle ───────────────────────────────────────────────────

  describe('mem lifecycle', () => {
    it('full cycle: add chunks, close, add more, close, verify context', async () => {
      // Mem 1
      const t1c1 = await manager.addChunk('Tell me about cats', new Date('2025-01-01T10:00:00Z'), ctx);
      const t1c2 = await manager.addChunk('Cats are great!', new Date('2025-01-01T10:01:00Z'), ctx);
      await manager.applyBackgroundResult(
        [{ summary: 'Feline behavior patterns and domestication history', chunkIds: [t1c1.id, t1c2.id], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      // Mem 2
      const t2c1 = await manager.addChunk('Now about dogs', new Date('2025-01-01T11:00:00Z'), ctx);
      const t2c2 = await manager.addChunk('Dogs are loyal', new Date('2025-01-01T11:01:00Z'), ctx);
      await manager.applyBackgroundResult(
        [{ summary: 'Canine loyalty characteristics and training methods', chunkIds: [t2c1.id, t2c2.id], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      // Active mem 3
      await manager.addChunk('What about fish?', new Date('2025-01-01T12:00:00Z'), ctx);

      // Update general summary
      await manager.updateGeneralSummary('User is interested in animals', ctx);

      const ctxData = await manager.getContextData(ctx);
      expect(ctxData.generalSummary).toBe('User is interested in animals');
      expect(ctxData.recentClosedMems).toHaveLength(1);
      expect(ctxData.recentClosedMems[0]!.summary).toBe('Feline behavior patterns and domestication history');
      expect(ctxData.lastClosedMem!.summary).toBe('Canine loyalty characteristics and training methods');
      expect(ctxData.activeChunks).toHaveLength(1);
      expect(ctxData.activeChunks[0]!.content).toBe('What about fish?');
    });
  });

  // ── behaviorInstructions ────────────────────────────────────────────

  describe('behaviorInstructions', () => {
    it('defaults to empty string', async () => {
      expect(await store.getBehaviorInstructions(ctx)).toBe('');
    });

    it('set and get round-trip', async () => {
      await store.setBehaviorInstructions('Be friendly and concise', ctx);
      expect(await store.getBehaviorInstructions(ctx)).toBe('Be friendly and concise');
    });

    it('overwriting replaces previous instructions', async () => {
      await store.setBehaviorInstructions('First instruction', ctx);
      await store.setBehaviorInstructions('Second instruction', ctx);
      expect(await store.getBehaviorInstructions(ctx)).toBe('Second instruction');
    });

    it('setting empty string clears instructions', async () => {
      await store.setBehaviorInstructions('Some instructions', ctx);
      await store.setBehaviorInstructions('', ctx);
      expect(await store.getBehaviorInstructions(ctx)).toBe('');
    });
  });

  // ── applyBackgroundResult with overlap ───────────────────────────────

  describe('applyBackgroundResult with overlap', () => {
    it('after closing, non-tail chunks are removed from active', async () => {
      const c1 = await manager.addChunk('msg1', new Date(), ctx);
      const c2 = await manager.addChunk('reply1', new Date(), ctx);
      const c3 = await manager.addChunk('msg2', new Date(), ctx);

      await manager.applyBackgroundResult(
        [{ summary: 'Closed summary', chunkIds: [c1.id, c2.id, c3.id], embeddings: { full: [], compact: [], micro: [] } }],
        [],
        null,
        ctx,
      );

      // All summarized chunks removed (no tail chunks to keep)
      expect(await manager.getActiveChunks(ctx)).toHaveLength(0);
      expect(await manager.getClosedMemCount(ctx)).toBe(1);
    });
  });

  // ── vocabulary ───────────────────────────────────────────────────────

  describe('vocabulary', () => {
    it('adds terms via applyBackgroundResult and retrieves them via getEstablishedVocabulary', async () => {
      const chunk = await manager.addChunk('msg', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S1',
          chunkIds: [chunk.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [
            { term: 'TypeScript', count: 5 },
            { term: 'Postgres', count: 3 },
          ],
        }],
        [],
        null,
        ctx,
      );

      const terms = await store.getEstablishedVocabulary!(ctx, 3);
      expect(terms).toHaveLength(2);
      // Sorted by count desc, then term asc
      expect(terms[0]!.term).toBe('TypeScript');
      expect(terms[0]!.count).toBe(5);
      expect(terms[1]!.term).toBe('Postgres');
      expect(terms[1]!.count).toBe(3);
    });

    it('filters terms below minCount threshold', async () => {
      const chunk = await manager.addChunk('msg', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S1',
          chunkIds: [chunk.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [
            { term: 'RareWord', count: 1 },
            { term: 'CommonTerm', count: 5 },
          ],
        }],
        [],
        null,
        ctx,
      );

      const terms = await store.getEstablishedVocabulary!(ctx, 3);
      expect(terms).toHaveLength(1);
      expect(terms[0]!.term).toBe('CommonTerm');
    });

    it('accumulates counts across multiple mems (case-insensitive merging)', async () => {
      const c1 = await manager.addChunk('msg1', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S1',
          chunkIds: [c1.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [{ term: 'TypeScript', count: 2 }],
        }],
        [],
        null,
        ctx,
      );

      const c2 = await manager.addChunk('msg2', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S2',
          chunkIds: [c2.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [{ term: 'typescript', count: 3 }],  // lowercase — same term
        }],
        [],
        null,
        ctx,
      );

      const terms = await store.getEstablishedVocabulary!(ctx, 1);
      // Should be merged into one entry (case-insensitive)
      expect(terms).toHaveLength(1);
      expect(terms[0]!.count).toBe(5);
    });

    it('preserves original capitalization from first insertion', async () => {
      const chunk = await manager.addChunk('msg', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S1',
          chunkIds: [chunk.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [{ term: 'TypeScript', count: 2 }],
        }],
        [],
        null,
        ctx,
      );

      const terms = await store.getEstablishedVocabulary!(ctx, 1);
      expect(terms[0]!.term).toBe('TypeScript');
    });

    it('getVocabulary returns all terms without threshold', async () => {
      const chunk = await manager.addChunk('msg', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S1',
          chunkIds: [chunk.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [
            { term: 'RareWord', count: 1 },
            { term: 'CommonTerm', count: 5 },
          ],
        }],
        [],
        null,
        ctx,
      );

      const terms = await store.getVocabulary!(ctx);
      expect(terms).toHaveLength(2);
    });

    it('MemManager.getEstablishedVocabulary delegates to store', async () => {
      const chunk = await manager.addChunk('msg', new Date(), ctx);
      await manager.applyBackgroundResult(
        [{
          summary: 'S1',
          chunkIds: [chunk.id],
          embeddings: { full: [], compact: [], micro: [] },
          vocabulary: [{ term: 'NodeJS', count: 4 }],
        }],
        [],
        null,
        ctx,
      );

      const terms = await manager.getEstablishedVocabulary(ctx, 1);
      expect(terms).toHaveLength(1);
      expect(terms[0]!.term).toBe('NodeJS');
    });

    it('returns empty array when no vocabulary terms exist', async () => {
      const terms = await manager.getEstablishedVocabulary(ctx, 1);
      expect(terms).toHaveLength(0);
    });

    it('stores count_in_mem correctly per topic vocabulary', async () => {
      // Create two mems with different vocabulary counts
      const c1 = await manager.addChunk('msg1', new Date(), ctx);
      const c2 = await manager.addChunk('msg2', new Date(), ctx);
      await manager.applyBackgroundResult(
        [
          {
            summary: 'Topic 1',
            chunkIds: [c1.id],
            embeddings: { full: [], compact: [], micro: [] },
            vocabulary: [{ term: 'React', count: 7 }],
          },
          {
            summary: 'Topic 2',
            chunkIds: [c2.id],
            embeddings: { full: [], compact: [], micro: [] },
            vocabulary: [{ term: 'React', count: 2 }],
          },
        ],
        [],
        null,
        ctx,
      );

      // Total count should be 7 + 2 = 9
      const terms = await store.getEstablishedVocabulary!(ctx, 1);
      expect(terms).toHaveLength(1);
      expect(terms[0]!.term).toBe('React');
      expect(terms[0]!.count).toBe(9);
    });
  });

});
