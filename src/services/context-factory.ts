// src/services/context-factory.ts
// ContextFactory: session-scoped working state management for the ContextFactory API.
//
// Implements the §3 vision:
//   remember(sessionId, fragment, contextId) — mutates state
//   getCurrentContext(sessionId) — projects state to text (stub in this chunk)
//
// This chunk (vp3.3 + vp3.4 + vp3.6) covers:
//   - SessionWorkingState type
//   - ContextFactory class with in-memory Map<sessionId, state>
//   - Lazy session creation on first access, session isolation
//   - remember(): rawTail append, EMA focus shift, dedup mem load
//   - getCurrentContext() stubbed (throw 'not implemented')

import type { IMemStore, Mem } from '../types.js';
import type { IEmbeddingService } from '../openrouter-chat.js';

// ──────────────────────────────────────────────────────────────────────────────
// Session working state
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Raw fragment in the session tail — text + timestamp at which it was received.
 */
export interface RawFragment {
  content: string;
  receivedAt: Date;
}

/**
 * Per-session ephemeral working state for ContextFactory.
 *
 * Holds the current focus vector, the ordered list of mems loaded into the
 * session cache, dedup tracking, the raw tail of not-yet-indexed fragments,
 * and the out-of-order counter that triggers soft rebuilds.
 *
 * Keyed by sessionId inside ContextFactory. Shared long-term mem storage
 * (IMemStore) is separate and common to all sessions.
 */
export interface SessionWorkingState {
  /** Current session focus vector (embedding of recent fragments). Empty before first remember(). */
  focus: number[];
  /** Ordered list of mems loaded into the session cache (oldest first after rebuild). */
  loaded: Mem[];
  /** Set of mem IDs already in `loaded` — for O(1) dedup checks. */
  loadedMemIds: Set<string>;
  /**
   * Index into `loaded` marking the stable cache prefix boundary.
   * Mems at index < cachePoint are in the stable (KV-cacheable) prefix;
   * mems at index >= cachePoint were appended after focus shifts and are
   * in the dynamic tail. After a rebuild cachePoint is reset to loaded.length.
   */
  cachePoint: number;
  /** Raw fragments not yet indexed into mems (the live tail). */
  rawTail: RawFragment[];
  /**
   * Out-of-order append counter. Incremented each time remember() appends
   * new mems to the tail (outside cachePoint). Triggers soft rebuild when
   * it reaches config.rebuildThreshold.
   */
  oooCounter: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ContextFactory configuration.
 */
export interface ContextFactoryConfig {
  /**
   * Number of out-of-order mem appends before a soft rebuild is triggered.
   * Default: 30 (§9 approved default).
   */
  rebuildThreshold: number;

  /**
   * EMA alpha for focus shift: focus = normalize(focus*(1-alpha) + emb*alpha).
   * Range (0, 1]. Higher = more weight on the latest fragment.
   * Default: 0.5 (equal blend of history and new fragment).
   *
   * DESIGN FLAG: alpha=0.5 chosen as a balanced default — equal weight on previous
   * focus and new fragment. This is an implementation detail not mandated by vision.md.
   * Callers can tune this via config to be more reactive (higher alpha) or more
   * history-anchored (lower alpha).
   */
  alpha: number;

  /**
   * Number of nearest mems to retrieve via ANN search per remember() call.
   * Default: 10.
   */
  searchK: number;
}

const DEFAULT_CONFIG: ContextFactoryConfig = {
  rebuildThreshold: 30,
  alpha: 0.5,
  searchK: 10,
};

// ──────────────────────────────────────────────────────────────────────────────
// Vector math helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the L2 norm of a vector.
 */
function l2Norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

/**
 * Normalize a vector to unit length.
 * Returns the zero vector if the input norm is 0 (degenerate case).
 */
function normalize(v: number[]): number[] {
  const n = l2Norm(v);
  if (n === 0) return v.slice();
  return v.map(x => x / n);
}

/**
 * Compute the new EMA focus vector.
 *
 * Formula: focus_new = normalize(focus_prev * (1 - alpha) + emb * alpha)
 *
 * First-fragment case: if focus_prev is empty, focus_new = normalize(emb).
 *
 * DESIGN: EMA chosen because it:
 * 1. Is O(dim) per update — no history accumulation.
 * 2. Gives a smooth exponential decay over older fragments.
 * 3. Is deterministic and testable with fixed alpha.
 * 4. Stays on the unit hypersphere after normalization — compatible with
 *    cosine-distance ANN indexes used by searchMemsByVector.
 *
 * Alternative considered: simple mean (focus = normalize(mean of all embeddings)).
 * Rejected: loses recency bias and requires storing all embeddings.
 */
function shiftFocus(prevFocus: number[], emb: number[], alpha: number): number[] {
  const normEmb = normalize(emb);
  if (prevFocus.length === 0) {
    // First fragment: focus = normalize(emb)
    return normEmb;
  }
  const blended = prevFocus.map((f, i) => f * (1 - alpha) + normEmb[i]! * alpha);
  return normalize(blended);
}

// ──────────────────────────────────────────────────────────────────────────────
// ContextFactory
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ContextFactory: manages per-session working state for the context-factory API.
 *
 * The factory holds a Map<sessionId, SessionWorkingState> for all active sessions.
 * Sessions are created lazily on first access.
 *
 * Long-term mem storage (IMemStore) and embedding service (IEmbeddingService) are
 * injected at construction time — allowing any IMemStore implementation (in-memory
 * or PostgreSQL) to be used without changing the factory.
 *
 * This implementation covers session-state management only (vp3.3).
 * remember() and getCurrentContext() are stubbed — implemented in subsequent chunks.
 */
export class ContextFactory {
  /** Resolved configuration (public for test assertions). */
  readonly config: ContextFactoryConfig;

  private readonly store: IMemStore;
  private readonly embeddingService: IEmbeddingService;
  private readonly sessions = new Map<string, SessionWorkingState>();

  constructor(
    store: IMemStore,
    embeddingService: IEmbeddingService,
    config?: Partial<ContextFactoryConfig>,
  ) {
    this.store = store;
    this.embeddingService = embeddingService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Session management
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Returns the working state for the given sessionId, creating it lazily on
   * first access. Subsequent calls with the same sessionId return the same object.
   */
  getOrCreateSession(sessionId: string): SessionWorkingState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        focus: [],
        loaded: [],
        loadedMemIds: new Set<string>(),
        cachePoint: 0,
        rawTail: [],
        oooCounter: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Remember a fragment for a session.
   *
   * Steps (in order):
   *   1. Append fragment to session.rawTail.
   *   2. Embed the fragment and shift session.focus via EMA.
   *   3. Search for relevant mems using the updated focus.
   *   4. Apply dedup filter (Steps 4a+4b below) and push survivors into loaded.
   *   5. Increment oooCounter by survivor count.
   *
   * Dedup filter excludes:
   *   (a) Mems already in session.loadedMemIds (already shown to the model).
   *   (b) Mems whose source chunks are still active (raw-present signal).
   *       These become eligible once their chunks are archived (compaction).
   *
   * Soft-rebuild trigger: TODO (Chunk 3) — increment oooCounter here; the
   * rebuild check will go immediately after oooCounter is updated.
   *
   * @param sessionId - Identifies the session working state.
   * @param fragment  - Raw text fragment (user utterance or model answer).
   * @param contextId - Mem store scope (passed to store methods).
   */
  async remember(sessionId: string, fragment: string, contextId: string): Promise<void> {
    const session = this.getOrCreateSession(sessionId);

    // 1. Append raw fragment
    session.rawTail.push({ content: fragment, receivedAt: new Date() });

    // 2. Embed fragment and shift focus via EMA
    const embedResult = await this.embeddingService.embed(fragment);
    if (!embedResult.ok) {
      // Embedding failure is a hard error — caller must handle.
      // We do not silently skip: a bad focus vector leads to wrong mem retrieval.
      throw new Error(`Embedding failed: ${embedResult.error.message}`);
    }
    session.focus = shiftFocus(session.focus, embedResult.value.compact, this.config.alpha);

    // 3. Search for relevant mems using the updated focus
    const candidates = this.store.searchMemsByVector
      ? await this.store.searchMemsByVector(session.focus, this.config.searchK, contextId)
      : [];

    // 4. Dedup filter + get active chunk ids in one call
    const activeChunkIds = this.store.getActiveChunkIds
      ? await this.store.getActiveChunkIds(contextId)
      : new Set<string>();

    const survivors = candidates.filter((mem: Mem) => {
      // (a) Exclude already-loaded mems
      if (session.loadedMemIds.has(mem.id)) return false;
      // (b) Exclude mems whose source chunk is still raw-present (active)
      if (mem.chunkIds.some((chunkId: string) => activeChunkIds.has(chunkId))) return false;
      return true;
    });

    // 5. Push survivors into loaded state
    for (const mem of survivors) {
      session.loaded.push(mem);
      session.loadedMemIds.add(mem.id);
    }

    // 6. Increment oooCounter by survivors added
    session.oooCounter += survivors.length;

    // TODO (Chunk 3 — vp3.7): soft-rebuild check goes here.
    // if (session.oooCounter >= this.config.rebuildThreshold) { ... }
  }

  /**
   * Get the current context for a session as a serialized text block.
   * Stub: implemented in vp3.5 (context serialization).
   */
  async getCurrentContext(_sessionId: string): Promise<string> {
    throw new Error('not implemented');
  }
}
