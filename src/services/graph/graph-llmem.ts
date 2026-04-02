// src/services/graph/graph-llmem.ts
// Decorator around an existing LLMem that enriches recall results with graph edges.

import { createMemoryLogger } from '../../logging.js';
import type { MemoryLogger } from '../../logging.js';
import type { Result } from '../../shared/result.js';
import type {
  LLMem,
  StoreResult,
  MemoryError,
  RecallMemoryResult,
} from '../../openrouter-chat.js';
import { GraphRecall } from './graph-recall.js';

export class GraphEnrichedLLMem implements LLMem {
  readonly contextId: string;
  private readonly logger: MemoryLogger;

  constructor(
    private readonly inner: LLMem,
    private readonly graphRecall: GraphRecall,
  ) {
    this.contextId = inner.contextId;
    this.logger = createMemoryLogger({ name: 'graph-enriched-llmem' });
  }

  /**
   * Store: delegates to inner LLMem.
   * Graph processing is NOT done here — it happens asynchronously when mems are created
   * (triggered from the background summarization pipeline, not from every store() call).
   */
  async store(
    text: string,
    metadata?: { sessionId?: string },
  ): Promise<Result<StoreResult, MemoryError>> {
    return this.inner.store(text, metadata);
  }

  /**
   * Recall: delegates to inner LLMem, then enriches with graph edges.
   * On graph enrichment failure, logs a warning and returns the original result (graceful degradation).
   */
  async recall(query: string): Promise<Result<RecallMemoryResult, MemoryError>> {
    const innerResult = await this.inner.recall(query);

    if (!innerResult.ok) {
      return innerResult;
    }

    const enrichResult = await this.graphRecall.enrichRecall(
      innerResult.value.recall,
      this.contextId,
    );

    if (!enrichResult.ok) {
      this.logger.warn(
        { err: enrichResult.error.message, contextId: this.contextId },
        'GraphEnrichedLLMem.recall: graph enrichment failed, returning original result',
      );
      return innerResult;
    }

    return {
      ok: true,
      value: {
        recall: enrichResult.value,
      },
    };
  }
}
