// src/services/llm-summarizer.ts
// LLMSummarizer: standalone concrete LLM summarizer for background memory indexing.
//
// Implements ILLMSummarizer (from background-indexer) using any OpenAI-compatible
// chat/completions endpoint with JSON-schema response format.
//
// Responsibility: fragment→topics summarization ONLY.
// Does NOT own chat generation, debug logging, or retry state.
//
// Consumers: BackgroundIndexer (via ILLMSummarizer port).
// Used by: ContextFactory (directly). OpenRouterChat removed in v0.4.0.

import { z } from 'zod';
import type { ILLMSummarizer } from './background-indexer.js';
import { retrySleep } from '../retry-sleep.js';
import { createMemoryLogger } from '../logging.js';

// ============================================================
// Schema & wire format for background summarization
// ============================================================

/** Zod schema for the LLM's segmentation response */
export const BackgroundSummarizationSchema = z.object({
  topics: z.array(z.object({
    summary: z.string(),
    chunkIds: z.array(z.string()),
    vocabulary: z.array(z.object({
      term: z.string(),
      count: z.number(),
    })).default([]),
  })),
  tailChunkIds: z.array(z.string()),
});

/** JSON schema for OpenAI-compatible structured output (response_format) */
const BACKGROUND_SUMMARIZATION_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'background_summarization',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        topics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              chunkIds: { type: 'array', items: { type: 'string' } },
              vocabulary: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    term: { type: 'string' },
                    count: { type: 'integer' },
                  },
                  required: ['term', 'count'],
                  additionalProperties: false,
                },
              },
            },
            required: ['summary', 'chunkIds', 'vocabulary'],
            additionalProperties: false,
          },
        },
        tailChunkIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['topics', 'tailChunkIds'],
      additionalProperties: false,
    },
  },
} as const;

// ============================================================
// LLMSummarizer config
// ============================================================

export interface LLMSummarizerConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. 'https://openrouter.ai/api/v1' */
  baseURL: string;
  /** Model identifier, e.g. 'google/gemini-2.5-flash' */
  model: string;
  /** API key for Authorization: Bearer header */
  apiKey: string;
  /** Optional logger (pino-compatible). Defaults to memory logger named 'llm-summarizer'. */
  logger?: ReturnType<typeof createMemoryLogger>;
}

// ============================================================
// HTTP constants
// ============================================================

const MAX_RETRIES = 5;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

// ============================================================
// LLMSummarizer
// ============================================================

/**
 * Concrete OpenAI-compatible LLM summarizer for background memory indexing.
 *
 * Implements ILLMSummarizer: takes (systemPrompt, detectionPrompt), POSTs to
 * /chat/completions with BACKGROUND_SUMMARIZATION_FORMAT, parses via
 * BackgroundSummarizationSchema, returns topics+tailChunkIds or null on failure.
 *
 * Retry policy: up to MAX_RETRIES retries on retryable HTTP statuses and network errors.
 * Temperature is fixed at 0 for deterministic topic segmentation.
 */
export class LLMSummarizer implements ILLMSummarizer {
  private readonly baseURL: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly log: ReturnType<typeof createMemoryLogger>;

  constructor(config: LLMSummarizerConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, ''); // strip trailing slash
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.log = config.logger ?? createMemoryLogger({ name: 'llm-summarizer' });
  }

  /**
   * Call the LLM to segment chunks into topics.
   *
   * Posts to {baseURL}/chat/completions with:
   * - model, temperature=0
   * - response_format = BACKGROUND_SUMMARIZATION_FORMAT (JSON schema)
   * - messages: [{role:'system', content:systemPrompt}, {role:'user', content:detectionPrompt}]
   *
   * Returns parsed {topics, tailChunkIds} or null on HTTP/network/parse failure.
   */
  async summarize(
    systemPrompt: string,
    detectionPrompt: string,
  ): Promise<{
    topics: Array<{ summary: string; chunkIds: string[]; vocabulary: Array<{ term: string; count: number }> }>;
    tailChunkIds: string[];
  } | null> {
    const url = `${this.baseURL}/chat/completions`;

    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: BACKGROUND_SUMMARIZATION_FORMAT,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: detectionPrompt },
      ],
    };

    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = `HTTP ${response.status}: ${errorText}`;

          if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000;
            this.log.warn({ attempt: attempt + 1, status: response.status, delay }, 'LLMSummarizer: retryable error, retrying');
            await retrySleep(delay);
            continue;
          }

          this.log.warn({ status: response.status, error: errorText }, 'LLMSummarizer: HTTP error');
          return null;
        }

        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const content = data.choices?.[0]?.message?.content;

        if (typeof content !== 'string') {
          if (attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000;
            this.log.warn({ attempt: attempt + 1, delay }, 'LLMSummarizer: empty response, retrying');
            await retrySleep(delay);
            continue;
          }
          this.log.warn({ raw: data }, 'LLMSummarizer: no content in response after retries');
          return null;
        }

        const parsed = safeParseResult(content);
        if (parsed === null) {
          this.log.warn({ raw: content }, 'LLMSummarizer: failed to parse response');
          return null;
        }

        return { topics: parsed.topics, tailChunkIds: parsed.tailChunkIds };
      } catch (error) {
        lastError = String(error);

        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          this.log.warn({ attempt: attempt + 1, error: lastError, delay }, 'LLMSummarizer: network error, retrying');
          await retrySleep(delay);
          continue;
        }

        this.log.warn({ error }, 'LLMSummarizer: network error after retries');
        return null;
      }
    }

    // Should not reach here — loop covers all paths — but keeps tsc happy
    this.log.warn({ lastError }, 'LLMSummarizer: all retries exhausted');
    return null;
  }
}

// ============================================================
// Module-level helpers
// ============================================================

/**
 * Safely parse a JSON string and validate against BackgroundSummarizationSchema.
 * Returns parsed data or null on any failure.
 */
function safeParseResult(
  text: string,
): z.infer<typeof BackgroundSummarizationSchema> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }

  const result = BackgroundSummarizationSchema.safeParse(json);
  if (!result.success) {
    return null;
  }
  return result.data;
}
