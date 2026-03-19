// src/memory/index.ts
// Public barrel export for the memory module.
// Import everything consumers need from this single entry point.

// ============================================================
// Mem management
// ============================================================
export { MemManager, InMemoryMemStore } from './services/mem-manager.js';
export { PostgresMemStore } from './services/postgres-mem-store.js';
export { ChatManager } from './services/chat-manager.js';
export type {
  IMemStore,
  MemChunk,
  Mem,
  MemContextData,
} from './types.js';

// ============================================================
// OpenRouterChat (chat wrapper with memory + LLM inference)
// ============================================================
export { OpenRouterChat } from './openrouter-chat.js';
export type {
  OpenRouterChatOptions,
  ChatResponse,
} from './openrouter-chat.js';

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
