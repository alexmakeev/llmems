// src/services/context-factory.ts
// ContextFactory: session-scoped working state management for the ContextFactory API.
//
// Implements the §3 vision:
//   remember(sessionId, fragment) — mutates state (stub in this chunk)
//   getCurrentContext(sessionId) — projects state to text (stub in this chunk)
//
// This chunk (vp3.3) covers:
//   - SessionWorkingState type
//   - ContextFactory class with in-memory Map<sessionId, state>
//   - Lazy session creation on first access, session isolation
//   - remember() and getCurrentContext() stubbed (throw 'not implemented')

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
}

const DEFAULT_CONFIG: ContextFactoryConfig = {
  rebuildThreshold: 30,
};

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
  // Core API stubs (implemented in subsequent chunks)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Remember a fragment for a session.
   * Stub: implemented in vp3.4 (focus shift + mem loading).
   */
  async remember(_sessionId: string, _fragment: string): Promise<void> {
    throw new Error('not implemented');
  }

  /**
   * Get the current context for a session as a serialized text block.
   * Stub: implemented in vp3.5 (context serialization).
   */
  async getCurrentContext(_sessionId: string): Promise<string> {
    throw new Error('not implemented');
  }
}
