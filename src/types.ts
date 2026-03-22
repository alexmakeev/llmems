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
  buildMemContext(contextId: string): Promise<MemContextData>;
  applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] }; vocabulary?: { term: string; count: number }[] }[],
    tailChunkIds: string[],
    newGeneralSummary: string | null,
    contextId: string,
  ): Promise<void>;
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
