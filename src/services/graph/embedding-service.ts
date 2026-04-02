// src/services/graph/embedding-service.ts
// Embeds projection texts via OpenAI text-embedding-3-small (1536 dimensions).

import OpenAI from 'openai';
import { ok, err } from '../../shared/result.js';
import type { Result } from '../../shared/result.js';
import { createMemoryLogger } from '../../logging.js';
import type { MemoryLogger } from '../../logging.js';
import type { GraphConfig } from './types.js';
import { retrySleep } from '../../retry-sleep.js';

// ──────────────────────────────────────────────────────────────────────────────
// Interface
// ──────────────────────────────────────────────────────────────────────────────

export interface IGraphEmbeddingService {
  embedTexts(texts: string[]): Promise<Result<number[][], Error>>;
  embedSingle(text: string): Promise<Result<number[], Error>>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

/** OpenAI allows up to 2048 texts per batch request */
const MAX_BATCH_SIZE = 2048;

/** Retry delays in milliseconds (exponential backoff: 1s, 2s, 4s) */
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

const MAX_RETRIES = 3;

// ──────────────────────────────────────────────────────────────────────────────
// GraphEmbeddingService
// ──────────────────────────────────────────────────────────────────────────────

export class GraphEmbeddingService implements IGraphEmbeddingService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger: MemoryLogger;

  constructor(config: Pick<GraphConfig, 'openaiApiKey' | 'openaiBaseUrl' | 'openaiModel'>) {
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
    });
    this.model = config.openaiModel;
    this.logger = createMemoryLogger({ name: 'graph-embedding-service' });
  }

  /**
   * Embed an array of texts. Splits into batches of MAX_BATCH_SIZE automatically.
   * Returns a 1536-dimensional vector for each input text, in the same order.
   */
  async embedTexts(texts: string[]): Promise<Result<number[][], Error>> {
    if (texts.length === 0) return ok([]);

    const allEmbeddings: number[][] = [];

    // Process in batches
    for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + MAX_BATCH_SIZE);

      const batchResult = await this.embedBatchWithRetry(batch);
      if (!batchResult.ok) return batchResult;

      for (const embedding of batchResult.value) {
        allEmbeddings.push(embedding);
      }
    }

    return ok(allEmbeddings);
  }

  /**
   * Embed a single text. Convenience wrapper around embedTexts.
   */
  async embedSingle(text: string): Promise<Result<number[], Error>> {
    const result = await this.embedTexts([text]);
    if (!result.ok) return result;

    const first = result.value[0];
    if (first === undefined) {
      return err(new Error('embedSingle: empty result from API'));
    }
    return ok(first);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async embedBatchWithRetry(texts: string[]): Promise<Result<number[][], Error>> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 4000;
        this.logger.warn(
          { attempt, delayMs, batchSize: texts.length },
          'GraphEmbeddingService: retrying after error',
        );
        await retrySleep(delayMs);
      }

      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: texts,
          dimensions: 1536,
        });

        // Sort by index to guarantee order matches input
        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        const embeddings = sorted.map(item => item.embedding);

        this.logger.debug(
          { batchSize: texts.length, attempt },
          'GraphEmbeddingService: batch embedded',
        );

        return ok(embeddings);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.logger.error(
          { err: lastError.message, attempt, batchSize: texts.length },
          'GraphEmbeddingService: embedding API call failed',
        );
      }
    }

    return err(new Error(`Embedding failed after ${MAX_RETRIES} retries: ${lastError.message}`));
  }
}
