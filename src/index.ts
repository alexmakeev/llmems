// src/memory/index.ts
// Public barrel export for the memory module.
// Import everything consumers need from this single entry point.

// ============================================================
// Mem management
// ============================================================
export { MemManager, InMemoryMemStore } from './services/mem-manager.js';
export { PostgresMemStore } from './services/postgres-mem-store.js';
export type {
  IMemStore,
  IVectorMemStore,
  MemChunk,
  Mem,
  MemContextData,
  RecallNode,
  RecallEdge,
  RecallResult,
  VocabularyTerm,
  IEmbeddingService,
  EmbeddingValue,
} from './types.js';

// ============================================================
// ContextFactory (session-scoped working state management)
// ============================================================
export { ContextFactory } from './services/context-factory.js';
export type {
  ContextFactoryConfig,
  SessionWorkingState,
  RawFragment,
} from './services/context-factory.js';

// ============================================================
// BackgroundIndexer + ILLMSummarizer port (needed by ContextFactory consumers)
// ============================================================
export { BackgroundIndexer } from './services/background-indexer.js';
export type { ILLMSummarizer } from './services/background-indexer.js';

// ============================================================
// LLMSummarizer — standalone concrete OpenAI-compatible summarizer
// ============================================================
export { LLMSummarizer } from './services/llm-summarizer.js';
export type { LLMSummarizerConfig } from './services/llm-summarizer.js';

// ============================================================
// Context quality metric (pure, deterministic, no IO)
// ============================================================
export { computeContextQualityScore, computeFocusRelevance, computeDedupCorrectness, computeChronologyIntegrity } from './services/context-metric.js';
export type {
  ContextQualityScore,
  ContextQualityInputs,
  ProvenanceMem,
} from './services/context-metric.js';

// ============================================================
// Result type utilities
// ============================================================
export type { Result } from './shared/result.js';
export { ok, err } from './shared/result.js';

// ============================================================
// Config
// ============================================================
export { memoryModuleConfigSchema } from './config.js';
export type { MemoryModuleConfig } from './config.js';

// ============================================================
// Logging
// ============================================================
export { createMemoryLogger } from './logging.js';
export type { MemoryLogger } from './logging.js';
