// src/__tests__/services/llm-summarizer.test.ts
// Unit tests for LLMSummarizer — fully offline/deterministic.
//
// Verifies:
// - POSTs to {baseURL}/chat/completions with correct body (model, temperature=0,
//   response_format = BACKGROUND_SUMMARIZATION_FORMAT schema, messages with system+user)
// - Parses valid response and returns {topics, tailChunkIds}
// - Returns null on HTTP error (non-retryable)
// - Returns null on parse/schema error
// - Returns null on network error after retries
// - Returns null when response content is empty

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMSummarizer } from '../../services/llm-summarizer.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://test-llm.example.com/v1';
const MODEL = 'test-model';
const API_KEY = 'sk-test-key';

const SYSTEM_PROMPT = 'You segment conversations into mems.';
const DETECTION_PROMPT = 'Chunks:\n[id:c1] user: hello\n[id:c2] assistant: hi';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a valid summarization response body */
function validResponseBody(
  topics: Array<{ summary: string; chunkIds: string[]; vocabulary?: Array<{ term: string; count: number }> }> = [],
  tailChunkIds: string[] = [],
): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            topics: topics.map(t => ({
              summary: t.summary,
              chunkIds: t.chunkIds,
              vocabulary: t.vocabulary ?? [],
            })),
            tailChunkIds,
          }),
        },
      },
    ],
  });
}

/** Build a mock Response with given status and body string */
function mockResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(body) as unknown),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LLMSummarizer', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Construction & HTTP shape ──────────────────────────────────────────────

  it('POSTs to {baseURL}/chat/completions with correct URL and headers', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, validResponseBody([{ summary: 'Greeting', chunkIds: ['c1'] }], ['c2'])),
    );

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/chat/completions`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends model, temperature=0, response_format with json_schema, and correct messages', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, validResponseBody([], ['c1'])),
    );

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      model: string;
      temperature: number;
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
      messages: Array<{ role: string; content: string }>;
    };

    expect(body.model).toBe(MODEL);
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('background_summarization');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(body.messages[1]).toEqual({ role: 'user', content: DETECTION_PROMPT });
  });

  // ── Happy path — parse & return ────────────────────────────────────────────

  it('returns parsed topics and tailChunkIds on success', async () => {
    const topics = [
      { summary: 'Greeting exchange', chunkIds: ['c1', 'c2'], vocabulary: [{ term: 'hello', count: 1 }] },
      { summary: 'Follow-up', chunkIds: ['c3'], vocabulary: [] },
    ];
    const tailChunkIds = ['c4'];

    fetchSpy.mockResolvedValueOnce(mockResponse(200, validResponseBody(topics, tailChunkIds)));

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    const result = await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(result).not.toBeNull();
    expect(result?.topics).toHaveLength(2);
    expect(result?.topics[0]?.summary).toBe('Greeting exchange');
    expect(result?.topics[0]?.chunkIds).toEqual(['c1', 'c2']);
    expect(result?.topics[0]?.vocabulary).toEqual([{ term: 'hello', count: 1 }]);
    expect(result?.topics[1]?.chunkIds).toEqual(['c3']);
    expect(result?.tailChunkIds).toEqual(['c4']);
  });

  it('returns empty topics and tailChunkIds when LLM returns no closed topics', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, validResponseBody([], ['c1', 'c2'])));

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    const result = await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(result).not.toBeNull();
    expect(result?.topics).toHaveLength(0);
    expect(result?.tailChunkIds).toEqual(['c1', 'c2']);
  });

  it('defaults vocabulary to [] when LLM omits vocabulary field', async () => {
    // Send a topic without vocabulary field — schema default should fill it
    const raw = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              topics: [{ summary: 'Test topic', chunkIds: ['c1'] }], // no vocabulary
              tailChunkIds: [],
            }),
          },
        },
      ],
    });
    fetchSpy.mockResolvedValueOnce(mockResponse(200, raw));

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    const result = await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(result).not.toBeNull();
    expect(result?.topics[0]?.vocabulary).toEqual([]);
  });

  // ── Failure cases — return null ────────────────────────────────────────────

  it('returns null on non-retryable HTTP error (e.g. 401)', async () => {
    fetchSpy.mockResolvedValue(mockResponse(401, JSON.stringify({ error: 'Unauthorized' })));

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    const result = await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(result).toBeNull();
  });

  it('returns null when response content is missing (empty choices)', async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(
      mockResponse(200, JSON.stringify({ choices: [] })),
    );

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    // Run the summarize call concurrently with timer advancement to skip retry delays
    const resultPromise = summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    vi.useRealTimers();
    expect(result).toBeNull();
  });

  it('returns null when content is not valid JSON', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(200, JSON.stringify({
        choices: [{ message: { content: 'not json at all' } }],
      })),
    );

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    const result = await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(result).toBeNull();
  });

  it('returns null when content is JSON but fails schema validation (missing required fields)', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(200, JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ unexpected: true }) } }],
      })),
    );

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    const result = await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    expect(result).toBeNull();
  });

  it('returns null after network errors exhaust retries', async () => {
    vi.useFakeTimers();
    // Always throw a network error
    fetchSpy.mockRejectedValue(new Error('Network failure'));

    const summarizer = new LLMSummarizer({ baseURL: BASE_URL, model: MODEL, apiKey: API_KEY });
    // Run concurrently with timer advancement to skip retry delays
    const resultPromise = summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    vi.useRealTimers();
    expect(result).toBeNull();
    // Should have attempted MAX_RETRIES+1 = 6 times
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  // ── Strip trailing slash from baseURL ─────────────────────────────────────

  it('strips trailing slash from baseURL when building the endpoint URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, validResponseBody([], [])));

    const summarizer = new LLMSummarizer({
      baseURL: 'https://api.example.com/v1/',
      model: MODEL,
      apiKey: API_KEY,
    });
    await summarizer.summarize(SYSTEM_PROMPT, DETECTION_PROMPT);

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    // No double-slash
    expect(url).not.toContain('//chat/completions');
  });
});
