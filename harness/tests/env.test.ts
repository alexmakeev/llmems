import { describe, it, expect } from 'vitest';
import { parseEnvFile, loadHarnessConfig } from '../src/env.js';

const REQUIRED = {
  POSTGRES_URL: 'postgresql://u:p@localhost:5434/llmems_stand',
  LITELLM_BASE_URL: 'http://127.0.0.1:14999',
  LITELLM_API_KEY: 'sk-test',
  LLMEMS_SUMMARIZER_MODEL: 'claude-haiku-45',
  LLMEMS_EMBEDDINGS_MODEL: 'openai-embedding-small',
};

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines, ignoring comments and blanks', () => {
    const parsed = parseEnvFile(
      '# comment\n\nA=1\nB=hello world\n  # indented comment\nC=a=b=c\n',
    );
    expect(parsed).toEqual({ A: '1', B: 'hello world', C: 'a=b=c' });
  });
});

describe('loadHarnessConfig', () => {
  it('loads required keys and applies defaults', () => {
    const cfg = loadHarnessConfig({ ...REQUIRED });
    expect(cfg.postgresUrl).toBe(REQUIRED.POSTGRES_URL);
    expect(cfg.litellmBaseUrl).toBe(REQUIRED.LITELLM_BASE_URL);
    expect(cfg.litellmApiKey).toBe('sk-test');
    expect(cfg.summarizerModel).toBe('claude-haiku-45');
    expect(cfg.embeddingsModel).toBe('openai-embedding-small');
    expect(cfg.criticalTimeoutMs).toBe(1500);
    expect(cfg.maxContextChars).toBe(12000);
    expect(cfg.seedPollTimeoutMs).toBe(120000);
    expect(cfg.seedPollIntervalMs).toBe(2000);
    expect(cfg.indexThreshold).toBeUndefined();
  });

  it('default markerText is Russian (D5)', () => {
    const cfg = loadHarnessConfig({ ...REQUIRED });
    expect(cfg.markerText).toMatch(/[а-яА-ЯёЁ]/u);
  });

  it('honors numeric overrides incl. indexThreshold (D16)', () => {
    const cfg = loadHarnessConfig({
      ...REQUIRED,
      LLMEMS_CRITICAL_TIMEOUT_MS: '900',
      LLMEMS_MAX_CONTEXT_CHARS: '5000',
      LLMEMS_INDEX_THRESHOLD: '8',
      LLMEMS_SEED_POLL_TIMEOUT_MS: '60000',
      LLMEMS_SEED_POLL_INTERVAL_MS: '500',
    });
    expect(cfg.criticalTimeoutMs).toBe(900);
    expect(cfg.maxContextChars).toBe(5000);
    expect(cfg.indexThreshold).toBe(8);
    expect(cfg.seedPollTimeoutMs).toBe(60000);
    expect(cfg.seedPollIntervalMs).toBe(500);
  });

  it('throws loudly listing every missing required key', () => {
    expect(() => loadHarnessConfig({ POSTGRES_URL: 'x' })).toThrowError(
      /LITELLM_BASE_URL.*LITELLM_API_KEY.*LLMEMS_SUMMARIZER_MODEL.*LLMEMS_EMBEDDINGS_MODEL/s,
    );
  });

  it('rejects placeholder values left from provisioning', () => {
    expect(() =>
      loadHarnessConfig({ ...REQUIRED, LITELLM_API_KEY: '__PENDING_KEY_CREATION__' }),
    ).toThrowError(/placeholder/i);
  });
});
