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
 * A mem that has been loaded into the session cache, tagged with its retrieval provenance.
 *
 * 'current' — retrieved by per-turn ANN search using the current fragment's embedding vector.
 * 'backbone' — retrieved at reconciliation time using the session/theme vector (sessionVec).
 *
 * Provenance is required by S2.7 (слоёнка layer split): current mems surface recency-relevant
 * context; backbone mems surface thematic context accumulated over the whole session.
 */
export type LoadedMem = Mem & { provenance: 'current' | 'backbone' };

/**
 * Per-session ephemeral working state for ContextFactory.
 *
 * Holds the ordered list of mems loaded into the session cache, dedup tracking,
 * the raw tail of not-yet-indexed fragments, and the out-of-order counter that
 * triggers soft rebuilds.
 *
 * Keyed by sessionId inside ContextFactory. Shared long-term mem storage
 * (IMemStore) is separate and common to all sessions.
 */
export interface SessionWorkingState {
  /**
   * Established embedding dimension for this session. Set on the first embedding received.
   * All subsequent embeddings must match this dimension or remember() throws a clear error.
   * null before the first remember() call.
   */
  focusDim: number | null;
  /** Ordered list of mems loaded into the session cache (oldest first after rebuild). */
  loaded: LoadedMem[];
  /** Set of mem IDs already in `loaded` — for O(1) dedup checks. */
  loadedMemIds: Set<string>;
  /**
   * Internal bookkeeping index reset by softRebuild to loaded.length
   * (all survivors become a fresh baseline after each rebuild).
   *
   * S2.7: cachePoint NO LONGER drives getCurrentContext rendering.
   * Layer assignment is now determined by mem.provenance ('backbone' | 'current').
   * cachePoint is retained because softRebuild still resets it as a coherence marker
   * and existing tests assert on its value post-rebuild.
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

  /**
   * Session/theme vector: normalized mean of embeddings.full over the last
   * sessionVecN closed mems for this context. Computed (and cached) at the
   * rawTail drain reconciliation point — i.e. the call to remember() that
   * follows a completed indexer run. null until the first recompute.
   *
   * S1.5 — computed here; NOT used for recall yet (Stage 2 S2.6).
   */
  sessionVec: number[] | null;
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

  /**
   * Number of most-recent closed mems to include when computing the session/theme vector.
   * Passed to store.getClosedMems(contextId, sessionVecN) at the rawTail drain
   * reconciliation point (after each completed indexer run).
   *
   * Default: 100.
   */
  sessionVecN: number;
}

const DEFAULT_CONFIG: ContextFactoryConfig = {
  rebuildThreshold: 30,
  searchK: 10,
  markerText: 'Loaded from memory:',
  keepRatio: 0.7,
  indexThreshold: 16,
  sessionVecN: 100,
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
        focusDim: null,
        loaded: [],
        loadedMemIds: new Set<string>(),
        cachePoint: 0,
        rawTail: [],
        oooCounter: 0,
        sessionVec: null,
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

    // S1.4 rawTail drain + S1.5 sessionVec recompute — reconciliation point.
    //
    // At the start of each remember() call, check if the background indexer has
    // completed a run for this context (stash non-empty). If so:
    //   (a) Remove rawTail entries whose chunkId was archived by the indexer run.
    //       Once a fragment's chunk is digested into a mem, it leaves rawTail (vp3.6 handover).
    //   (b) Recompute session.sessionVec as the normalized mean of the last sessionVecN
    //       closed mems (S1.5). Recomputed here because new mems were just created by the
    //       indexer — this is the earliest point the vector is stale and needs refreshing.
    //       sessionVec is NOT recomputed on every remember() to avoid per-call DB round-trips.
    //   (c) Clear the pending stash so it is not re-drained on the next remember() call.
    const pendingArchived = this.pendingArchivedChunkIds.get(contextId);
    if (pendingArchived !== undefined && pendingArchived.length > 0) {
      // (a) Drain: remove rawTail entries whose chunkId is in the archived set
      const archivedSet = new Set(pendingArchived);
      session.rawTail = session.rawTail.filter(frag => !archivedSet.has(frag.chunkId));

      // (b) Recompute sessionVec from the last sessionVecN closed mems
      const closedMems = await this.store.getClosedMems(contextId, this.config.sessionVecN);
      const validEmbeddings = closedMems
        .map(m => m.embeddings.full)
        .filter(emb => emb.length > 0);
      if (validEmbeddings.length > 0) {
        const dim = validEmbeddings[0]!.length;
        const mean = new Array<number>(dim).fill(0);
        for (const emb of validEmbeddings) {
          for (let i = 0; i < dim; i++) {
            mean[i]! += emb[i]!;
          }
        }
        for (let i = 0; i < dim; i++) {
          mean[i]! /= validEmbeddings.length;
        }
        session.sessionVec = normalize(mean);
      }
      // If validEmbeddings is empty, sessionVec stays null (cold-start).
    }

    // (c) Clear pending stash (whether or not there were archived chunks).
    // Clearing when pendingArchived exists (even if empty array) ensures idempotent behaviour.
    if (pendingArchived !== undefined) {
      this.pendingArchivedChunkIds.delete(contextId);
    }

    // S2.6 BACKBONE RECALL — session-vector recall at reconciliation (post-index only).
    //
    // When a fresh indexer run has completed (pendingArchived was non-empty), sessionVec
    // has just been recomputed above. We now perform a backbone search using sessionVec
    // to pull theme/canvas mems into the session. This is the ONLY place backbone search
    // runs — NOT on every remember() call.
    //
    // Cold-start guard: if sessionVec is null (no mems yet), skip backbone recall.
    if (pendingArchived !== undefined && pendingArchived.length > 0 && session.sessionVec !== null) {
      const backboneCandidates = await this.store.searchMemsByVector(
        session.sessionVec,
        this.config.searchK,
        contextId,
      );
      const backboneActiveChunkIds = await this.store.getActiveChunkIds(contextId);
      const backboneSurvivors = backboneCandidates.filter((mem: Mem) => {
        if (session.loadedMemIds.has(mem.id)) return false;
        if (mem.chunkIds.some((chunkId: string) => backboneActiveChunkIds.has(chunkId))) return false;
        return true;
      });
      for (const mem of backboneSurvivors) {
        const loadedMem: LoadedMem = { ...mem, provenance: 'backbone' };
        session.loaded.push(loadedMem);
        session.loadedMemIds.add(mem.id);
      }
      session.oooCounter += backboneSurvivors.length;
    }

    // 1. Persist fragment as mem_chunk and append to rawTail.
    //    addChunk is called before embed so the chunk exists in the store even
    //    if embedding fails (rawTail behaviour is unchanged — fragment is appended
    //    before the embed attempt, consistent with pre-S1.2 behaviour).
    const chunk = await this.store.addChunk(fragment, new Date(), contextId);
    session.rawTail.push({ content: fragment, receivedAt: chunk.timestamp, chunkId: chunk.id });

    // 2. Embed fragment and compute currentVec = normalize(embedding).
    //    currentVec is a fresh per-turn vector — no EMA accumulation. It is used
    //    directly for ANN recall and for softRebuild scoring.
    const embedResult = await this.embeddingService.embed(fragment);
    if (!embedResult.ok) {
      // Embedding failure is a hard error — caller must handle.
      // We do not silently skip: a bad embedding leads to wrong mem retrieval.
      throw new Error(`Embedding failed: ${embedResult.error.message}`);
    }
    // DIMENSION CONTRACT: IEmbeddingService.embed().compact is 1536-dim in production
    // (the field name "compact" is a historical artefact from an earlier multi-resolution
    // embedding design). currentVec is compared in softRebuild() against mem.embeddings.full
    // (also 1536-dim, from mems.embedding DB column). Do NOT substitute a smaller embedding
    // here — dimension must match. Rename cleanup is deferred to bead llmems-fqx.
    //
    // DIMENSION ASSERTION: fail fast on mismatch rather than silently producing wrong results.
    // A dimension mismatch would produce a currentVec on the wrong hypersphere, leading to
    // incorrect cosine similarity results in searchMemsByVector and softRebuild.
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
    // currentVec: unit-normalized embedding of the current fragment.
    // Used for: (a) ANN recall below, (b) softRebuild scoring.
    const currentVec = normalize(embeddingVector);

    // 3. Per-turn recall: search for relevant mems using currentVec (ONE query per turn).
    const candidates = await this.store.searchMemsByVector(currentVec, this.config.searchK, contextId);

    // 4. Dedup filter + get active chunk ids in one call
    const activeChunkIds = await this.store.getActiveChunkIds(contextId);

    const survivors = candidates.filter((mem: Mem) => {
      // (a) Exclude already-loaded mems (includes those added by backbone recall above)
      if (session.loadedMemIds.has(mem.id)) return false;
      // (b) Exclude mems whose source chunk is still raw-present (active)
      if (mem.chunkIds.some((chunkId: string) => activeChunkIds.has(chunkId))) return false;
      return true;
    });

    // 5. Push survivors into loaded state with provenance 'current'
    for (const mem of survivors) {
      const loadedMem: LoadedMem = { ...mem, provenance: 'current' };
      session.loaded.push(loadedMem);
      session.loadedMemIds.add(mem.id);
    }

    // 6. Increment oooCounter by survivors added (current recall only — backbone already added above)
    session.oooCounter += survivors.length;

    // Soft-rebuild check (vp3.7): trigger when oooCounter reaches the threshold.
    // Pass currentVec as the scoring reference: drop mems that diverge from the current topic.
    if (session.oooCounter >= this.config.rebuildThreshold) {
      this.softRebuild(session, currentVec);
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
   *   1. Score all loaded mems by cosine similarity to currentVec
   *      (using mem.embeddings.full — 1536-dim, same as currentVec).
   *      DIMENSION CONTRACT: currentVec is normalize(IEmbeddingService.embed().compact)
   *      which is 1536-dim in production (the field name "compact" is a historical artefact).
   *      mem.embeddings.full maps from the DB column mems.embedding (also 1536-dim),
   *      which is the same column searchMemsByVector queries on.
   *   2. Keep the top ceil(loaded.length * config.keepRatio) mems by score;
   *      drop the rest (stale / lowest relevance to current topic).
   *   3. Sort survivors chronologically by closedAt ascending.
   *   4. Rebuild loadedMemIds to match the new loaded list exactly.
   *   5. Reset cachePoint to loaded.length (all survivors become stable prefix).
   *   6. Reset oooCounter to 0.
   *
   * DESIGN: cosine-sim-to-currentVec is the cheapest deterministic staleness proxy
   * available in-memory — no store round-trip, aligned with the rebuild goal
   * (drop least relevant to current topic). keepRatio avoids a hard threshold.
   *
   * Dedup handover: mems dropped from loaded lose their entry in loadedMemIds,
   * so they will be re-eligible for loading if returned by future ANN searches.
   * No special code needed — the dedup filter in remember() already uses
   * loadedMemIds as its exclusion set.
   *
   * @param currentVec - The unit-normalized embedding of the current fragment.
   *   Used as the relevance scoring reference for this rebuild pass.
   */
  private softRebuild(session: SessionWorkingState, currentVec: number[]): void {
    const keepCount = Math.max(1, Math.ceil(session.loaded.length * this.config.keepRatio));

    // Score each mem by cosine similarity to currentVec.
    // DIMENSION CONTRACT: currentVec = normalize(IEmbeddingService.embed().compact)
    // which in production is 1536-dim (despite the field name "compact" — naming artefact).
    // mems.embedding (DB column) is also 1536-dim and maps to mem.embeddings.full.
    // searchMemsByVector queries on mems.embedding (1536-dim), so currentVec and full are
    // always the same dimension. We compare against mem.embeddings.full to maintain
    // this consistency. For mems with no embedding data (empty array), score is 0 (treated as stale).
    const scored = session.loaded.map(mem => ({
      mem,
      score: cosineSimilarity(
        currentVec,
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
   * Layer ordering (sloyonka — S2.7 provenance-based split):
   *   [1] BACKBONE block: all loaded mems with provenance === 'backbone'.
   *       Recalled at reconciliation time via session/theme vector. Stable
   *       between summarizations; prompt-cache friendly. No marker prefix.
   *   [2] CURRENT block: all loaded mems with provenance === 'current',
   *       preceded by the recalled-memory marker (config.markerText) when
   *       at least one such mem exists. Recalled per-turn via current-vector.
   *   [3] RAW TAIL: rawTail fragments in order, as plain text (no <mem> tags).
   *       Recomputed each call — never cached.
   *
   * Provenance is set by remember():
   *   'backbone' — backbone recall (session-vector search at reconciliation).
   *   'current'  — per-turn recall (current-vector ANN search each turn).
   *
   * DESIGN: grouping iterates session.loaded in insertion order and partitions
   * by provenance. Mems may be interleaved in state.loaded (backbone recall
   * happens before current recall within remember()), so we collect both
   * groups independently and render backbone first, then current.
   *
   * cachePoint / softRebuild: cachePoint is retained in SessionWorkingState as
   * an internal bookkeeping field (reset by softRebuild to survivors.length).
   * It is NOT used for rendering — provenance drives layer assignment. This
   * means cachePoint remains internally consistent across rebuilds without
   * affecting the sloyonka output.
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

    // Partition loaded mems by provenance in a single pass.
    const backboneMems: LoadedMem[] = [];
    const currentMems: LoadedMem[] = [];
    for (const mem of session.loaded) {
      if (mem.provenance === 'backbone') {
        backboneMems.push(mem);
      } else {
        currentMems.push(mem);
      }
    }

    // [1] BACKBONE block: stable, no marker
    for (const mem of backboneMems) {
      parts.push(this.serializeMem(mem));
    }

    // [2] CURRENT block: dynamic, preceded by marker (when non-empty)
    if (currentMems.length > 0) {
      parts.push(this.config.markerText);
      for (const mem of currentMems) {
        parts.push(this.serializeMem(mem));
      }
    }

    // [3] RAW TAIL: plain text, recomputed each call
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
