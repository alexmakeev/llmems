// src/__tests__/openrouter-chat-debounce.test.ts
// Tests for background summarization debounce behavior in OpenRouterChat.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterChat } from '../openrouter-chat.ts';
import { ok } from '../shared/result.ts';
import type { LLMem, RecallMemoryResult } from '../openrouter-chat.ts';
import { InMemoryMemStore } from '../services/mem-manager.ts';

// ── Helpers ──

/** Create a minimal mock of LLMem with store() and recall() that succeed. */
function createMockLLMem(): LLMem {
  return {
    contextId: 'test-context',
    store: vi.fn().mockResolvedValue(ok({ stored: true })),
    recall: vi.fn().mockResolvedValue(
      ok({
        recall: { nodes: [] },
      } as RecallMemoryResult),
    ),
  } as unknown as LLMem;
}

/** Build a fetch response that mimics OpenRouter success (plain text). */
function mockFetchResponse(content: string): Response {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
    text: () => Promise.resolve(content),
  } as unknown as Response;
}

/**
 * Build a fetch response for the background summarization LLM call.
 * Returns zero topics + all chunks as tail (no topic closure) so no second LLM call is needed.
 */
function mockBackgroundResponse(): Response {
  return mockFetchResponse(
    JSON.stringify({ topics: [], tailChunkIds: [] }),
  );
}

describe('background summarization debounce', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock global fetch — each call returns a plain text response by default.
    // Tests override specific calls as needed.
    fetchSpy = vi.fn()
      // Default: return a chat response for prompt(), then a background response
      .mockResolvedValue(mockFetchResponse('LLM response'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createChat(debounceMs: number): OpenRouterChat {
    vi.stubGlobal('fetch', fetchSpy);
    return new OpenRouterChat({
      apiKey: 'test-key',
      systemPrompt: 'test',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: debounceMs,
    });
  }

  it('does not run summarization before debounce timeout', async () => {
    const DEBOUNCE_MS = 1000;
    const chat = createChat(DEBOUNCE_MS);

    // prompt() makes exactly 1 fetch call (the main LLM call)
    await chat.prompt('hello');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance time by less than the debounce — background should NOT fire
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('runs summarization after debounce timeout', async () => {
    const DEBOUNCE_MS = 1000;
    const chat = createChat(DEBOUNCE_MS);

    // First call returns chat response; second call returns background response
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('LLM response'))
      .mockResolvedValueOnce(mockBackgroundResponse());

    await chat.prompt('hello');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past debounce — background summarization should fire
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Background summarization calls getActiveChunks → sees chunks → calls callOpenRouter
    // That's at least 1 more fetch call (the detection LLM call)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('multiple prompts within debounce window result in single summarization', async () => {
    const DEBOUNCE_MS = 1000;
    const chat = createChat(DEBOUNCE_MS);

    // 3 prompt() calls + 1 background call = 4 expected fetches total
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('response 1'))
      .mockResolvedValueOnce(mockFetchResponse('response 2'))
      .mockResolvedValueOnce(mockFetchResponse('response 3'))
      .mockResolvedValueOnce(mockBackgroundResponse());

    // Send 3 prompts rapidly (each resets the debounce timer)
    await chat.prompt('message 1');
    await chat.prompt('message 2');
    await chat.prompt('message 3');

    // 3 main LLM calls so far
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Advance past the debounce — only 1 background summarization should fire
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Exactly 1 additional fetch for background (the detection call).
    // If debounce were broken (3 timers firing), we'd see 3 extra calls.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('debounce resets on new message', async () => {
    const DEBOUNCE_MS = 1000;
    const chat = createChat(DEBOUNCE_MS);

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('response 1'))
      .mockResolvedValueOnce(mockFetchResponse('response 2'))
      .mockResolvedValueOnce(mockBackgroundResponse());

    // First prompt starts the debounce timer
    await chat.prompt('message 1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance 500ms (half the debounce)
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second prompt resets the timer
    await chat.prompt('message 2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Advance another 500ms — only 500ms since last trigger, not enough
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Advance remaining 500ms to reach full debounce from last trigger
    await vi.advanceTimersByTimeAsync(500);

    // Now background should have fired — 1 extra fetch
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
