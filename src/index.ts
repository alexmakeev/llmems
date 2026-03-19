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
  MemChunk,
  Mem,
  MemContextData,
  RecallNode,
  RecallEdge,
} from './types.js';

// ============================================================
// OpenRouterChat (chat wrapper with memory + LLM inference)
// ============================================================
export { OpenRouterChat } from './openrouter-chat.js';
export type {
  OpenRouterChatOptions,
  ChatResponse,
  ToolDefinition,
  ChatResponseWithTools,
  LLMem,
  StoreResult,
  MemoryError,
  RecallMemoryResult,
} from './openrouter-chat.js';

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
