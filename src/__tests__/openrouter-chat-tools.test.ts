// src/__tests__/openrouter-chat-tools.test.ts
// Tests for OpenRouterChat.promptWithTools — tool calling response parsing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterChat } from '../openrouter-chat.ts';
import { ok } from '../shared/result.ts';
import type { LLMem, RecallMemoryResult, ToolDefinition } from '../openrouter-chat.ts';

// Mock retrySleep to avoid real delays in retry tests
vi.mock('../retry-sleep.ts', () => ({
  retrySleep: vi.fn().mockResolvedValue(undefined),
}));
import { InMemoryMemStore } from '../services/mem-manager.ts';

// Minimal tool definitions for testing (replaces bot-specific TEST_TOOLS)
const TEST_TOOLS: ToolDefinition[] = [
  {
    type: 'function' as const,
    function: {
      name: 'stay_silent',
      description: 'Do not respond to the user.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_behavior_instructions',
      description: 'Update behavior instructions.',
      parameters: {
        type: 'object',
        properties: {
          new_instructions: { type: 'string', description: 'New instructions' },
        },
        required: ['new_instructions'],
      },
    },
  },
];

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

/** Build a fetch response mimicking OpenRouter with text only (no tool calls). */
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

/** Build a fetch response with tool calls and optional text. */
function mockToolCallResponse(
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>,
  content: string | null = null,
): Response {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{
          message: {
            content,
            tool_calls: toolCalls,
          },
        }],
      }),
    text: () => Promise.resolve(content ?? ''),
  } as unknown as Response;
}

/** Build a background summarization response (no-op). */
function mockBackgroundResponse(): Response {
  return mockTextResponse(JSON.stringify({ topics: [], tailChunkIds: [] }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OpenRouterChat.promptWithTools', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let chat: OpenRouterChat;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      model: 'test-model',
      backgroundDebounceMs: 999999, // prevent background calls from interfering
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('text-only response: text set, toolCalls empty', async () => {
    fetchSpy.mockResolvedValueOnce(mockTextResponse('Hello there!'));

    const result = await chat.promptWithTools('Hi', TEST_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('Hello there!');
    expect(result.value.toolCalls).toEqual([]);
  });

  it('tool call with no text: text null, toolCalls populated', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockToolCallResponse([{
        id: 'call_1',
        type: 'function',
        function: { name: 'stay_silent', arguments: '{}' },
      }]),
    );

    const result = await chat.promptWithTools('something', TEST_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBeNull();
    expect(result.value.toolCalls).toHaveLength(1);
    expect(result.value.toolCalls[0]!.function.name).toBe('stay_silent');
  });

  it('both text and tool call: both set', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockToolCallResponse(
        [{
          id: 'call_2',
          type: 'function',
          function: {
            name: 'set_behavior_instructions',
            arguments: JSON.stringify({ new_instructions: 'Be concise' }),
          },
        }],
        'I will update the instructions.',
      ),
    );

    const result = await chat.promptWithTools('Set behavior: Be concise', TEST_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('I will update the instructions.');
    expect(result.value.toolCalls).toHaveLength(1);
    expect(result.value.toolCalls[0]!.function.name).toBe('set_behavior_instructions');

    const args = JSON.parse(result.value.toolCalls[0]!.function.arguments);
    expect(args.new_instructions).toBe('Be concise');
  });

  it('stay_silent tool call has correct structure', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockToolCallResponse([{
        id: 'call_silent',
        type: 'function',
        function: { name: 'stay_silent', arguments: '{}' },
      }]),
    );

    const result = await chat.promptWithTools('random group message', TEST_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toolCalls[0]!.id).toBe('call_silent');
    expect(result.value.toolCalls[0]!.type).toBe('function');
    expect(result.value.toolCalls[0]!.function.name).toBe('stay_silent');
    expect(result.value.toolCalls[0]!.function.arguments).toBe('{}');
  });

  it('set_behavior_instructions arguments are preserved as JSON string', async () => {
    const instructionArgs = { new_instructions: 'Always respond in Russian' };
    fetchSpy.mockResolvedValueOnce(
      mockToolCallResponse([{
        id: 'call_bi',
        type: 'function',
        function: {
          name: 'set_behavior_instructions',
          arguments: JSON.stringify(instructionArgs),
        },
      }]),
    );

    const result = await chat.promptWithTools('set behavior', TEST_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.value.toolCalls[0]!.function.arguments);
    expect(parsed).toEqual(instructionArgs);
  });

  it('API error returns err result', async () => {
    // Must mock enough responses for all retry attempts (initial + 5 retries)
    const errorResponse = {
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    } as unknown as Response;
    for (let i = 0; i < 6; i++) {
      fetchSpy.mockResolvedValueOnce(errorResponse);
    }

    const result = await chat.promptWithTools('test', TEST_TOOLS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('query');
  });

  it('network error returns err result', async () => {
    // Must mock enough rejections for all retry attempts (initial + 5 retries)
    for (let i = 0; i < 6; i++) {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));
    }

    const result = await chat.promptWithTools('test', TEST_TOOLS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('query');
  });

  it('recall texts are returned from memory nodes', async () => {
    const llmem = createMockLLMem();
    (llmem.recall as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({
        recall: {
          nodes: [
            { id: 'n1', text: 'User likes cats', tags: [], timestamp: 1, match: 'direct' as const },
            { id: 'n2', text: 'User is vegetarian', tags: [], timestamp: 2, match: 'direct' as const },
          ],
          edges: [],
        },
      }),
    );

    const chatWithRecall = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'Test',
      llmem,
      memStore: new InMemoryMemStore(),
      model: 'test-model',
      backgroundDebounceMs: 999999,
    });

    fetchSpy.mockResolvedValueOnce(mockTextResponse('Noted!'));

    const result = await chatWithRecall.promptWithTools('Hello', TEST_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recall).toEqual(['User likes cats', 'User is vegetarian']);
  });
});
