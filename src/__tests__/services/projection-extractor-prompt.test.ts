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

const { mockChatCreate } = vi.hoisted(() => {
  const mockChatCreate = vi.fn();
  return { mockChatCreate };
});

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockChatCreate } };
    embeddings = { create: vi.fn() };
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
