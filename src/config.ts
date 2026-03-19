// src/memory/config.ts
// Zod-validated configuration schema for the memory module

import { z } from 'zod';

/**
 * Configuration schema for the memory module.
 *
 * All external service credentials and connection details are defined here.
 * Validated at module creation time — fail fast on missing/invalid config.
 */
export const memoryModuleConfigSchema = z.object({
  // Embedding service (OpenRouter-compatible)
  embedding: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    model: z.string().default('qwen/qwen3-embedding-8b'),
  }),

  // LLM extractor (flat extraction pipeline)
  llmExtractor: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
  }),

  // Graph LLM extractor (entities + relationships)
  graphExtractor: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
  }),

  // Community detector settings
  community: z
    .object({
      apiKey: z.string().min(1),
      baseUrl: z.string().url().optional(),
      model: z.string().optional(),
    })
    .optional(),

  // Logger level override
  logLevel: z.string().optional(),

  /**
   * Whether to use entity nodes during recall.
   * When true (default), entity intersection search runs and finds knowledge nodes via entity hubs.
   * When false, entity intersection search is skipped entirely.
   * Only affects the recall path — entity nodes are still created during store/consolidation.
   */
  useEntityNodes: z.boolean().default(true),

  /**
   * Mem store backend for OpenRouterChat.
   * - 'memory' (default): InMemoryMemStore — mems live only in process memory
   * - 'postgres': PostgresMemStore — mems persisted in PostgreSQL
   *
   * MEM_STORE_TYPE env var: 'memory' | 'postgres' (default: 'memory')
   * POSTGRES_URL env var: PostgreSQL connection string (required when type='postgres')
   */
  memStore: z.object({
    type: z.enum(['memory', 'postgres']),
    postgres: z.object({
      connectionString: z.string(),
    }).optional(),
  }).default({
    type: (process.env['MEM_STORE_TYPE'] ?? 'memory') as 'memory' | 'postgres',
    ...(process.env['POSTGRES_URL'] ? {
      postgres: { connectionString: process.env['POSTGRES_URL'] },
    } : {}),
  }),
}).strict();

export type MemoryModuleConfig = z.infer<typeof memoryModuleConfigSchema>;
