// src/__tests__/services/context-factory.test.ts
// Tests for ContextFactory — session state management.
// All external dependencies mocked; no DB, no LLM, no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IMemStore, Mem, MemChunk, MemContextData } from '../../types.js';
import type { IEmbeddingService } from '../../openrouter-chat.js';
import type { Result } from '../../shared/result.js';

// ──────────────────────────────────────────────────────────────────────────────
// Minimal mock IMemStore
// ──────────────────────────────────────────────────────────────────────────────

function makeMockStore(): IMemStore {
  return {
    addChunk: vi.fn(),
    getActiveChunks: vi.fn().mockResolvedValue([]),
    getClosedMems: vi.fn().mockResolvedValue([]),
    getGeneralSummary: vi.fn().mockResolvedValue(''),
    updateGeneralSummary: vi.fn(),
    removeOldestClosedMem: vi.fn(),
    getLastClosedMem: vi.fn().mockResolvedValue(null),
    buildMemContext: vi.fn().mockResolvedValue({
      generalSummary: '',
      recentClosedMems: [],
      lastClosedMem: null,
      activeChunks: [],
    } satisfies MemContextData),
    applyBackgroundResult: vi.fn(),
    searchMemsByVector: vi.fn().mockResolvedValue([]),
    getActiveChunkIds: vi.fn().mockResolvedValue(new Set<string>()),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Minimal mock IEmbeddingService
// ──────────────────────────────────────────────────────────────────────────────

function makeMockEmbeddingService(): IEmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue({
      ok: true,
      value: { compact: [0.1, 0.2, 0.3] },
    } satisfies Result<{ compact: number[] }, { message: string }>),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks would be set up (no module-level vi.mock needed here)
// ──────────────────────────────────────────────────────────────────────────────

import { ContextFactory } from '../../services/context-factory.js';

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('ContextFactory', () => {
  let store: IMemStore;
  let embeddingService: IEmbeddingService;
  let factory: ContextFactory;

  beforeEach(() => {
    store = makeMockStore();
    embeddingService = makeMockEmbeddingService();
    factory = new ContextFactory(store, embeddingService);
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts store, embeddingService, and optional config', () => {
      expect(() => new ContextFactory(store, embeddingService)).not.toThrow();
    });

    it('accepts REBUILD_THRESHOLD override in config', () => {
      expect(() =>
        new ContextFactory(store, embeddingService, { rebuildThreshold: 10 }),
      ).not.toThrow();
    });

    it('defaults REBUILD_THRESHOLD to 30 when not provided', () => {
      const f = new ContextFactory(store, embeddingService);
      expect(f.config.rebuildThreshold).toBe(30);
    });

    it('uses provided rebuildThreshold', () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 15 });
      expect(f.config.rebuildThreshold).toBe(15);
    });
  });

  // ── session lazy creation ─────────────────────────────────────────────────

  describe('session lazy creation', () => {
    it('creates session state on first access', () => {
      const state = factory.getOrCreateSession('session-1');
      expect(state).toBeDefined();
      expect(state.focus).toBeDefined();
      expect(state.loaded).toBeDefined();
      expect(state.loadedMemIds).toBeInstanceOf(Set);
      expect(state.cachePoint).toBe(0);
      expect(state.rawTail).toBeDefined();
      expect(state.oooCounter).toBe(0);
    });

    it('returns the same state object on subsequent calls for same sessionId', () => {
      const state1 = factory.getOrCreateSession('session-abc');
      const state2 = factory.getOrCreateSession('session-abc');
      expect(state1).toBe(state2); // referential equality
    });

    it('starts with empty focus vector', () => {
      const state = factory.getOrCreateSession('session-new');
      expect(state.focus).toHaveLength(0);
    });

    it('starts with empty loaded mems list', () => {
      const state = factory.getOrCreateSession('session-empty');
      expect(state.loaded).toHaveLength(0);
      expect(state.loadedMemIds.size).toBe(0);
    });

    it('starts with empty raw tail', () => {
      const state = factory.getOrCreateSession('session-tail');
      expect(state.rawTail).toHaveLength(0);
    });

    it('starts with oooCounter = 0', () => {
      const state = factory.getOrCreateSession('session-counter');
      expect(state.oooCounter).toBe(0);
    });
  });

  // ── session isolation ─────────────────────────────────────────────────────

  describe('session isolation', () => {
    it('creates distinct state objects for different sessionIds', () => {
      const stateA = factory.getOrCreateSession('session-A');
      const stateB = factory.getOrCreateSession('session-B');
      expect(stateA).not.toBe(stateB);
    });

    it('mutations to one session do not affect another', () => {
      const stateA = factory.getOrCreateSession('session-X');
      const stateB = factory.getOrCreateSession('session-Y');

      // Mutate stateA directly
      stateA.oooCounter = 5;
      stateA.focus.push(0.1, 0.2);

      // stateB must be unaffected
      expect(stateB.oooCounter).toBe(0);
      expect(stateB.focus).toHaveLength(0);
    });

    it('maintains correct state for each session independently', () => {
      const stateA = factory.getOrCreateSession('s1');
      const stateB = factory.getOrCreateSession('s2');

      stateA.cachePoint = 10;
      stateB.cachePoint = 20;

      expect(factory.getOrCreateSession('s1').cachePoint).toBe(10);
      expect(factory.getOrCreateSession('s2').cachePoint).toBe(20);
    });
  });

  // ── remember — rawTail append ─────────────────────────────────────────────

  describe('remember — rawTail append', () => {
    it('appends a RawFragment to rawTail with correct content', async () => {
      await factory.remember('s1', 'hello world', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.rawTail).toHaveLength(1);
      expect(state.rawTail[0]!.content).toBe('hello world');
    });

    it('sets receivedAt to a recent Date', async () => {
      const before = new Date();
      await factory.remember('s1', 'fragment', 'ctx1');
      const after = new Date();
      const state = factory.getOrCreateSession('s1');
      const ts = state.rawTail[0]!.receivedAt;
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('accumulates multiple rawTail entries in order', async () => {
      await factory.remember('s1', 'first', 'ctx1');
      await factory.remember('s1', 'second', 'ctx1');
      await factory.remember('s1', 'third', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.rawTail).toHaveLength(3);
      expect(state.rawTail[0]!.content).toBe('first');
      expect(state.rawTail[1]!.content).toBe('second');
      expect(state.rawTail[2]!.content).toBe('third');
    });
  });

  // ── remember — focus shift ─────────────────────────────────────────────────

  describe('remember — focus shift (EMA)', () => {
    it('sets focus to embedding value on first fragment', async () => {
      // embed mock returns compact: [0.1, 0.2, 0.3]
      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      // First fragment: focus = normalize(embed) ≈ norm([0.1, 0.2, 0.3])
      const norm = Math.sqrt(0.1 * 0.1 + 0.2 * 0.2 + 0.3 * 0.3);
      expect(state.focus[0]).toBeCloseTo(0.1 / norm, 5);
      expect(state.focus[1]).toBeCloseTo(0.2 / norm, 5);
      expect(state.focus[2]).toBeCloseTo(0.3 / norm, 5);
    });

    it('calls embed with the fragment text', async () => {
      const embedSpy = vi.spyOn(embeddingService, 'embed');
      await factory.remember('s1', 'test-text', 'ctx1');
      expect(embedSpy).toHaveBeenCalledWith('test-text');
    });

    it('applies EMA on second fragment: focus = normalize(focus*(1-alpha) + emb*alpha)', async () => {
      // alpha default = 0.5
      // embed always returns [0.1, 0.2, 0.3]
      await factory.remember('s1', 'first', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      const focusAfterFirst = [...state.focus];

      await factory.remember('s1', 'second', 'ctx1');
      const embRaw = [0.1, 0.2, 0.3];
      const embNorm = Math.sqrt(embRaw.reduce((s, v) => s + v * v, 0));
      const embNormalized = embRaw.map(v => v / embNorm);

      const alpha = 0.5;
      const raw = focusAfterFirst.map((f, i) => f * (1 - alpha) + embNormalized[i]! * alpha);
      const rawNorm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
      const expected = raw.map(v => v / rawNorm);

      for (let i = 0; i < expected.length; i++) {
        expect(state.focus[i]).toBeCloseTo(expected[i]!, 5);
      }
    });

    it('uses configurable alpha for EMA', async () => {
      const customFactory = new ContextFactory(store, embeddingService, { alpha: 0.8 });
      // First fragment: focus = normalize(emb)
      await customFactory.remember('s1', 'first', 'ctx1');
      const state = customFactory.getOrCreateSession('s1');
      const focusAfterFirst = [...state.focus];

      await customFactory.remember('s1', 'second', 'ctx1');
      const embRaw = [0.1, 0.2, 0.3];
      const embNorm = Math.sqrt(embRaw.reduce((s, v) => s + v * v, 0));
      const embNormalized = embRaw.map(v => v / embNorm);

      const alpha = 0.8;
      const raw = focusAfterFirst.map((f, i) => f * (1 - alpha) + embNormalized[i]! * alpha);
      const rawNorm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
      const expected = raw.map(v => v / rawNorm);

      for (let i = 0; i < expected.length; i++) {
        expect(state.focus[i]).toBeCloseTo(expected[i]!, 5);
      }
    });
  });

  // ── remember — mem loading ────────────────────────────────────────────────

  describe('remember — mem loading from store', () => {
    it('calls searchMemsByVector with current focus and contextId', async () => {
      const searchSpy = vi.spyOn(store, 'searchMemsByVector');
      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(searchSpy).toHaveBeenCalledWith(state.focus, expect.any(Number), 'ctx1');
    });

    it('adds search results to session.loaded and loadedMemIds', async () => {
      const mem: Mem = {
        id: 'mem-1',
        summary: 'Test summary',
        chunkIds: ['chunk-99'],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt: new Date(),
      };
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([mem]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());

      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.loaded).toHaveLength(1);
      expect(state.loaded[0]).toBe(mem);
      expect(state.loadedMemIds.has('mem-1')).toBe(true);
    });

    it('increments oooCounter by the number of survivors added', async () => {
      const mems: Mem[] = [
        { id: 'm1', summary: 's1', chunkIds: [], embeddings: { full: [], compact: [], micro: [] }, closedAt: new Date() },
        { id: 'm2', summary: 's2', chunkIds: [], embeddings: { full: [], compact: [], micro: [] }, closedAt: new Date() },
      ];
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce(mems);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());

      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.oooCounter).toBe(2);
    });

    it('oooCounter stays 0 when search returns no results', async () => {
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());

      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.oooCounter).toBe(0);
    });
  });

  // ── Step 5: dedup filter ───────────────────────────────────────────────────

  describe('dedup filter — already-loaded mem excluded', () => {
    it('does not add a mem that is already in loadedMemIds', async () => {
      const mem: Mem = {
        id: 'dup-mem',
        summary: 'Already loaded',
        chunkIds: [],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt: new Date(),
      };

      // First call loads the mem
      vi.mocked(store.searchMemsByVector!).mockResolvedValue([mem]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValue(new Set());

      await factory.remember('s1', 'first', 'ctx1');
      await factory.remember('s1', 'second', 'ctx1'); // same mem returned again

      const state = factory.getOrCreateSession('s1');
      // Should appear exactly once
      expect(state.loaded.filter(m => m.id === 'dup-mem')).toHaveLength(1);
      // oooCounter should be 1 (only first call adds it)
      expect(state.oooCounter).toBe(1);
    });
  });

  describe('dedup filter — mem with active source-chunk excluded', () => {
    it('does not load a mem whose chunkId is still in active set', async () => {
      const mem: Mem = {
        id: 'raw-mem',
        summary: 'Still raw',
        chunkIds: ['chunk-active'],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt: new Date(),
      };
      vi.mocked(store.searchMemsByVector!).mockResolvedValue([mem]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValue(new Set(['chunk-active']));

      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.loaded).toHaveLength(0);
      expect(state.oooCounter).toBe(0);
    });
  });

  describe('dedup filter — mem with archived source-chunk admitted', () => {
    it('loads a mem whose chunkId is not in the active set (already archived)', async () => {
      const mem: Mem = {
        id: 'archived-mem',
        summary: 'Archived chunk',
        chunkIds: ['chunk-archived'],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt: new Date(),
      };
      vi.mocked(store.searchMemsByVector!).mockResolvedValue([mem]);
      // Active set does NOT contain chunk-archived
      vi.mocked(store.getActiveChunkIds!).mockResolvedValue(new Set(['chunk-something-else']));

      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.loaded).toHaveLength(1);
      expect(state.loaded[0]!.id).toBe('archived-mem');
    });

    it('mem becomes admitted after its chunk leaves the active set (handover case)', async () => {
      const mem: Mem = {
        id: 'handover-mem',
        summary: 'Handover case',
        chunkIds: ['chunk-transitioning'],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt: new Date(),
      };

      // First call: chunk is active — mem excluded
      vi.mocked(store.searchMemsByVector!).mockResolvedValue([mem]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set(['chunk-transitioning']));
      await factory.remember('s1', 'first', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.loaded).toHaveLength(0);

      // Second call: chunk is now archived — mem admitted
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await factory.remember('s1', 'second', 'ctx1');
      expect(state.loaded).toHaveLength(1);
      expect(state.loaded[0]!.id).toBe('handover-mem');
    });
  });

  describe('dedup filter — mem with multiple chunkIds', () => {
    it('excludes mem if ANY of its chunkIds is active', async () => {
      const mem: Mem = {
        id: 'multi-chunk-mem',
        summary: 'Multi chunk',
        chunkIds: ['chunk-a', 'chunk-b-active'],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt: new Date(),
      };
      vi.mocked(store.searchMemsByVector!).mockResolvedValue([mem]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValue(new Set(['chunk-b-active']));

      await factory.remember('s1', 'fragment', 'ctx1');
      const state = factory.getOrCreateSession('s1');
      expect(state.loaded).toHaveLength(0);
    });
  });

  // ── getCurrentContext stub ────────────────────────────────────────────────

  describe('getCurrentContext (stub)', () => {
    it('throws "not implemented" when called', async () => {
      await expect(
        factory.getCurrentContext('session-1'),
      ).rejects.toThrow('not implemented');
    });
  });
});
