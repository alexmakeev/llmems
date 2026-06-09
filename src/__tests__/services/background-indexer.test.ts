// src/__tests__/services/background-indexer.test.ts
// Unit tests for BackgroundIndexer — fully offline/deterministic.
//
// Verifies:
// - ILLMSummarizer is called with correct prompts
// - Each topic summary is embedded via IEmbeddingService (1536-dim)
// - applyBackgroundResult is called with correct topics + archived chunkIds
// - Ghost topics (empty chunkIds) are filtered before apply
// - Return value = archived chunkIds (all chunkIds from closed topics)
// - Empty chunks → ILLMSummarizer NOT called, returns []
// - Embedding failure → fallback to empty (full: [])
// - LLM summarizer returning null → no apply, returns []

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundIndexer } from '../../services/background-indexer.ts';
import type { ILLMSummarizer } from '../../services/background-indexer.ts';
import { InMemoryMemStore, MemManager } from '../../services/mem-manager.ts';
import { ok, err } from '../../shared/result.ts';
import type { IEmbeddingService } from '../../types.ts';

// ── Helpers ──

const CONTEXT_ID = 'test-ctx';

/**
 * Create a MemManager backed by InMemoryMemStore with some pre-seeded active chunks.
 * Returns the manager + chunk IDs for assertions.
 */
async function createManagerWithChunks(chunkContents: string[]): Promise<{
  manager: MemManager;
  chunkIds: string[];
}> {
  const store = new InMemoryMemStore();
  const manager = new MemManager(store);
  const chunkIds: string[] = [];
  for (const content of chunkContents) {
    const chunk = await manager.addChunk(content, new Date(), CONTEXT_ID);
    chunkIds.push(chunk.id);
  }
  return { manager, chunkIds };
}

/**
 * Create a mock IEmbeddingService that returns a deterministic 1536-dim vector.
 */
function createMockEmbeddingService(): IEmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(ok({ compact: new Array(1536).fill(0.1) })),
  };
}

/**
 * Create a mock ILLMSummarizer that returns a fixed segmentation result.
 */
function createMockSummarizer(result: Awaited<ReturnType<ILLMSummarizer['summarize']>>): ILLMSummarizer {
  return {
    summarize: vi.fn().mockResolvedValue(result),
  };
}

// ── Tests ──

describe('BackgroundIndexer', () => {
  describe('index()', () => {
    it('calls ILLMSummarizer and returns archived chunkIds', async () => {
      const { manager, chunkIds } = await createManagerWithChunks([
        'user: hello',
        'assistant: hi there',
        'user: how are you',
      ]);

      const [id0, id1, id2] = chunkIds as [string, string, string];

      const embeddingService = createMockEmbeddingService();
      // LLM closes first 2 chunks as one topic, last chunk is tail
      const summarizer = createMockSummarizer({
        topics: [{ summary: 'Greeting exchange', chunkIds: [id0, id1], vocabulary: [] }],
        tailChunkIds: [id2],
      });

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // ILLMSummarizer was called
      expect(summarizer.summarize).toHaveBeenCalledTimes(1);

      // Archived chunkIds = chunkIds of closed topics
      expect(archived).toEqual([id0, id1]);
    });

    it('embeds each topic summary with IEmbeddingService (1536-dim)', async () => {
      const { manager, chunkIds } = await createManagerWithChunks([
        'user: topic A message 1',
        'user: topic A message 2',
        'user: topic B message 1',
        'user: topic B message 2',
      ]);

      const [id0, id1, id2, id3] = chunkIds as [string, string, string, string];

      const embeddingService = createMockEmbeddingService();
      const summarizer = createMockSummarizer({
        topics: [
          { summary: 'Topic A summary', chunkIds: [id0, id1], vocabulary: [] },
          { summary: 'Topic B summary', chunkIds: [id2, id3], vocabulary: [] },
        ],
        tailChunkIds: [],
      });

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      await indexer.index(CONTEXT_ID);

      // embed() called once per closed topic (2 topics)
      expect(embeddingService.embed).toHaveBeenCalledTimes(2);
      expect(embeddingService.embed).toHaveBeenCalledWith('Topic A summary');
      expect(embeddingService.embed).toHaveBeenCalledWith('Topic B summary');

      // Verify the embedding vectors are 1536-dim by checking closed mems
      const closedMems = await manager.getAllClosedMems(CONTEXT_ID);
      expect(closedMems).toHaveLength(2);
      for (const mem of closedMems) {
        expect(mem.embeddings.full).toHaveLength(1536);
      }
    });

    it('calls applyBackgroundResult with correct mems', async () => {
      const { manager, chunkIds } = await createManagerWithChunks([
        'user: chat message 1',
        'assistant: response 1',
      ]);

      const [id0, id1] = chunkIds as [string, string];

      const embeddingService = createMockEmbeddingService();
      const summarizer = createMockSummarizer({
        topics: [{ summary: 'First exchange', chunkIds: [id0, id1], vocabulary: [{ term: 'TypeScript', count: 2 }] }],
        tailChunkIds: [],
      });

      const applyspy = vi.spyOn(manager, 'applyBackgroundResult');

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      await indexer.index(CONTEXT_ID);

      expect(applyspy).toHaveBeenCalledTimes(1);
      const [mems, tailIds, generalSummary, ctxId] = applyspy.mock.calls[0] as Parameters<MemManager['applyBackgroundResult']>;

      expect(ctxId).toBe(CONTEXT_ID);
      expect(generalSummary).toBeNull();
      expect(tailIds).toEqual([]);
      expect(mems).toHaveLength(1);
      expect(mems[0]?.summary).toBe('First exchange');
      expect(mems[0]?.chunkIds).toEqual([id0, id1]);
      expect(mems[0]?.vocabulary).toEqual([{ term: 'TypeScript', count: 2 }]);
      expect(mems[0]?.embeddings.full).toHaveLength(1536);
    });

    it('filters ghost topics (empty chunkIds) before apply', async () => {
      const { manager, chunkIds } = await createManagerWithChunks(['user: message']);
      const [id0] = chunkIds as [string];

      const embeddingService = createMockEmbeddingService();
      // LLM returns a ghost topic (empty chunkIds) and a real one
      const summarizer = createMockSummarizer({
        topics: [
          { summary: 'Ghost topic (from old summary)', chunkIds: [], vocabulary: [] }, // ghost
          { summary: 'Real topic', chunkIds: [id0], vocabulary: [] },
        ],
        tailChunkIds: [],
      });

      const applyspy = vi.spyOn(manager, 'applyBackgroundResult');

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // Only the real topic was applied
      expect(applyspy).toHaveBeenCalledTimes(1);
      const [mems] = applyspy.mock.calls[0] as Parameters<MemManager['applyBackgroundResult']>;
      expect(mems).toHaveLength(1);
      expect(mems[0]?.summary).toBe('Real topic');

      // Archived contains only real topic's chunkIds
      expect(archived).toEqual([id0]);
    });

    it('returns [] when all topics are ghosts (nothing to apply)', async () => {
      const { manager } = await createManagerWithChunks(['user: message']);

      const embeddingService = createMockEmbeddingService();
      const summarizer = createMockSummarizer({
        topics: [{ summary: 'All ghosts', chunkIds: [], vocabulary: [] }],
        tailChunkIds: [],
      });

      const applyspy = vi.spyOn(manager, 'applyBackgroundResult');

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // No apply call when all topics filtered as ghosts
      expect(applyspy).not.toHaveBeenCalled();
      expect(archived).toEqual([]);
    });

    it('returns [] and skips LLM call when no active chunks', async () => {
      const store = new InMemoryMemStore();
      const manager = new MemManager(store);
      // No chunks added — store is empty

      const embeddingService = createMockEmbeddingService();
      const summarizer = createMockSummarizer(null);

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // LLM not called when no active chunks
      expect(summarizer.summarize).not.toHaveBeenCalled();
      expect(archived).toEqual([]);
    });

    it('returns [] when ILLMSummarizer returns null (LLM failure)', async () => {
      const { manager } = await createManagerWithChunks(['user: message']);

      const embeddingService = createMockEmbeddingService();
      // Simulate LLM failure — summarizer returns null
      const summarizer = createMockSummarizer(null);

      const applyspy = vi.spyOn(manager, 'applyBackgroundResult');

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // ILLMSummarizer was called (chunks exist) but returned null
      expect(summarizer.summarize).toHaveBeenCalledTimes(1);

      // No apply, no archived IDs
      expect(applyspy).not.toHaveBeenCalled();
      expect(archived).toEqual([]);
    });

    it('uses empty embeddings (full: []) when IEmbeddingService is not provided', async () => {
      const { manager, chunkIds } = await createManagerWithChunks(['user: hello', 'assistant: world']);
      const [id0, id1] = chunkIds as [string, string];

      const summarizer = createMockSummarizer({
        topics: [{ summary: 'Test topic', chunkIds: [id0, id1], vocabulary: [] }],
        tailChunkIds: [],
      });

      // No embedding service provided
      const indexer = new BackgroundIndexer(manager, undefined, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      expect(archived).toEqual([id0, id1]);

      const closedMems = await manager.getAllClosedMems(CONTEXT_ID);
      expect(closedMems).toHaveLength(1);
      // Empty embeddings fallback
      expect(closedMems[0]?.embeddings.full).toEqual([]);
    });

    it('uses empty embeddings when IEmbeddingService fails', async () => {
      const { manager, chunkIds } = await createManagerWithChunks(['user: hello']);
      const [id0] = chunkIds as [string];

      const failingEmbedService: IEmbeddingService = {
        embed: vi.fn().mockResolvedValue(err({ message: 'embedding failed' })),
      };
      const summarizer = createMockSummarizer({
        topics: [{ summary: 'Test', chunkIds: [id0], vocabulary: [] }],
        tailChunkIds: [],
      });

      const indexer = new BackgroundIndexer(manager, failingEmbedService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // Still closes the topic with empty embeddings
      expect(archived).toEqual([id0]);
      const closedMems = await manager.getAllClosedMems(CONTEXT_ID);
      expect(closedMems[0]?.embeddings.full).toEqual([]);
    });

    it('returns correct archived chunkIds from multiple topics', async () => {
      const { manager, chunkIds } = await createManagerWithChunks([
        'user: A', 'user: B', 'user: C', 'user: D', 'user: E',
      ]);
      const [id0, id1, id2, id3, id4] = chunkIds as [string, string, string, string, string];

      const embeddingService = createMockEmbeddingService();
      const summarizer = createMockSummarizer({
        topics: [
          { summary: 'Topic 1', chunkIds: [id0, id1], vocabulary: [] },
          { summary: 'Topic 2', chunkIds: [id2, id3], vocabulary: [] },
        ],
        tailChunkIds: [id4], // id4 is tail, not archived
      });

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      const archived = await indexer.index(CONTEXT_ID);

      // Archived = all chunkIds from closed topics (not tail)
      expect(archived).toEqual([id0, id1, id2, id3]);
      expect(archived).not.toContain(id4);
    });

    it('active chunks are removed from store after successful index', async () => {
      const { manager, chunkIds } = await createManagerWithChunks([
        'user: closed topic message',
        'assistant: closed topic reply',
        'user: tail message (stays active)',
      ]);
      const [id0, id1, id2] = chunkIds as [string, string, string];

      const embeddingService = createMockEmbeddingService();
      const summarizer = createMockSummarizer({
        topics: [{ summary: 'Closed topic', chunkIds: [id0, id1], vocabulary: [] }],
        tailChunkIds: [id2],
      });

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      await indexer.index(CONTEXT_ID);

      // After index: closed topic chunks removed, tail chunk remains
      const remainingChunks = await manager.getActiveChunks(CONTEXT_ID);
      expect(remainingChunks.map(c => c.id)).not.toContain(id0);
      expect(remainingChunks.map(c => c.id)).not.toContain(id1);
      expect(remainingChunks.map(c => c.id)).toContain(id2);
    });

    it('passes system prompt and detection prompt to ILLMSummarizer', async () => {
      const { manager } = await createManagerWithChunks(['user: test message']);

      const embeddingService = createMockEmbeddingService();
      const summarizer: ILLMSummarizer = {
        summarize: vi.fn().mockResolvedValue({
          topics: [],
          tailChunkIds: [],
        }),
      };

      const indexer = new BackgroundIndexer(manager, embeddingService, summarizer);
      await indexer.index(CONTEXT_ID);

      expect(summarizer.summarize).toHaveBeenCalledTimes(1);
      const [systemPrompt, detectionPrompt] = (summarizer.summarize as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];

      // System prompt contains segmentation instructions
      expect(systemPrompt).toContain('You segment conversations into mems');
      expect(systemPrompt).toContain('DEFINITION: A mem is a SEGMENT');

      // Detection prompt contains the chunk content
      expect(detectionPrompt).toContain('test message');
      expect(detectionPrompt).toContain('Identify the topics');
    });
  });
});
