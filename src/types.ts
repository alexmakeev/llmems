// src/librarian/types.ts
// Librarian types using production conventions

import { z } from 'zod';
import type { Result } from './shared/result.js';

/**
 * Edge relationship types for knowledge graph
 */
export const edgeRelationTypes = [
  'temporal_before',
  'temporal_after',
  'caused_by',
  'same_topic',
  'elaborates',
  'contradicts',
  'contains',
  'occurred_during',
  'mentions',
  'sequence',
  'supports',
  'co_occurred',
  'questions',
  'follows',
  'causes',
  'synthesizes',
  'supersedes',
  'parallels',
] as const;
export type EdgeRelationType = typeof edgeRelationTypes[number];

/**
 * Metadata for knowledge graph edges — reason for the link, confidence score, and any extra fields.
 */
export interface EdgeMetadata {
  reason?: string;
  confidence?: number;
  [key: string]: unknown;
}

/**
 * Entity types for knowledge graph nodes
 */
export const entityTypes = [
  'person',
  'place',
  'concept',
  'event',
  'annual_event',
  'object',
  'fact',
  'session',
  'topic_segment',
  'proposition',
  'entity',
  'fragment',
] as const;
export type EntityType = typeof entityTypes[number];

/**
 * Source types for knowledge provenance — who produced this knowledge
 */
export const sourceTypes = ['user:stated', 'user:approved', 'worker:finding', 'system:derived'] as const;
export type SourceType = typeof sourceTypes[number];

/**
 * Source intents — the nature of the knowledge
 */
export const sourceIntents = ['intent', 'fact', 'observation'] as const;
export type SourceIntent = typeof sourceIntents[number];

/**
 * Knowledge Node schema - represents extracted knowledge stored in memory/database
 */
export const knowledgeNodeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  text: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source: z.string().min(1), // event type that produced this
  timestamp: z.number().int().positive(),
  entityType: z.enum(entityTypes).optional(),
  eventTime: z.string().optional(),
  temporalContext: z.string().optional(),
  sourceType: z.enum(sourceTypes).optional(),   // who said it
  sourceIntent: z.enum(sourceIntents).optional(), // intent vs fact
  sessionId: z.string().optional(),              // session that produced this node
  ingestedAt: z.string().optional(),             // ISO timestamp when node was ingested
  relevanceWeight: z.number().min(0).max(1).optional(), // 0-1 relevance weight for recall scoring
  salience: z.number().min(0).max(10).optional(), // 0-10 human significance score (default 5 when absent)
  tMentioned: z.string().optional(),       // ISO timestamp when this fact was mentioned in a session
  tValid: z.string().optional(),          // ISO datetime when fact was true
  tInvalid: z.string().optional(),        // ISO datetime when stopped being true
  tInvalidated: z.string().optional(),    // ISO datetime when revoked in system
  temporalSource: z.string().optional(),  // original temporal reference from text
  resolvedBy: z.enum(['chrono', 'llm', 'session_anchor']).optional(), // how temporal was resolved
  emotionalColoring: z.string().optional(),       // emotional tone of a proposition
  temporalMarkers: z.array(z.string()).optional(), // temporal context markers for a proposition
  propositionSource: z.string().optional(),        // which session/segment generated this proposition
  fragmentTitle: z.string().optional(),              // title of the Zettelkasten fragment this node belongs to
  fragmentType: z.enum(['fact', 'event', 'belief', 'plan', 'problem', 'insight']).optional(), // Zettelkasten card type
});
export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;

/**
 * Get salience score for a node — defaults to 5 if absent, clamped to [0, 10]
 */
export const getSalience = (node: KnowledgeNode): number =>
  Math.max(0, Math.min(10, node.salience ?? 5));

/**
 * LLM extraction result
 */
export const extractionResultSchema = z.object({
  meanings: z.array(
    z.object({
      text: z.string().min(1),
      tags: z.array(z.string()).default([]),
    })
  ),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/**
 * Extracted entity from graph LLM extraction
 */
export const extractedEntitySchema = z.object({
  text: z.string().min(1),
  entityType: z.enum(entityTypes),
  tags: z.array(z.string()).default([]),
  eventTime: z.string().optional(),
  temporalContext: z.string().optional(),
  salience: z.number().min(0).max(10).optional(), // 0-10 human significance score
});
export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;

/**
 * Extracted relationship between entities
 */
export const extractedRelationshipSchema = z.object({
  fromIndex: z.number().int().min(0),
  toIndex: z.number().int().min(0),
  type: z.enum(edgeRelationTypes),
  weight: z.number().min(0).max(1).default(1.0),
});
export type ExtractedRelationship = z.infer<typeof extractedRelationshipSchema>;

/**
 * Graph extraction result from LLM
 */
export const graphExtractionResultSchema = z.object({
  entities: z.array(extractedEntitySchema).min(0).max(12),
  relationships: z.array(extractedRelationshipSchema).default([]),
});
export type GraphExtractionResult = z.infer<typeof graphExtractionResultSchema>;

/**
 * Proposition extraction result from LLM — extracts atomic propositions and named entities
 */
export const propositionExtractionResultSchema = z.object({
  propositions: z.array(
    z.object({
      text: z.string().min(1),
      emotionalColoring: z.string().optional(),
      temporalMarkers: z.array(z.string()).optional(),
    })
  ),
  entities: z.array(
    z.object({
      name: z.string().min(1),
      entityType: z.enum(['person', 'place', 'concept', 'object', 'event']),
    })
  ),
});
export type PropositionExtractionResult = z.infer<typeof propositionExtractionResultSchema>;

/**
 * Librarian config
 */
export const librarianConfigSchema = z.object({
  /** Event types to watch (others ignored) */
  watchEventTypes: z.array(z.string()).default(['task_completed', 'worker_report']),
  /** Minimum text length to process (skip short messages) */
  minTextLength: z.number().int().positive().default(10),
});
export type LibrarianConfig = z.infer<typeof librarianConfigSchema>;

/**
 * Error types - using production convention: { type, message, raw? }
 */
export interface LibrarianError {
  type: string;
  message: string;
  raw?: unknown;
}

export interface KnowledgeStoreError {
  type: 'save_failed' | 'query_failed';
  message: string;
  raw?: unknown;
}

export interface LLMExtractorError {
  type: 'extraction_failed';
  message: string;
  raw?: unknown;
}

/**
 * Port: Knowledge Store
 */
export interface IKnowledgeStore {
  save(node: KnowledgeNode): Promise<Result<void, KnowledgeStoreError>>;
  query(projectId: string, text: string): Promise<Result<KnowledgeNode[], KnowledgeStoreError>>;
  queryByTags(projectId: string, tags: string[]): Promise<Result<KnowledgeNode[], KnowledgeStoreError>>;

  // New graph methods (optional — in-memory store doesn't implement them)
  findSimilar?(
    projectId: string,
    embedding: number[],
    limit?: number,
    minSimilarity?: number
  ): Promise<Result<(KnowledgeNode & { similarity: number })[], KnowledgeStoreError>>;

  saveWithDedup?(
    node: KnowledgeNode,
    embedding: { full: number[]; compact: number[] }
  ): Promise<Result<{ key: string; deduplicated: boolean }, KnowledgeStoreError>>;

  saveEdge?(
    fromKey: string,
    toKey: string,
    type: EdgeRelationType,
    weight?: number,
    metadata?: EdgeMetadata
  ): Promise<Result<void, KnowledgeStoreError>>;

  findSessionsByTimeRange?(
    contextId: string,
    from: Date,
    to: Date
  ): Promise<Result<KnowledgeNode[], KnowledgeStoreError>>;
}

/**
 * Port: LLM Extractor
 */
export interface ILLMExtractor {
  extract(text: string): Promise<Result<ExtractionResult, LLMExtractorError>>;
}

/**
 * Port: Graph LLM Extractor (extracts entities + relationships)
 */
export interface IGraphLLMExtractor {
  extract(text: string): Promise<Result<GraphExtractionResult, LLMExtractorError>>;
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
 * Port: Knowledge Context Provider
 */
export interface IKnowledgeContextProvider {
  enrich(projectId: string, description: string): Promise<Result<string, LibrarianError>>;
}

/**
 * Community LLM naming result schema — { label, summary }
 */
export const communityNamingSchema = z.object({
  label: z.string().min(1),
  summary: z.string().min(1),
});
export type CommunityNaming = z.infer<typeof communityNamingSchema>;

/**
 * Classification types for entity memory permanence
 */
export const entityClassificationTypes = ['permanent_fact', 'temporal_event', 'evolving_fact'] as const;
export type EntityClassificationType = typeof entityClassificationTypes[number];

/**
 * Zettelkasten fragment card types — classify the nature of the knowledge captured
 */
export const fragmentTypes = ['fact', 'event', 'belief', 'plan', 'problem', 'insight'] as const;
export type FragmentType = typeof fragmentTypes[number];

/**
 * Validate a fragment before persistence.
 * Returns true only if content, title, and fragmentType are all valid:
 * - content: non-null, non-undefined, non-empty, non-whitespace-only string
 * - title: non-null, non-undefined, non-empty, non-whitespace-only string
 * - fragmentType: must be one of the known fragmentTypes values
 */
export function isValidFragment(fragment: {
  content?: string | null;
  title?: string | null;
  fragmentType?: string | null;
}): boolean {
  if (typeof fragment.content !== 'string' || fragment.content.trim().length === 0) {
    return false;
  }
  if (typeof fragment.title !== 'string' || fragment.title.trim().length === 0) {
    return false;
  }
  if (typeof fragment.fragmentType !== 'string' || !(fragmentTypes as readonly string[]).includes(fragment.fragmentType)) {
    return false;
  }
  return true;
}

/**
 * Session analysis result schema — structured insights extracted from a conversation session
 */
export const sessionAnalysisResultSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  detailedSummary: z.string().optional(), // 2000-char comprehensive summary (optional — LLM may not always provide)
  sessionEnding: z.string().optional(),   // 1000-char description of how the session ended (optional)
  salience: z.number().min(0).max(10).optional(), // 0-10 overall session significance score
  topicSegments: z.array(
    z.object({
      title: z.string().min(1),
      startMessageIndex: z.number().int().min(0),
      endMessageIndex: z.number().int().min(0),
    })
  ),
  entityClassifications: z.array(
    z.object({
      entityText: z.string().min(1),
      classification: z.enum(entityClassificationTypes),
    })
  ),
  // Proposition extraction — temporal facts/events with emotional coloring
  propositions: z.array(
    z.object({
      text: z.string().min(1),
      emotionalColoring: z.string().optional(),
      temporalMarkers: z.array(z.string()).optional(),
      entities: z.array(z.string()),
    })
  ).optional(),
  // Named entity extraction — stable world vocabulary (people, places, etc.)
  extractedEntities: z.array(
    z.object({
      name: z.string().min(1),
      entityType: z.enum(['person', 'place', 'concept', 'object', 'event']),
    })
  ).optional(),
  // Zettelkasten fragments — self-contained knowledge cards (3-5 sentences each)
  fragments: z.array(
    z.object({
      title: z.string().min(1),
      content: z.string().min(1),
      entities: z.array(z.string()),
      type: z.enum(fragmentTypes),
    })
  ).optional(),
});
export type SessionAnalysisResult = z.infer<typeof sessionAnalysisResultSchema>;

/**
 * Result of resolving a temporal reference from text to a concrete date
 */
export interface TemporalResolution {
  date: Date | null;
  confidence: number; // 0-1
  source: 'chrono' | 'llm' | 'session_anchor';
  original: string;
}

/**
 * Inclusive date range (both ends required)
 */
export interface DateRange {
  from: Date;
  to: Date;
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

/**
 * Optional metadata for LLMem.store(text, metadata?).
 * Allows callers to provide additional context about the stored text.
 */
export interface StoreMetadata {
  /** Source identifier (e.g. 'chat', 'import', 'api') */
  source?: string;
  /** Session ID to associate the stored text with */
  sessionId?: string;
  /** Event date for temporal anchoring */
  eventDate?: Date;
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
  buildMemContext(contextId: string): Promise<MemContextData>;
  applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] } }[],
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

