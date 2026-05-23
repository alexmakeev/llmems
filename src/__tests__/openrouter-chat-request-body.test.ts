// src/__tests__/openrouter-chat-request-body.test.ts
// RED → GREEN tests for the UNIFIED OpenRouter request-body assembler.
//
// Goal: response_format (strict json_schema from the configured Zod schema),
// provider.require_parameters, and max_tokens must apply UNIFORMLY across every
// chat path — not just ask(). These tests capture the outgoing wire body via a
// fetch spy (mirroring openrouter-chat-ask-response-format.test.ts) and assert:
//
//   a. prompt() WITH configured responseFormat  → strict json_schema + provider + max_tokens
//   b. prompt() WITHOUT responseFormat          → no response_format/provider, but max_tokens
//   c. promptWithTools() WITH responseFormat     → tools present, response_format ABSENT, max_tokens
//   d. promptWithTools() WITHOUT schema          → tools + max_tokens, no response_format (regression guard)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { OpenRouterChat } from '../openrouter-chat.ts';
import { ok } from '../shared/result.ts';
import type { LLMem, RecallMemoryResult, ToolDefinition } from '../openrouter-chat.ts';

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

interface WireBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  tools?: unknown;
  response_format?: {
    type?: string;
    json_schema?: {
      strict?: boolean;
      schema?: { additionalProperties?: unknown };
    };
  };
  max_tokens?: number;
  provider?: { require_parameters?: boolean };
}

/** Parse the body of the FIRST fetch call (the foreground LLM request). */
function firstBody(fetchSpy: ReturnType<typeof vi.fn>): WireBody {
  return JSON.parse(fetchSpy.mock.calls[0][1].body as string) as WireBody;
}

const TEST_TOOLS: ToolDefinition[] = [
  {
    type: 'function' as const,
    function: {
      name: 'do_thing',
      description: 'Do a thing.',
      parameters: {
        type: 'object',
        properties: { x: { type: 'string', description: 'an arg' } },
        required: ['x'],
      },
    },
  },
];

// ── prompt() ──────────────────────────────────────────────────────────────────

describe('OpenRouterChat.prompt() unified request body', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue(mockTextResponse('plain answer'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(a) WITH responseFormat: strict json_schema + provider.require_parameters + max_tokens', async () => {
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

    const result = await chat.prompt('What is the answer?');
    expect(result.ok).toBe(true);

    const body = firstBody(fetchSpy);
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(body.response_format?.json_schema?.schema?.additionalProperties).toBe(false);
    expect(body.provider?.require_parameters).toBe(true);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(0);
  });

  it('(b) WITHOUT responseFormat: no response_format/provider, but max_tokens present', async () => {
    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: 999999,
      // no responseFormat
    });

    const result = await chat.prompt('Hello there');
    expect(result.ok).toBe(true);

    const body = firstBody(fetchSpy);
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toBeUndefined();
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(0);
  });
});

// ── promptWithTools() ───────────────────────────────────────────────────────

describe('OpenRouterChat.promptWithTools() unified request body', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue(mockTextResponse('plain answer'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(c) WITH responseFormat: tools present, response_format ABSENT (tools win), max_tokens present', async () => {
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

    const result = await chat.promptWithTools('Use a tool', TEST_TOOLS);
    expect(result.ok).toBe(true);

    const body = firstBody(fetchSpy);
    // Tools must be present.
    expect(body.tools).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    // Mutual exclusion: response_format must NOT be sent alongside tools.
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toBeUndefined();
    // Output cap always present.
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(0);
  });

  it('(d) WITHOUT schema: tools + max_tokens, no response_format (regression guard)', async () => {
    const chat = new OpenRouterChat({
      apiKey: 'sk-test',
      systemPrompt: 'You are a test bot.',
      llmem: createMockLLMem(),
      memStore: new InMemoryMemStore(),
      backgroundDebounceMs: 999999,
      // no responseFormat
    });

    const result = await chat.promptWithTools('Use a tool', TEST_TOOLS);
    expect(result.ok).toBe(true);

    const body = firstBody(fetchSpy);
    expect(body.tools).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.response_format).toBeUndefined();
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(0);
  });
});
