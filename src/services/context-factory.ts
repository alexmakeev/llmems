// src/services/context-factory.ts
// ContextFactory: session-scoped working state management for the ContextFactory API.
//
// Implements the §3 vision:
//   remember(sessionId, fragment, contextId) — mutates state
//   getCurrentContext(sessionId) — projects state to text (pure projection)
//
// Covers (vp3.3 + vp3.4 + vp3.6 + vp3.7):
//   - SessionWorkingState type
//   - ContextFactory class with in-memory Map<sessionId, state>
//   - Lazy session creation on first access, session isolation
//   - remember(): rawTail append, EMA focus shift, dedup mem load, soft-rebuild trigger
//   - softRebuild(): drop stale mems by cosine-sim-to-focus, re-sort chronologically
//   - getCurrentContext(): serialize session state to sloyonka text (no DB calls)

import type { IVectorMemStore, Mem, IEmbeddingService } from '../types.js';
import type { BackgroundIndexer } from './background-indexer.js';

// ──────────────────────────────────────────────────────────────────────────────
// Session working state
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Raw fragment in the session tail — text + timestamp at which it was received.
 *
 * chunkId: the mem_chunk row ID returned by store.addChunk() for this fragment.
 * Set by remember() after persisting the fragment. Used by S1.4 rawTail drain
 * to identify which chunks were archived by the indexer.
 */
export interface RawFragment {
  content: string;
  receivedAt: Date;
  /** ID of the mem_chunk row persisted for this fragment by store.addChunk(). */
  chunkId: string;
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
  /**
   * Established embedding dimension for this session. Set on the first embedding received.
   * All subsequent embeddings must match this dimension or remember() throws a clear error.
   * null before the first remember() call.
   */
  focusDim: number | null;
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

  /**
   * Short natural-language marker inserted immediately before the block of
   * dynamically-loaded mems (vision §4 layer 2+). Appears once per serialized
   * context when there is at least one dynamic mem.
   *
   * Language auto-detection is out of Phase-1 scope. The marker is configurable:
   * callers who know the conversation language should pass the appropriate
   * translation here. Default is English.
   *
   * Default: "Loaded from memory:"
   */
  markerText: string;

  /**
   * Fraction of mems to retain during soft-rebuild (§5).
   * Range (0, 1]. After rebuild, the top ceil(loaded.length * keepRatio) mems
   * ranked by cosine similarity to current focus are retained; the rest are dropped.
   *
   * DESIGN: cosine-sim-to-focus is the cheapest deterministic staleness proxy
   * available without a store round-trip — aligns with the rebuild goal
   * ("drop stale and irrelevant") and uses data already in memory.
   * keepRatio avoids a hard threshold that would require empirical tuning.
   *
   * Default: 0.7 (keep 70% of mems, drop 30% least relevant to current focus).
   */
  keepRatio: number;

  /**
   * Number of active mem_chunks required to trigger background indexing.
   * At the end of remember(), if store.getActiveChunkIds(contextId).size >= indexThreshold,
   * BackgroundIndexer.index(contextId) is triggered (fire-and-forget with concurrency guard).
   *
   * Default: 16 (§ epic spec).
   */
  indexThreshold: number;
}

const DEFAULT_CONFIG: ContextFactoryConfig = {
  rebuildThreshold: 30,
  alpha: 0.5,
  searchK: 10,
  markerText: 'Loaded from memory:',
  keepRatio: 0.7,
  indexThreshold: 16,
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
 * Compute cosine similarity between two unit-normalized vectors.
 * Both inputs are assumed to already be on the unit hypersphere (as produced
 * by normalize()). Returns a value in [-1, 1] — higher means more similar.
 * Returns 0 for empty or mismatched-dimension vectors (degenerate case).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  return a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
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
 * Implements the full Phase-1 context-factory API (vp3.3–vp3.7):
 * remember() mutates session state; getCurrentContext() serializes it.
 */
export class ContextFactory {
  /** Resolved configuration (public for test assertions). */
  readonly config: ContextFactoryConfig;

  private readonly store: IVectorMemStore;
  private readonly embeddingService: IEmbeddingService;
  private readonly indexer: BackgroundIndexer;
  private readonly sessions = new Map<string, SessionWorkingState>();

  /**
   * Set of contextIds for which a BackgroundIndexer.index() run is currently in progress.
   * Guards against concurrent index runs for the same contextId.
   *
   * DESIGN: fire-and-forget trigger style — remember() returns immediately after
   * launching the indexer task. The guard ensures at most one concurrent indexer
   * run per contextId. Tests inject a slow indexer.index mock and call remember()
   * twice to verify the guard: the second call must not enqueue a second run.
   * This makes concurrency behaviour deterministic in tests.
   */
  private readonly indexingContextIds = new Set<string>();

  /**
   * Stash for archivedChunkIds returned by the last completed indexer run per contextId.
   * S1.4 rawTail drain will read this map to remove rawTail entries whose chunks
   * were archived, and clear processed entries.
   *
   * Written by: remember() after indexer.index() resolves.
   * Read/cleared by: S1.4 rawTail drain (not yet implemented).
   */
  private readonly pendingArchivedChunkIds = new Map<string, string[]>();

  /**
   * Constructs a ContextFactory.
   *
   * @param store - A store that implements IVectorMemStore (must support
   *   searchMemsByVector and getActiveChunkIds). PostgresMemStore satisfies this.
   *   InMemoryMemStore does NOT — passing it here is a compile error by design.
   * @param embeddingService - Embedding service for focus vector updates.
   * @param indexer - BackgroundIndexer for archiving active chunks into mems.
   *   Required (no optional fallback) — consistent with IVectorMemStore requirement.
   * @param config - Optional configuration overrides.
   */
  constructor(
    store: IVectorMemStore,
    embeddingService: IEmbeddingService,
    indexer: BackgroundIndexer,
    config?: Partial<ContextFactoryConfig>,
  ) {
    this.store = store;
    this.embeddingService = embeddingService;
    this.indexer = indexer;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns the stashed archivedChunkIds from the last completed indexer run
   * for the given contextId, or an empty array if none.
   *
   * Seam for S1.4 rawTail drain. S1.4 will call this, drain rawTail entries
   * whose chunkId is in this list, then clear the entry.
   */
  getPendingArchivedChunkIds(contextId: string): string[] {
    return this.pendingArchivedChunkIds.get(contextId) ?? [];
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
        focusDim: null,
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
   * Soft-rebuild trigger: after incrementing oooCounter, triggers softRebuild()
   * when oooCounter reaches config.rebuildThreshold (§5).
   *
   * @param sessionId - Identifies the session working state.
   * @param fragment  - Raw text fragment (user utterance or model answer).
   * @param contextId - Mem store scope (passed to store methods).
   */
  async remember(sessionId: string, fragment: string, contextId: string): Promise<void> {
    const session = this.getOrCreateSession(sessionId);

    // 1. Persist fragment as mem_chunk and append to rawTail.
    //    addChunk is called before embed so the chunk exists in the store even
    //    if embedding fails (rawTail behaviour is unchanged — fragment is appended
    //    before the embed attempt, consistent with pre-S1.2 behaviour).
    const chunk = await this.store.addChunk(fragment, new Date(), contextId);
    session.rawTail.push({ content: fragment, receivedAt: chunk.timestamp, chunkId: chunk.id });

    // 2. Embed fragment and shift focus via EMA
    const embedResult = await this.embeddingService.embed(fragment);
    if (!embedResult.ok) {
      // Embedding failure is a hard error — caller must handle.
      // We do not silently skip: a bad focus vector leads to wrong mem retrieval.
      throw new Error(`Embedding failed: ${embedResult.error.message}`);
    }
    // DIMENSION CONTRACT: IEmbeddingService.embed().compact is 1536-dim in production
    // (the field name "compact" is a historical artefact from an earlier multi-resolution
    // embedding design). This 1536-dim vector becomes session.focus and is compared
    // in softRebuild() against mem.embeddings.full (also 1536-dim, from mems.embedding
    // DB column). Do NOT substitute a smaller embedding here — dimension must match.
    // Rename cleanup is deferred to bead llmems-fqx.
    //
    // DIMENSION ASSERTION: fail fast on mismatch rather than silently corrupting focus.
    // A dimension mismatch would produce a focus vector on the wrong hypersphere,
    // leading to incorrect cosine similarity results in searchMemsByVector and softRebuild.
    const embeddingVector = embedResult.value.compact;
    if (session.focusDim === null) {
      // First embedding: establish the session's dimension contract.
      session.focusDim = embeddingVector.length;
    } else if (embeddingVector.length !== session.focusDim) {
      throw new Error(
        `Embedding dimension mismatch: expected ${session.focusDim}, got ${embeddingVector.length}. ` +
        `Ensure the embedding service returns consistent vector lengths within a session.`,
      );
    }
    session.focus = shiftFocus(session.focus, embeddingVector, this.config.alpha);

    // 3. Search for relevant mems using the updated focus
    const candidates = await this.store.searchMemsByVector(session.focus, this.config.searchK, contextId);

    // 4. Dedup filter + get active chunk ids in one call
    const activeChunkIds = await this.store.getActiveChunkIds(contextId);

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

    // Soft-rebuild check (vp3.7): trigger when oooCounter reaches the threshold.
    if (session.oooCounter >= this.config.rebuildThreshold) {
      this.softRebuild(session);
    }

    // Background indexer trigger: fire when active chunk count reaches indexThreshold.
    //
    // DESIGN: fire-and-forget. remember() returns immediately; indexer runs asynchronously.
    // Concurrency guard (indexingContextIds Set) ensures at most one concurrent run per
    // contextId. If the indexer is already running for this contextId, this call is a no-op.
    //
    // activeChunkIds was already fetched above for the dedup filter — reused here to
    // avoid a second DB round-trip. The count reflects the state at dedup time, which
    // is the correct signal: it includes the chunk just added by addChunk() above.
    if (activeChunkIds.size >= this.config.indexThreshold && !this.indexingContextIds.has(contextId)) {
      this.indexingContextIds.add(contextId);
      this.indexer.index(contextId).then((archivedChunkIds) => {
        // Stash archivedChunkIds for S1.4 rawTail drain.
        // Overwrite any previously stashed ids — S1.4 will drain before the next trigger.
        this.pendingArchivedChunkIds.set(contextId, archivedChunkIds);
      }).catch(() => {
        // Indexer errors are non-fatal — remember() has already succeeded.
        // Stash empty array so S1.4 drain finds a clean state.
        this.pendingArchivedChunkIds.set(contextId, []);
      }).finally(() => {
        this.indexingContextIds.delete(contextId);
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Soft-rebuild (§5)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Soft-rebuild of the session working state (vision §5).
   *
   * Called when oooCounter reaches config.rebuildThreshold. Steps:
   *   1. Score all loaded mems by cosine similarity to current focus
   *      (using mem.embeddings.full — 1536-dim, same as session.focus).
   *      DIMENSION CONTRACT: session.focus is seeded from
   *      IEmbeddingService.embed().compact which is 1536-dim in production
   *      (the field name "compact" is a historical artefact).
   *      mem.embeddings.full maps from the DB column mems.embedding (also 1536-dim),
   *      which is the same column searchMemsByVector queries on.
   *   2. Keep the top ceil(loaded.length * config.keepRatio) mems by score;
   *      drop the rest (stale / lowest relevance to current focus).
   *   3. Sort survivors chronologically by closedAt ascending.
   *   4. Rebuild loadedMemIds to match the new loaded list exactly.
   *   5. Reset cachePoint to loaded.length (all survivors become stable prefix).
   *   6. Reset oooCounter to 0.
   *
   * DESIGN: cosine-sim-to-focus is the cheapest deterministic staleness proxy
   * available in-memory — no store round-trip, aligned with the rebuild goal
   * (drop least relevant to current focus). keepRatio avoids a hard threshold.
   *
   * Dedup handover: mems dropped from loaded lose their entry in loadedMemIds,
   * so they will be re-eligible for loading if returned by future ANN searches.
   * No special code needed — the dedup filter in remember() already uses
   * loadedMemIds as its exclusion set.
   */
  private softRebuild(session: SessionWorkingState): void {
    const keepCount = Math.max(1, Math.ceil(session.loaded.length * this.config.keepRatio));

    // Score each mem by cosine similarity to current focus.
    // DIMENSION CONTRACT: session.focus is seeded from IEmbeddingService.embed().compact
    // which in production is 1536-dim (despite the field name "compact" — naming artefact).
    // mems.embedding (DB column) is also 1536-dim and maps to mem.embeddings.full.
    // searchMemsByVector queries on mems.embedding (1536-dim), so focus and full are
    // always the same dimension. We compare against mem.embeddings.full to maintain
    // this consistency. For mems with no embedding data (empty array), score is 0 (treated as stale).
    const scored = session.loaded.map(mem => ({
      mem,
      score: cosineSimilarity(
        session.focus,
        normalize(mem.embeddings.full),
      ),
    }));

    // Sort descending by score to select top-K
    scored.sort((a, b) => b.score - a.score);
    const survivors = scored.slice(0, keepCount).map(s => s.mem);

    // Sort survivors chronologically by closedAt ascending
    survivors.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());

    // Update session state
    session.loaded = survivors;
    session.loadedMemIds = new Set(survivors.map(m => m.id));
    session.cachePoint = survivors.length; // all survivors become stable prefix
    session.oooCounter = 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Context serializer (§4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Serialize the current session working state to a single text block
   * ready for submission to an LLM (vision §4 "sloyonka" layer order).
   *
   * PURE PROJECTION — no store/DB calls. All data comes from in-memory state.
   *
   * Layer ordering (sloyonka):
   *   [1] Stable prefix: loaded mems at indices < cachePoint.
   *       These are KV-cacheable; rendered as <mem ts="...">...</mem>.
   *   [2+3 COLLAPSED] Dynamic block: loaded mems at indices >= cachePoint,
   *       preceded by the recalled-memory marker (config.markerText).
   *       Phase-1 simplification: vision §4 distinguishes layer 2 (mems
   *       loaded by focus-shift) from layer 3 (mems tied to raw unindexed
   *       tail), but SessionWorkingState holds a single flat `loaded` list
   *       without per-mem provenance tracking. All post-cachePoint mems are
   *       therefore rendered in one block. A future bead can split this if
   *       provenance tracking is added.
   *   [4] Raw tail: rawTail fragments in order, as plain text (no <mem> tags).
   *       Recomputed each call — never cached.
   *
   * Marker language: fully configurable via config.markerText. Auto-detection
   * is out of Phase-1 scope. Callers who know the conversation language should
   * pass the appropriate translation. Default is English.
   *
   * @param sessionId - The session to serialize. An unknown session is treated
   *   as empty (returns "").
   */
  async getCurrentContext(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return '';
    }

    const parts: string[] = [];

    // [1] Stable prefix (layer 1): mems at index < cachePoint
    const prefixMems = session.loaded.slice(0, session.cachePoint);
    for (const mem of prefixMems) {
      parts.push(this.serializeMem(mem));
    }

    // [2+3] Dynamic block (layers 2+3 collapsed): mems at index >= cachePoint
    const dynamicMems = session.loaded.slice(session.cachePoint);
    if (dynamicMems.length > 0) {
      parts.push(this.config.markerText);
      for (const mem of dynamicMems) {
        parts.push(this.serializeMem(mem));
      }
    }

    // [4] Raw tail: plain text, recomputed each call
    for (const fragment of session.rawTail) {
      parts.push(fragment.content);
    }

    return parts.join('\n').trimEnd();
  }

  /**
   * Escape a string for safe XML embedding.
   * Prevents context-poisoning: a summary containing <, >, or & would break
   * the <mem>...</mem> structure the LLM consumes.
   * Order matters: & must be escaped first to avoid double-escaping.
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Serialize a single mem to XML format: <mem ts="ISO8601">summary</mem>.
   * ts = mem.closedAt in ISO 8601 (UTC). summary is XML-escaped.
   */
  private serializeMem(mem: Mem): string {
    return `<mem ts="${mem.closedAt.toISOString()}">${this.escapeXml(mem.summary)}</mem>`;
  }
}
