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

  // ── remember stub ─────────────────────────────────────────────────────────

  describe('remember (stub)', () => {
    it('throws "not implemented" when called', async () => {
      await expect(
        factory.remember('session-1', 'some fragment'),
      ).rejects.toThrow('not implemented');
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
