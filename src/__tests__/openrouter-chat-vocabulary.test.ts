// src/__tests__/openrouter-chat-vocabulary.test.ts
// Tests for getVocabulary callback injecting "Domain vocabulary" into system prompt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterChat } from '../openrouter-chat.ts';
import { ok } from '../shared/result.ts';
import type { LLMem, RecallMemoryResult } from '../openrouter-chat.ts';
import type { VocabularyTerm } from '../types.ts';
import { InMemoryMemStore } from '../services/mem-manager.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLLMem(): LLMem {
  return {
    contextId: 'test-context',
    store: vi.fn().mockResolvedValue(ok({ stored: true })),
    recall: vi.fn().mockResolvedValue(
      ok({
        recall: { nodes: [], edges: [] },
      } as RecallMemoryResult),
    ),
  } as unknown as LLMem;
}

function mockTextResponse(content: string): Response {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content, tool_calls: undefined } }],
      }),
    text: () => Promise.resolve(content),
  } as unknown as Response;
}

/** Extract the system message content from the captured fetch call body. */
function extractSystemContent(fetchSpy: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const call = fetchSpy.mock.calls[callIndex];
  if (!call) throw new Error(`No fetch call at index ${callIndex}`);
  const body = JSON.parse(call[1].body as string) as { messages: Array<{ role: string; content: string }> };
  const systemMsg = body.messages.find(m => m.role === 'system');
  if (!systemMsg) throw new Error('No system message in fetch call');
  return systemMsg.content;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getVocabulary callback in OpenRouterChat', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue(mockTextResponse('ok'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('injects vocabulary section when callback returns terms', async () => {
    const terms: VocabularyTerm[] = [
      { term: 'LLM', count: 5 },
      { term: 'embeddings', count: 3 },
    ];
    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: 999999,
      getVocabulary: async () => terms,
    });

    await chat.prompt('hello');

    const system = extractSystemContent(fetchSpy);
    expect(system).toContain('## Domain vocabulary');
    expect(system).toContain('- LLM');
    expect(system).toContain('- embeddings');
    expect(system).toContain('Established terms the user commonly uses:');
  });

  it('does not inject vocabulary section when callback returns empty array', async () => {
    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: 999999,
      getVocabulary: async () => [],
    });

    await chat.prompt('hello');

    const system = extractSystemContent(fetchSpy);
    expect(system).not.toContain('## Domain vocabulary');
  });

  it('does not inject vocabulary section when callback is not provided', async () => {
    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: 999999,
    });

    await chat.prompt('hello');

    const system = extractSystemContent(fetchSpy);
    expect(system).not.toContain('## Domain vocabulary');
  });

  it('vocabulary section appears after personality and before recent topics', async () => {
    const terms: VocabularyTerm[] = [{ term: 'RAG', count: 10 }];
    const memStore = new InMemoryMemStore();

    // Pre-populate two closed mems so "Recent topics discussed" section appears.
    // recentClosedMems = allClosed.slice(0, -1), so at least 2 mems are needed.
    const contextId = 'test-context';
    const chunk1 = await memStore.addChunk('user: first message', new Date(Date.now() - 200000), contextId);
    await memStore.applyBackgroundResult(
      [{
        summary: 'First topic summary',
        chunkIds: [chunk1.id],
        embeddings: { full: [], compact: [], micro: [] },
      }],
      [],
      null,
      contextId,
    );
    const chunk2 = await memStore.addChunk('user: second message', new Date(Date.now() - 100000), contextId);
    await memStore.applyBackgroundResult(
      [{
        summary: 'Second topic summary',
        chunkIds: [chunk2.id],
        embeddings: { full: [], compact: [], micro: [] },
      }],
      [],
      null,
      contextId,
    );

    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'My personality.',
      llmem: createMockLLMem(),
      memStore,
      backgroundDebounceMs: 999999,
      getVocabulary: async () => terms,
    });

    await chat.prompt('hello');

    const system = extractSystemContent(fetchSpy);

    const personalityPos = system.indexOf('## Your personality and instructions');
    const vocabularyPos = system.indexOf('## Domain vocabulary');
    const recentTopicsPos = system.indexOf('## Recent topics discussed');

    expect(personalityPos).toBeGreaterThanOrEqual(0);
    expect(vocabularyPos).toBeGreaterThanOrEqual(0);
    expect(recentTopicsPos).toBeGreaterThanOrEqual(0);

    // Vocabulary must come after personality
    expect(vocabularyPos).toBeGreaterThan(personalityPos);
    // Vocabulary must come before recent topics
    expect(vocabularyPos).toBeLessThan(recentTopicsPos);
  });
});
