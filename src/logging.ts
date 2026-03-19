// src/memory/logging.ts
// Standalone pino-based logger for the memory module
// Does NOT depend on AsyncLocalStorage or orchestrator-specific logging

import pino from 'pino';

export function createMemoryLogger(options?: { level?: string; name?: string }) {
  const baseOpts = {
    name: options?.name ?? 'memory-module',
    level: options?.level ?? (process.env['LOG_LEVEL'] ?? 'info'),
  };

  return pino(baseOpts);
}

export type MemoryLogger = ReturnType<typeof createMemoryLogger>;
