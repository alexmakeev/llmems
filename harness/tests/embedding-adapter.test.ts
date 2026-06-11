import { describe, it, expect, vi } from 'vitest';
import { EmbeddingAdapter } from '../src/embedding-adapter.js';

const CFG = {
  baseUrl: 'http://litellm.test:4000',
  apiKey: 'sk-test',
  model: 'openai-embedding-small',
};

function okResponse(embedding: number[]): Response {
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EmbeddingAdapter', () => {
  it('returns ok with a 1536-dim vector in EmbeddingValue.compact', async () => {
    const vec = new Array(1536).fill(0.5);
    const fetchImpl = vi.fn(async () => okResponse(vec));
    const adapter = new EmbeddingAdapter({ ...CFG, fetchImpl });

    const result = await adapter.embed('проверка');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.compact).toHaveLength(1536);
      expect(result.value.compact[0]).toBe(0.5);
    }
  });

  it('sends model, input and bearer auth to {baseUrl}/v1/embeddings', async () => {
    const fetchImpl = vi.fn(async () => okResponse(new Array(1536).fill(0)));
    const adapter = new EmbeddingAdapter({ ...CFG, fetchImpl });

    await adapter.embed('текст запроса');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://litellm.test:4000/v1/embeddings');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'openai-embedding-small',
      input: 'текст запроса',
    });
  });

  it('returns err on dimension mismatch (not 1536)', async () => {
    const fetchImpl = vi.fn(async () => okResponse(new Array(768).fill(0)));
    const adapter = new EmbeddingAdapter({ ...CFG, fetchImpl });

    const result = await adapter.embed('x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('768');
  });

  it('returns err on non-200 HTTP status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"budget exceeded"}}', { status: 429 }),
    );
    const adapter = new EmbeddingAdapter({ ...CFG, fetchImpl });

    const result = await adapter.embed('x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('429');
  });

  it('returns err on malformed response body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"unexpected":true}', { status: 200 }),
    );
    const adapter = new EmbeddingAdapter({ ...CFG, fetchImpl });

    const result = await adapter.embed('x');

    expect(result.ok).toBe(false);
  });

  it('returns err (never throws) on network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const adapter = new EmbeddingAdapter({ ...CFG, fetchImpl });

    const result = await adapter.embed('x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ECONNREFUSED');
  });
});
