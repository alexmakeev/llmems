// src/memory/index.ts
// Public barrel export for the memory module.
// Import everything consumers need from this single entry point.

// ============================================================
// Mem management
// ============================================================
export { MemManager, InMemoryMemStore } from './services/mem-manager.ts';
export { PostgresMemStore } from './services/postgres-mem-store.ts';
export type {
  IMemStore,
  MemChunk,
  Mem,
  MemContextData,
} from './types.ts';

// ============================================================
// OpenRouterChat (chat wrapper with memory + LLM inference)
// ============================================================
export { OpenRouterChat } from './openrouter-chat.ts';
export type {
  OpenRouterChatOptions,
  ChatResponse,
} from './openrouter-chat.ts';

// ============================================================
// Config
// ============================================================
export { memoryModuleConfigSchema } from './config.ts';
export type { MemoryModuleConfig } from './config.ts';

// ============================================================
// Logging
// ============================================================
export { createMemoryLogger } from './logging.ts';
export type { MemoryLogger } from './logging.ts';
