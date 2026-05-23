// src/__tests__/openrouter-chat-ask-response-format.test.ts
// RED test for the ask() structured-output bug.
//
// When OpenRouterChat is constructed WITH a responseFormat (a Zod schema),
// ask() must forward a strict json_schema `response_format`, a positive
// `max_tokens`, and `provider.require_parameters === true` to OpenRouter.
// Currently ask() sends a bare { model, messages } body, so models wrap JSON
// in ```json fences and truncate output. This test captures the outgoing
// request body and asserts the missing fields are present.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { OpenRouterChat } from '../openrouter-chat.ts';
import { ok } from '../shared/result.ts';
import type { LLMem, RecallMemoryResult } from '../openrouter-chat.ts';

// Mock retrySleep to avoid real delays if any retry path is hit.
vi.mock('../retry-sleep.ts', () => ({
  retrySleep: vi.fn().mockResolvedValue(undefined),
}));
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

/** Build a fetch response mimicking OpenRouter with a plain text body. */
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenRouterChat.ask() structured output request body', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(mockTextResponse('plain answer'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards strict json_schema response_format, max_tokens, and provider when responseFormat is configured', async () => {
    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: 999999,
      responseFormat: {
        schema: z.object({ answer: z.string() }),
      },
    });

    await chat.ask('What is the answer?');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
      response_format?: {
        type?: string;
        json_schema?: {
          strict?: boolean;
          schema?: { additionalProperties?: unknown };
        };
      };
      max_tokens?: number;
      provider?: { require_parameters?: boolean };
    };

    // Strict structured-output response_format must be present.
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(body.response_format?.json_schema?.schema).toBeTypeOf('object');
    expect(body.response_format?.json_schema?.schema).not.toBeNull();

    // Strict-mode requires the JSON schema to forbid extra properties.
    expect(body.response_format?.json_schema?.schema?.additionalProperties).toBe(false);

    // Output must not be truncated — a positive token cap must be sent.
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(0);

    // Provider must be told to honor the structured-output parameters.
    expect(body.provider?.require_parameters).toBe(true);
  });
});
