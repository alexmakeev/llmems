// src/__tests__/services/projection-extractor-prompt.test.ts
// Tests for env-driven prompt loading in ProjectionExtractor
// and MEMSTORE_ID env-driven reading in scripts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mock objects (must precede vi.mock calls)
// ──────────────────────────────────────────────────────────────────────────────

const { mockChatCreate, mockEmbeddingsCreate, openaiConstructorCalls } = vi.hoisted(() => {
  const mockChatCreate = vi.fn();
  const mockEmbeddingsCreate = vi.fn();
  // Captures the config object passed to each `new OpenAI(config)` call.
  const openaiConstructorCalls: Array<{ apiKey?: string; baseURL?: string }> = [];
  return { mockChatCreate, mockEmbeddingsCreate, openaiConstructorCalls };
});

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockChatCreate } };
    embeddings = { create: mockEmbeddingsCreate };

    constructor(config: { apiKey?: string; baseURL?: string } = {}) {
      openaiConstructorCalls.push({ apiKey: config.apiKey, baseURL: config.baseURL });
    }
  }
  return { default: OpenAI };
});

vi.mock('../../retry-sleep.ts', () => ({
  retrySleep: vi.fn().mockResolvedValue(undefined),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Imports after mocks
// ──────────────────────────────────────────────────────────────────────name──
// ──────────────────────────────────────────────────────────────────────────────

import { ProjectionExtractor } from '../../services/graph/projection-extractor.ts';
import { requireEnvInt } from '../../shared/env.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const TEST_PROMPT_TEXT = 'You are a test extraction prompt.\nExtract stuff.';

/**
 * Create a temp directory with a prompts subdirectory and a named prompt file.
 * Returns the temp dir path (to be used as cwd/configRoot) and a cleanup function.
 */
function createTempPromptDir(promptName: string, content: string): {
  promptsDir: string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `llmems-test-${Date.now()}`);
  const promptsDir = join(dir, 'config', 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, `${promptName}.md`), content, 'utf-8');
  return {
    promptsDir: dir, // root from which config/prompts/<name>.md is resolved
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const BASE_CONFIG = {
  openaiApiKey: 'test-key',
  geminiModel: 'google/gemini-2.5-flash',
};

// ──────────────────────────────────────────────────────────────────────────────
// 1. ProjectionExtractor — prompt loading
// ──────────────────────────────────────────────────────────────────────────────

describe('ProjectionExtractor — env-driven prompt', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('throws synchronously when PROMPT env var is unset', () => {
    delete process.env['PROMPT'];
    expect(() => new ProjectionExtractor(BASE_CONFIG)).toThrow(/PROMPT/);
  });

  it('throws synchronously when the resolved prompt file does not exist', () => {
    process.env['PROMPT'] = 'nonexistent-prompt';
    // No file created — should throw on construction
    expect(() => new ProjectionExtractor(BASE_CONFIG)).toThrow(/nonexistent-prompt/);
  });

  it('constructs successfully and uses prompt file content when PROMPT and file are valid', () => {
    const { promptsDir, cleanup } = createTempPromptDir('my-test-prompt', TEST_PROMPT_TEXT);
    process.env['PROMPT'] = 'my-test-prompt';
    // Override the config root to point to our temp dir
    try {
      const extractor = new ProjectionExtractor(BASE_CONFIG, promptsDir);
      expect(extractor).toBeDefined();
    } finally {
      cleanup();
    }
  });

  // ── Unified embedding path (OpenRouter) ──────────────────────────────────────

  it('embedding client gets OpenRouter baseURL when openaiBaseUrl is provided', () => {
    const { promptsDir, cleanup } = createTempPromptDir('or-test-prompt', TEST_PROMPT_TEXT);
    process.env['PROMPT'] = 'or-test-prompt';
    openaiConstructorCalls.length = 0; // clear before construction
    try {
      new ProjectionExtractor(
        {
          ...BASE_CONFIG,
          openaiBaseUrl: 'https://openrouter.ai/api/v1',
          openaiModel: 'text-embedding-3-small',
        },
        promptsDir,
      );
      // Two OpenAI instances are constructed in order: [0] LLM/chat client, [1] embedding client.
      // The embedding client (last / index 1) must carry the OpenRouter baseURL.
      // createGeminiClient (index 0) also uses OpenRouter, so we need BOTH to have it.
      expect(openaiConstructorCalls).toHaveLength(2);
      // Index 1 = embedding client — must have OpenRouter baseURL
      expect(openaiConstructorCalls[1]?.baseURL).toBe('https://openrouter.ai/api/v1');
    } finally {
      cleanup();
    }
  });

  it('embedding client has no baseURL when openaiBaseUrl is not provided', () => {
    const { promptsDir, cleanup } = createTempPromptDir('legacy-test-prompt', TEST_PROMPT_TEXT);
    process.env['PROMPT'] = 'legacy-test-prompt';
    openaiConstructorCalls.length = 0;
    try {
      // BASE_CONFIG has no openaiBaseUrl — embedding client must NOT get a custom baseURL.
      new ProjectionExtractor(BASE_CONFIG, promptsDir);
      expect(openaiConstructorCalls).toHaveLength(2);
      // Index 1 = embedding client — must NOT have a baseURL
      expect(openaiConstructorCalls[1]?.baseURL).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('queryToProjections uses the configured openaiModel for embeddings', async () => {
    const { promptsDir, cleanup } = createTempPromptDir('model-test-prompt', TEST_PROMPT_TEXT);
    process.env['PROMPT'] = 'model-test-prompt';

    const fullProjectionResponse = JSON.stringify({
      chronos: 'January',
      topos: 'Office',
      agents: 'Alice',
      theme: 'Planning',
      cause: 'Deadline',
      emotion: 'Focused',
      certainty: 'Certain',
    });

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: fullProjectionResponse } }],
    });

    // Return one embedding per projection text (7 axes in fullProjectionResponse)
    const fakeEmbeddings = Array.from({ length: 7 }, (_, i) => ({
      index: i,
      embedding: new Array(1536).fill(0.1),
    }));
    mockEmbeddingsCreate.mockResolvedValueOnce({ data: fakeEmbeddings });

    try {
      const extractor = new ProjectionExtractor(
        {
          ...BASE_CONFIG,
          openaiBaseUrl: 'https://openrouter.ai/api/v1',
          openaiModel: 'text-embedding-3-small',
        },
        promptsDir,
      );
      const result = await extractor.queryToProjections('Test query about planning');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The embedding call must use the configured model string (not a hardcoded constant)
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'text-embedding-3-small',
          dimensions: 1536,
        }),
      );
      // All returned projections must have a 1536-dim embedding
      for (const proj of result.value) {
        expect(proj.embedding).toHaveLength(1536);
      }
    } finally {
      cleanup();
    }
  });

  it('passes the loaded prompt text as system message to the LLM', async () => {
    const { promptsDir, cleanup } = createTempPromptDir('my-test-prompt', TEST_PROMPT_TEXT);
    process.env['PROMPT'] = 'my-test-prompt';

    const fullProjectionResponse = JSON.stringify({
      chronos: 'January',
      topos: 'Office',
      agents: 'Alice',
      theme: 'Planning',
      cause: 'Deadline',
      emotion: 'Focused',
      certainty: 'Certain',
    });

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: fullProjectionResponse } }],
    });

    try {
      const extractor = new ProjectionExtractor(BASE_CONFIG, promptsDir);
      const result = await extractor.extractProjections('1', 'Some mem text');

      expect(result.ok).toBe(true);
      // Verify the system message is the content from our test file
      expect(mockChatCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'system', content: TEST_PROMPT_TEXT }),
          ]),
        }),
      );
    } finally {
      cleanup();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. requireEnvInt — shared utility for env-driven integer env vars
// ──────────────────────────────────────────────────────────────────────────────

describe('requireEnvInt', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('returns the integer value when env var is set to a valid number', () => {
    process.env['MEMSTORE_ID'] = '42';
    expect(requireEnvInt('MEMSTORE_ID')).toBe(42);
  });

  it('throws when env var is unset', () => {
    delete process.env['MEMSTORE_ID'];
    expect(() => requireEnvInt('MEMSTORE_ID')).toThrow(/MEMSTORE_ID/);
  });

  it('throws when env var is empty string', () => {
    process.env['MEMSTORE_ID'] = '';
    expect(() => requireEnvInt('MEMSTORE_ID')).toThrow(/MEMSTORE_ID/);
  });

  it('throws when env var is not a valid integer', () => {
    process.env['MEMSTORE_ID'] = 'not-a-number';
    expect(() => requireEnvInt('MEMSTORE_ID')).toThrow(/MEMSTORE_ID/);
  });

  it('works with different env var names', () => {
    process.env['MY_VAR'] = '7';
    expect(requireEnvInt('MY_VAR')).toBe(7);
  });
});
