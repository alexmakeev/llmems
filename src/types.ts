// src/types.ts
// Types used by production code

/**
 * A domain-specific term extracted from conversation mems.
 * Used for vocabulary tracking and voice recognition improvement.
 */
export interface VocabularyTerm {
  term: string;
  count: number;
}

/**
 * A node returned from recall with graph expansion
 */
export interface RecallNode {
  id: string;
  text: string;
  tags: string[];
  entityType?: string;
  eventTime?: string;
  temporalContext?: string;
  sourceType?: string;    // who said it: 'user:stated' | 'user:approved' | 'worker:finding' | 'system:derived'
  sourceIntent?: string;  // nature of knowledge: 'intent' | 'fact' | 'observation'
  timestamp: number;
  similarity?: number;
  match: 'direct' | 'neighbor' | 'temporal';
  relation?: string; // edge type that connected this neighbor
  salience?: number; // 0-10 human significance score (default 5 when absent)
  tMentioned?: string; // ISO timestamp when this fact was mentioned in a session
  tInvalid?: string; // ISO timestamp when this fact was superseded (non-null = hidden by default)
  fragmentTitle?: string; // Zettelkasten fragment title for display in recall results
  fragmentType?: string;  // Zettelkasten card type: 'fact' | 'event' | 'belief' | 'plan' | 'problem' | 'insight'
}

/**
 * An edge returned from recall with graph expansion
 */
export interface RecallEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
}

/**
 * Result of recall — direct matches + neighbor nodes and edges
 */
export interface RecallResult {
  nodes: RecallNode[];
  edges: RecallEdge[];
}

/**
 * A single message entry in a conversation session.
 * Defined here to avoid a runtime dependency on the session module.
 */
export interface MessageEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

// ── Mem Management Types ──────────────────────────────────────────

/**
 * A single chunk within an active mem conversation
 */
export interface MemChunk {
  id: string;
  content: string;
  timestamp: Date;
}

/**
 * State of a closed (completed) mem
 */
export interface Mem {
  id: string;
  summary: string;
  chunkIds: string[];
  embeddings: {
    full: number[];    // 1024 dims
    compact: number[]; // 256 dims
    micro: number[];   // 64 dims
  };
  closedAt: Date;
}

// ── Embedding Service Types ───────────────────────────────────────

/**
 * Result type returned by IEmbeddingService.embed().
 * The `compact` field holds the embedding vector (1024-dim in production).
 * The field name "compact" is a historical artefact from an earlier multi-resolution
 * embedding design. Rename is deferred to bead llmems-fqx.
 */
export interface EmbeddingValue {
  compact: number[];
}

/**
 * Port: Embedding Service — generates embedding vectors for text.
 * Used by ContextFactory (focus shift) and OpenRouterChat (topic embeddings).
 */
export interface IEmbeddingService {
  embed(text: string): Promise<import('./shared/result.js').Result<EmbeddingValue, { message: string }>>;
}

/**
 * Port: Mem Store — storage interface for mem state
 *
 * All methods are async to support both in-memory and DB-backed implementations.
 * contextId is required on all methods for DB-backed stores (in-memory ignores it).
 */
export interface IMemStore {
  addChunk(content: string, timestamp: Date, contextId: string): Promise<MemChunk>;
  getActiveChunks(contextId: string): Promise<MemChunk[]>;
  getClosedMems(contextId: string, limit?: number): Promise<Mem[]>;
  getGeneralSummary(contextId: string): Promise<string>;
  updateGeneralSummary(summary: string, contextId: string): Promise<void>;
  removeOldestClosedMem(contextId: string): Promise<void>;
  getLastClosedMem(contextId: string): Promise<Mem | null>;
  getBehaviorInstructions?(contextId: string): Promise<string>;
  setBehaviorInstructions?(instructions: string, contextId: string): Promise<void>;
  getEstablishedVocabulary?(contextId: string, minCount?: number): Promise<VocabularyTerm[]>;
  getVocabulary?(contextId: string): Promise<VocabularyTerm[]>;
  /**
   * ANN vector search over mems.embedding (1024-dim) via HNSW cosine index.
   * Returns up to k Mem rows ordered by cosine distance (closest first), scoped to contextId.
   */
  searchMemsByVector?(vector: number[], k: number, contextId: string): Promise<Mem[]>;
  /**
   * Returns the set of mem_chunk IDs that are still in 'active' status (raw-present signal).
   * Used by ContextFactory dedup: a mem whose chunkIds overlap this set should not be loaded.
   */
  getActiveChunkIds?(contextId: string): Promise<Set<string>>;
  buildMemContext(contextId: string): Promise<MemContextData>;
  applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] }; vocabulary?: { term: string; count: number }[] }[],
    tailChunkIds: string[],
    newGeneralSummary: string | null,
    contextId: string,
  ): Promise<void>;
}

/**
 * Narrower store interface required by ContextFactory.
 *
 * ContextFactory needs vector search to function correctly — without it, remember()
 * would silently load zero mems, violating the one-path rule. By requiring these
 * methods at the constructor boundary, the type system enforces correctness.
 *
 * IMemStore keeps searchMemsByVector and getActiveChunkIds optional so that
 * InMemoryMemStore (which only implements the base interface) still satisfies
 * IMemStore. ContextFactory explicitly requires the narrower IVectorMemStore.
 *
 * PostgresMemStore satisfies IVectorMemStore. InMemoryMemStore does NOT (correct).
 */
export interface IVectorMemStore extends IMemStore {
  /**
   * ANN vector search over mems.embedding (1024-dim) via HNSW cosine index.
   * Returns up to k Mem rows ordered by cosine distance (closest first), scoped to contextId.
   */
  searchMemsByVector(vector: number[], k: number, contextId: string): Promise<Mem[]>;
  /**
   * Returns the set of mem_chunk IDs that are still in 'active' status (raw-present signal).
   * Used by ContextFactory dedup: a mem whose chunkIds overlap this set should not be loaded.
   */
  getActiveChunkIds(contextId: string): Promise<Set<string>>;
}

/**
 * Context data returned by MemManager for building LLM context
 */
export interface MemContextData {
  generalSummary: string;
  recentClosedMems: Mem[];  // last 2-3 closed mems
  lastClosedMem: Mem | null; // most recent, with summary
  activeChunks: MemChunk[];
}
