// src/__tests__/mocks/index.ts
// Mock implementations for testing

import { ok, err } from '../../shared/result.ts';
import type { Result } from '../../shared/result.ts';
import type {
  IKnowledgeStore,
  ILLMExtractor,
  KnowledgeNode,
  KnowledgeStoreError,
  ExtractionResult,
  LLMExtractorError,
} from '../../types.ts';

/**
 * Mock Knowledge Store for testing
 */
export class MockKnowledgeStore implements IKnowledgeStore {
  storedNodes: KnowledgeNode[] = [];
  queryResults: KnowledgeNode[] = [];
  shouldFail = false;
  failureType: KnowledgeStoreError['type'] = 'save_failed';

  async save(node: KnowledgeNode): Promise<Result<void, KnowledgeStoreError>> {
    if (this.shouldFail) {
      return err({
        type: this.failureType,
        message: 'Mock store failure',
      });
    }

    this.storedNodes.push(node);
    return ok(undefined);
  }

  async query(
    projectId: string,
    _text: string
  ): Promise<Result<KnowledgeNode[], KnowledgeStoreError>> {
    if (this.shouldFail) {
      return err({
        type: 'query_failed',
        message: 'Mock query failure',
      });
    }

    const filtered = this.queryResults.filter((node) => node.projectId === projectId);
    return ok(filtered);
  }

  async queryByTags(
    projectId: string,
    _tags: string[]
  ): Promise<Result<KnowledgeNode[], KnowledgeStoreError>> {
    if (this.shouldFail) {
      return err({
        type: 'query_failed',
        message: 'Mock query by tags failure',
      });
    }

    const filtered = this.queryResults.filter((node) => node.projectId === projectId);
    return ok(filtered);
  }

  reset(): void {
    this.storedNodes = [];
    this.queryResults = [];
    this.shouldFail = false;
    this.failureType = 'save_failed';
  }
}

/**
 * Mock LLM Extractor for testing
 */
export class MockLLMExtractor implements ILLMExtractor {
  extractResults: ExtractionResult = {
    meanings: [
      {
        text: 'Test extracted meaning',
        tags: ['test'],
      },
    ],
  };
  shouldFail = false;
  extractCallCount = 0;
  lastText: string | null = null;

  async extract(text: string): Promise<Result<ExtractionResult, LLMExtractorError>> {
    this.extractCallCount++;
    this.lastText = text;

    if (this.shouldFail) {
      return err({
        type: 'extraction_failed',
        message: 'Mock extractor failure',
      });
    }

    return ok(this.extractResults);
  }

  reset(): void {
    this.extractResults = {
      meanings: [
        {
          text: 'Test extracted meaning',
          tags: ['test'],
        },
      ],
    };
    this.shouldFail = false;
    this.extractCallCount = 0;
    this.lastText = null;
  }
}
