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

  // ── getCurrentContext serializer (Step 6) ────────────────────────────────

  describe('getCurrentContext — serializer', () => {
    /**
     * Build a Mem fixture with a known closedAt date.
     */
    function makeMem(id: string, summary: string, closedAt: Date, chunkIds: string[] = []): Mem {
      return {
        id,
        summary,
        chunkIds,
        embeddings: { full: [], compact: [], micro: [] },
        closedAt,
      };
    }

    it('returns an empty string for a session with no loaded mems and no rawTail', async () => {
      const result = await factory.getCurrentContext('empty-session');
      expect(result).toBe('');
    });

    it('returns rawTail content as plain text at the end when no loaded mems', async () => {
      const state = factory.getOrCreateSession('s-tail-only');
      state.rawTail.push({ content: 'hello user', receivedAt: new Date() });

      const result = await factory.getCurrentContext('s-tail-only');
      expect(result).toContain('hello user');
      // Plain text, not wrapped in <mem>
      expect(result).not.toContain('<mem');
    });

    it('serializes loaded mems in <mem ts="..."> XML format', async () => {
      const ts = new Date('2024-01-15T10:00:00.000Z');
      const state = factory.getOrCreateSession('s-xml-format');
      state.loaded.push(makeMem('m1', 'Summary one', ts));
      state.cachePoint = 0; // all in prefix (layer 1)

      const result = await factory.getCurrentContext('s-xml-format');
      expect(result).toContain('<mem ts="2024-01-15T10:00:00.000Z">Summary one</mem>');
    });

    it('places mems before cachePoint (stable prefix / layer 1) before the marker and tail block', async () => {
      const ts1 = new Date('2024-01-01T00:00:00.000Z');
      const ts2 = new Date('2024-01-02T00:00:00.000Z');
      const state = factory.getOrCreateSession('s-prefix');
      state.loaded.push(makeMem('m-prefix', 'Prefix mem', ts1));
      state.loaded.push(makeMem('m-dynamic', 'Dynamic mem', ts2));
      state.cachePoint = 1; // m-prefix in layer 1; m-dynamic in layer 2+

      const result = await factory.getCurrentContext('s-prefix');
      const prefixPos = result.indexOf('Prefix mem');
      const dynamicPos = result.indexOf('Dynamic mem');
      expect(prefixPos).toBeGreaterThanOrEqual(0);
      expect(dynamicPos).toBeGreaterThanOrEqual(0);
      expect(prefixPos).toBeLessThan(dynamicPos);
    });

    it('places raw tail content after all loaded mems', async () => {
      const ts = new Date('2024-01-10T00:00:00.000Z');
      const state = factory.getOrCreateSession('s-tail-after-mems');
      state.loaded.push(makeMem('m1', 'Loaded summary', ts));
      state.cachePoint = 1;
      state.rawTail.push({ content: 'current utterance', receivedAt: new Date() });

      const result = await factory.getCurrentContext('s-tail-after-mems');
      const memPos = result.indexOf('Loaded summary');
      const tailPos = result.indexOf('current utterance');
      expect(memPos).toBeGreaterThanOrEqual(0);
      expect(tailPos).toBeGreaterThanOrEqual(0);
      expect(tailPos).toBeGreaterThan(memPos);
    });

    it('raw tail is plain text — not wrapped in <mem> tags', async () => {
      const state = factory.getOrCreateSession('s-tail-plain');
      state.rawTail.push({ content: 'plain tail text', receivedAt: new Date() });

      const result = await factory.getCurrentContext('s-tail-plain');
      // raw tail must not be inside a <mem>...</mem>
      const tailIdx = result.indexOf('plain tail text');
      const before = result.substring(0, tailIdx);
      expect(before).not.toMatch(/<mem[^>]*>[^<]*$/); // no unclosed <mem> before the text
    });

    it('does NOT call store/DB methods during serialization (pure projection)', async () => {
      const state = factory.getOrCreateSession('s-no-store');
      state.loaded.push(makeMem('m1', 'Summary', new Date()));
      state.cachePoint = 0;
      state.rawTail.push({ content: 'tail', receivedAt: new Date() });

      await factory.getCurrentContext('s-no-store');

      // Verify no store methods were called during getCurrentContext
      expect(store.searchMemsByVector).not.toHaveBeenCalled();
      expect(store.getActiveChunkIds).not.toHaveBeenCalled();
      expect(store.getClosedMems).not.toHaveBeenCalled();
      expect(store.buildMemContext).not.toHaveBeenCalled();
    });

    it('multiple rawTail fragments are all included in order', async () => {
      const state = factory.getOrCreateSession('s-multi-tail');
      state.rawTail.push({ content: 'first fragment', receivedAt: new Date() });
      state.rawTail.push({ content: 'second fragment', receivedAt: new Date() });

      const result = await factory.getCurrentContext('s-multi-tail');
      expect(result).toContain('first fragment');
      expect(result).toContain('second fragment');
      expect(result.indexOf('first fragment')).toBeLessThan(result.indexOf('second fragment'));
    });

    it('ts attribute uses ISO8601 format from mem.closedAt', async () => {
      const closedAt = new Date('2025-06-30T14:30:00.000Z');
      const state = factory.getOrCreateSession('s-iso');
      state.loaded.push(makeMem('m1', 'ISO test', closedAt));
      state.cachePoint = 0;

      const result = await factory.getCurrentContext('s-iso');
      expect(result).toContain('ts="2025-06-30T14:30:00.000Z"');
    });
  });

  // ── Step 7: recalled-memory marker ───────────────────────────────────────

  describe('getCurrentContext — recalled-memory marker (Step 7)', () => {
    function makeMem(id: string, summary: string, closedAt: Date): Mem {
      return {
        id,
        summary,
        chunkIds: [],
        embeddings: { full: [], compact: [], micro: [] },
        closedAt,
      };
    }

    it('inserts default marker "Loaded from memory:" before the dynamic mem block', async () => {
      const state = factory.getOrCreateSession('s-marker-default');
      // No prefix mems (cachePoint=0), one dynamic mem
      state.loaded.push(makeMem('m1', 'Dynamic summary', new Date('2024-03-01T00:00:00.000Z')));
      state.cachePoint = 0;

      const result = await factory.getCurrentContext('s-marker-default');
      const markerPos = result.indexOf('Loaded from memory:');
      const memPos = result.indexOf('Dynamic summary');
      expect(markerPos).toBeGreaterThanOrEqual(0);
      expect(markerPos).toBeLessThan(memPos);
    });

    it('marker does NOT appear before the raw tail block', async () => {
      const state = factory.getOrCreateSession('s-marker-not-before-tail');
      state.rawTail.push({ content: 'live tail text', receivedAt: new Date() });
      // No loaded mems at all
      state.cachePoint = 0;

      const result = await factory.getCurrentContext('s-marker-not-before-tail');
      // Marker must not appear if there are no dynamic loaded mems
      // (it would be wrong to show the marker before pure raw tail)
      const tailIdx = result.indexOf('live tail text');
      const markerIdx = result.indexOf('Loaded from memory:');
      if (markerIdx >= 0) {
        // If marker exists, it must not be immediately before tail with no mems between
        expect(markerIdx).toBeLessThan(tailIdx);
        // But the real check: marker absent when no loaded mems
        expect(state.loaded.length).toBe(0);
        // marker should NOT appear when there are no dynamic mems to label
        fail('Marker should not appear when loaded mems list is empty');
      }
      // marker absent — pass
    });

    it('uses configurable markerText from ContextFactoryConfig', async () => {
      const customFactory = new ContextFactory(store, embeddingService, {
        markerText: 'Relevant memories:',
      });
      const state = customFactory.getOrCreateSession('s-custom-marker');
      state.loaded.push(makeMem('m1', 'Custom marker test', new Date('2024-04-01T00:00:00.000Z')));
      state.cachePoint = 0;

      const result = await customFactory.getCurrentContext('s-custom-marker');
      expect(result).toContain('Relevant memories:');
      expect(result).not.toContain('Loaded from memory:');
    });

    it('marker appears only once even with multiple dynamic mems', async () => {
      const state = factory.getOrCreateSession('s-marker-once');
      state.loaded.push(makeMem('m1', 'First mem', new Date('2024-01-01T00:00:00.000Z')));
      state.loaded.push(makeMem('m2', 'Second mem', new Date('2024-01-02T00:00:00.000Z')));
      state.cachePoint = 0;

      const result = await factory.getCurrentContext('s-marker-once');
      const markerCount = (result.match(/Loaded from memory:/g) ?? []).length;
      expect(markerCount).toBe(1);
    });

    it('no marker when loaded list is entirely in the stable prefix (all <= cachePoint)', async () => {
      const state = factory.getOrCreateSession('s-marker-prefix-only');
      state.loaded.push(makeMem('m1', 'Prefix only mem', new Date('2024-01-01T00:00:00.000Z')));
      // cachePoint covers all loaded mems — entire list is stable prefix
      state.cachePoint = 1;

      const result = await factory.getCurrentContext('s-marker-prefix-only');
      // Dynamic block is empty => no marker
      expect(result).not.toContain('Loaded from memory:');
    });
  });

  // ── Step 8: soft-rebuild ─────────────────────────────────────────────────

  describe('soft-rebuild (Step 8)', () => {
    /**
     * Build a Mem with embeddings set for cosine-sim tests.
     * We set compact (used in remember) but also need embeddings.compact for rebuild scoring.
     * Rebuild uses embeddings.compact for similarity to focus.
     */
    function makeMemWithEmbedding(
      id: string,
      summary: string,
      closedAt: Date,
      embedding: number[],
    ): Mem {
      return {
        id,
        summary,
        chunkIds: [],
        embeddings: { full: [], compact: embedding, micro: [] },
        closedAt,
      };
    }

    it('does NOT trigger rebuild when oooCounter is below rebuildThreshold', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 5 });
      const state = f.getOrCreateSession('s-no-rebuild');

      // Manually load 2 mems and set counter below threshold
      state.loaded.push(makeMemWithEmbedding('m1', 's1', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m2', 's2', new Date('2024-01-02T00:00:00.000Z'), [1, 0, 0]));
      state.loadedMemIds.add('m1');
      state.loadedMemIds.add('m2');
      state.oooCounter = 4; // below threshold of 5

      // remember() with no new mems from search
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-no-rebuild', 'fragment', 'ctx1');

      // oooCounter still 4 (no new mems added), no rebuild
      expect(state.oooCounter).toBe(4);
      expect(state.loaded).toHaveLength(2);
    });

    it('triggers rebuild when oooCounter reaches rebuildThreshold', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 3 });
      const state = f.getOrCreateSession('s-trigger-rebuild');

      // focus: unit vector [1, 0, 0]
      state.focus = [1, 0, 0];

      // Load 3 mems: m1 and m2 are relevant (cos-sim high), m3 is stale (orthogonal)
      // With keepRatio=0.7, keep ceil(3*0.7)=3... need more mems to drop one
      // Use 4 mems: 3 relevant, 1 stale; keepRatio keeps ceil(4*0.7)=3
      state.loaded.push(makeMemWithEmbedding('m1', 'Relevant 1', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m2', 'Relevant 2', new Date('2024-01-03T00:00:00.000Z'), [0.9, 0.1, 0]));
      state.loaded.push(makeMemWithEmbedding('m3', 'Relevant 3', new Date('2024-01-02T00:00:00.000Z'), [0.95, 0.05, 0]));
      state.loaded.push(makeMemWithEmbedding('m-stale', 'Stale mem', new Date('2024-01-04T00:00:00.000Z'), [0, 1, 0]));
      state.loadedMemIds.add('m1');
      state.loadedMemIds.add('m2');
      state.loadedMemIds.add('m3');
      state.loadedMemIds.add('m-stale');
      state.oooCounter = 2; // one more will push to 3

      // remember() returns 1 new mem to push oooCounter to 3
      const newMem = makeMemWithEmbedding('m-new', 'New mem', new Date('2024-01-05T00:00:00.000Z'), [1, 0, 0]);
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([newMem]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-trigger-rebuild', 'fragment', 'ctx1');

      // After rebuild: oooCounter reset to 0
      expect(state.oooCounter).toBe(0);
    });

    it('stale mems are dropped after rebuild', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 1 });
      const state = f.getOrCreateSession('s-stale-dropped');

      // focus: unit vector [1, 0, 0]
      state.focus = [1, 0, 0];

      // 3 mems: 2 relevant to focus, 1 orthogonal (stale)
      // keepRatio 0.7 => keep ceil(3*0.7)=3 from 3... need 4 to drop 1
      state.loaded.push(makeMemWithEmbedding('m-keep1', 'Keep 1', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m-keep2', 'Keep 2', new Date('2024-01-02T00:00:00.000Z'), [0.99, 0.01, 0]));
      state.loaded.push(makeMemWithEmbedding('m-keep3', 'Keep 3', new Date('2024-01-03T00:00:00.000Z'), [0.98, 0.02, 0]));
      state.loaded.push(makeMemWithEmbedding('m-drop', 'Drop me', new Date('2024-01-04T00:00:00.000Z'), [0, 1, 0]));
      state.loadedMemIds.add('m-keep1');
      state.loadedMemIds.add('m-keep2');
      state.loadedMemIds.add('m-keep3');
      state.loadedMemIds.add('m-drop');
      state.oooCounter = 0;

      // remember() returns 1 new mem pushing oooCounter to 1 (= threshold)
      const trigger = makeMemWithEmbedding('m-trigger', 'Trigger', new Date('2024-01-05T00:00:00.000Z'), [1, 0, 0]);
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([trigger]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-stale-dropped', 'fragment', 'ctx1');

      // The stale mem (orthogonal to focus) must be dropped
      const ids = state.loaded.map(m => m.id);
      expect(ids).not.toContain('m-drop');
    });

    it('survivors are ordered chronologically by closedAt after rebuild', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 1 });
      const state = f.getOrCreateSession('s-sorted');

      // focus: [1, 0, 0]
      state.focus = [1, 0, 0];

      // 3 mems in non-chronological order (to verify rebuild sorts them)
      state.loaded.push(makeMemWithEmbedding('m-late', 'Late mem', new Date('2024-03-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m-early', 'Early mem', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m-mid', 'Mid mem', new Date('2024-02-01T00:00:00.000Z'), [1, 0, 0]));
      state.loadedMemIds.add('m-late');
      state.loadedMemIds.add('m-early');
      state.loadedMemIds.add('m-mid');
      state.oooCounter = 0;

      // remember() triggers rebuild
      const trigger = makeMemWithEmbedding('m-t', 'T', new Date('2024-04-01T00:00:00.000Z'), [1, 0, 0]);
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([trigger]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-sorted', 'fragment', 'ctx1');

      // Survivors should be in chronological order (closedAt ascending)
      const ids = state.loaded.map(m => m.id);
      // m-early (Jan), m-mid (Feb), m-late (Mar) — plus m-t (Apr) added before rebuild fires
      const earlyIdx = ids.indexOf('m-early');
      const midIdx = ids.indexOf('m-mid');
      const lateIdx = ids.indexOf('m-late');
      expect(earlyIdx).toBeGreaterThanOrEqual(0);
      expect(midIdx).toBeGreaterThanOrEqual(0);
      expect(lateIdx).toBeGreaterThanOrEqual(0);
      expect(earlyIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(lateIdx);
    });

    it('cachePoint is reset to loaded.length after rebuild', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 1 });
      const state = f.getOrCreateSession('s-cachepoint-reset');

      state.focus = [1, 0, 0];
      state.loaded.push(makeMemWithEmbedding('m1', 'S1', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m2', 'S2', new Date('2024-01-02T00:00:00.000Z'), [1, 0, 0]));
      state.loadedMemIds.add('m1');
      state.loadedMemIds.add('m2');
      state.cachePoint = 0; // old cachePoint
      state.oooCounter = 0;

      const trigger = makeMemWithEmbedding('m-t', 'T', new Date('2024-01-03T00:00:00.000Z'), [1, 0, 0]);
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([trigger]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-cachepoint-reset', 'fragment', 'ctx1');

      // After rebuild: cachePoint == loaded.length (all are stable prefix)
      expect(state.cachePoint).toBe(state.loaded.length);
    });

    it('oooCounter is reset to 0 after rebuild', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 2 });
      const state = f.getOrCreateSession('s-ooocounter-reset');

      state.focus = [1, 0, 0];
      state.loaded.push(makeMemWithEmbedding('m1', 'S1', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loadedMemIds.add('m1');
      state.oooCounter = 1; // need 1 more to reach threshold of 2

      const triggers = [
        makeMemWithEmbedding('m-t1', 'T1', new Date('2024-01-02T00:00:00.000Z'), [1, 0, 0]),
        makeMemWithEmbedding('m-t2', 'T2', new Date('2024-01-03T00:00:00.000Z'), [1, 0, 0]),
      ];
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce(triggers);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-ooocounter-reset', 'fragment', 'ctx1');

      expect(state.oooCounter).toBe(0);
    });

    it('loadedMemIds is rebuilt to match loaded array after rebuild', async () => {
      const f = new ContextFactory(store, embeddingService, { rebuildThreshold: 1 });
      const state = f.getOrCreateSession('s-memids-rebuilt');

      state.focus = [1, 0, 0];

      // 4 mems: 3 relevant, 1 stale to be dropped
      state.loaded.push(makeMemWithEmbedding('m-keep1', 'K1', new Date('2024-01-01T00:00:00.000Z'), [1, 0, 0]));
      state.loaded.push(makeMemWithEmbedding('m-keep2', 'K2', new Date('2024-01-02T00:00:00.000Z'), [0.99, 0.01, 0]));
      state.loaded.push(makeMemWithEmbedding('m-keep3', 'K3', new Date('2024-01-03T00:00:00.000Z'), [0.98, 0.02, 0]));
      state.loaded.push(makeMemWithEmbedding('m-drop', 'Drop', new Date('2024-01-04T00:00:00.000Z'), [0, 1, 0]));
      state.loadedMemIds.add('m-keep1');
      state.loadedMemIds.add('m-keep2');
      state.loadedMemIds.add('m-keep3');
      state.loadedMemIds.add('m-drop');
      state.oooCounter = 0;

      const trigger = makeMemWithEmbedding('m-t', 'T', new Date('2024-01-05T00:00:00.000Z'), [1, 0, 0]);
      vi.mocked(store.searchMemsByVector!).mockResolvedValueOnce([trigger]);
      vi.mocked(store.getActiveChunkIds!).mockResolvedValueOnce(new Set());
      await f.remember('s-memids-rebuilt', 'fragment', 'ctx1');

      // loadedMemIds must exactly match the IDs in loaded
      const loadedIds = new Set(state.loaded.map(m => m.id));
      expect(state.loadedMemIds).toEqual(loadedIds);
      // dropped mem must not be in loadedMemIds
      expect(state.loadedMemIds.has('m-drop')).toBe(false);
    });
  });
});
