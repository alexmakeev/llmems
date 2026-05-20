// src/services/graph/projection-extractor.ts
// Extracts 7 semantic projections from a mem's text using an LLM (Gemini Flash via OpenRouter).
// Also decomposes a query into the same 7 axes with embeddings for axis-aligned recall.
//
// PROMPT env var contract:
//   PROMPT — required. Name of the prompt file (without extension) inside config/prompts/.
//            Example: PROMPT=baseline → loads config/prompts/baseline.md
//   Fails fast at construction if PROMPT is unset or the resolved file does not exist.
//   Prompt is loaded once at construction and reused for every extractProjections/queryToProjections call.

import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { ok, err } from '../../shared/result.js';
import type { Result } from '../../shared/result.js';
import { createMemoryLogger } from '../../logging.js';
import type { MemoryLogger } from '../../logging.js';
import type { MemProjection, SemanticAxis, GraphConfig } from './types.js';
import { SEMANTIC_AXES } from './types.js';
import { createGeminiClient } from './llm-client.js';
import { retrySleep } from '../../retry-sleep.js';

// ──────────────────────────────────────────────────────────────────────────────
// Zod schema for LLM response
// ──────────────────────────────────────────────────────────────────────────────

const ProjectionResponseSchema = z.object({
  chronos: z.string(),
  topos: z.string(),
  agents: z.string(),
  theme: z.string(),
  cause: z.string(),
  emotion: z.string(),
  certainty: z.string(),
});

type ProjectionResponse = z.infer<typeof ProjectionResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Prompt loading — fail fast, no fallback
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Load the system prompt from config/prompts/${PROMPT}.md.
 * Throws synchronously if PROMPT is unset or the file does not exist.
 *
 * @param configRoot - project root directory; resolved file is configRoot/config/prompts/<PROMPT>.md.
 *                     Defaults to process.cwd(). Exposed for testing with temp dirs.
 */
function loadSystemPrompt(configRoot: string): string {
  const promptName = process.env['PROMPT'];
  if (promptName === undefined || promptName === '') {
    throw new Error(
      'Required env var PROMPT is not set. ' +
      'Set PROMPT to the name of a prompt file in config/prompts/ (e.g. PROMPT=baseline).',
    );
  }
  const promptPath = join(configRoot, 'config', 'prompts', `${promptName}.md`);
  try {
    return readFileSync(promptPath, 'utf-8');
  } catch {
    throw new Error(
      `Prompt file not found: config/prompts/${promptName}.md ` +
      `(resolved to ${promptPath}). ` +
      `Create the file or set PROMPT to an existing prompt name.`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ProjectionExtractor
// ──────────────────────────────────────────────────────────────────────────────

/** Embedding retry constants (same as GraphEmbeddingService for consistency) */
const EMBED_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const EMBED_MAX_RETRIES = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Raw projection result (axis + text, no memId, no embedding)
// ──────────────────────────────────────────────────────────────────────────────

interface RawProjection {
  axis: SemanticAxis;
  text: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// ProjectionExtractor
// ──────────────────────────────────────────────────────────────────────────────

export class ProjectionExtractor {
  private readonly client: OpenAI;
  private readonly embeddingClient: OpenAI;
  private readonly model: string;
  private readonly logger: MemoryLogger;
  private readonly systemPrompt: string;

  /**
   * @param config - LLM configuration.
   * @param configRoot - Project root for resolving config/prompts/<PROMPT>.md.
   *                     Defaults to process.cwd(). Override in tests to use a temp dir.
   */
  constructor(
    config: Pick<GraphConfig, 'geminiApiKey' | 'geminiModel' | 'openaiApiKey'>,
    configRoot: string = process.cwd(),
  ) {
    this.systemPrompt = loadSystemPrompt(configRoot);
    this.client = createGeminiClient(config);
    // Separate OpenAI client for embeddings — uses standard api.openai.com endpoint.
    this.embeddingClient = new OpenAI({ apiKey: config.openaiApiKey });
    this.model = config.geminiModel;
    this.logger = createMemoryLogger({ name: 'projection-extractor' });
  }

  /**
   * Extract up to 7 semantic projections from a mem's text.
   * Axes with no relevant content are omitted from the result.
   * Projections do not carry embeddings — the caller embeds separately.
   */
  async extractProjections(
    memId: string,
    memText: string,
  ): Promise<Result<MemProjection[], Error>> {
    const rawResult = await this.extractRawProjections(memText);
    if (!rawResult.ok) return rawResult;

    const projections: MemProjection[] = rawResult.value.map(({ axis, text }) => ({
      memId,
      axis,
      text,
    }));

    this.logger.debug(
      { memId, count: projections.length },
      'ProjectionExtractor: projections extracted',
    );

    return ok(projections);
  }

  /**
   * Decompose a query into up to 7 semantic axis projections, each with an embedding.
   * Uses the SAME arm prompt as mem extraction so query and mem projections are comparable.
   * Axes with no relevant content are omitted.
   * Each returned projection carries a 1536-dimensional embedding.
   */
  async queryToProjections(query: string): Promise<Result<MemProjection[], Error>> {
    const rawResult = await this.extractRawProjections(query);
    if (!rawResult.ok) return rawResult;

    const rawProjections = rawResult.value;
    if (rawProjections.length === 0) return ok([]);

    // Embed all projection texts in one batch.
    const texts = rawProjections.map(p => p.text);
    const embedResult = await this.embedTexts(texts);
    if (!embedResult.ok) return embedResult;

    const embeddings = embedResult.value;
    const projections: MemProjection[] = rawProjections.map((p, i) => ({
      memId: 'query',
      axis: p.axis,
      text: p.text,
      embedding: embeddings[i],
    }));

    this.logger.debug(
      { count: projections.length },
      'ProjectionExtractor: query projections extracted and embedded',
    );

    return ok(projections);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private — shared LLM extraction core
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Call the LLM with the arm system prompt and return non-empty axis projections.
   * Both extractProjections and queryToProjections call this shared routine,
   * guaranteeing identical prompt, model, and axis semantics for mems and queries.
   */
  private async extractRawProjections(text: string): Promise<Result<RawProjection[], Error>> {
    const userPrompt = `Воспоминание:\n${text}`;

    let rawContent: string;
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });

      const choice = response.choices[0];
      if (choice === undefined || choice.message.content === null) {
        return err(new Error('LLM returned empty response'));
      }
      rawContent = choice.message.content;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message }, 'ProjectionExtractor: LLM call failed');
      return err(new Error(`LLM call failed: ${message}`));
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, rawContent }, 'ProjectionExtractor: JSON parse failed');
      return err(new Error(`JSON parse failed: ${message}`));
    }

    // Validate with zod
    const validation = ProjectionResponseSchema.safeParse(parsed);
    if (!validation.success) {
      const message = validation.error.message;
      this.logger.error({ err: message }, 'ProjectionExtractor: schema validation failed');
      return err(new Error(`Schema validation failed: ${message}`));
    }

    const data: ProjectionResponse = validation.data;

    // Collect non-empty projections across all axes
    const projections: RawProjection[] = SEMANTIC_AXES
      .map((axis: SemanticAxis): RawProjection | null => {
        const projText = data[axis].trim();
        if (projText === '') return null;
        return { axis, text: projText };
      })
      .filter((p): p is RawProjection => p !== null);

    return ok(projections);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private — embedding with retry
  // ──────────────────────────────────────────────────────────────────────────

  private async embedTexts(texts: string[]): Promise<Result<number[][], Error>> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = EMBED_RETRY_DELAYS_MS[attempt - 1] ?? EMBED_RETRY_DELAYS_MS[EMBED_RETRY_DELAYS_MS.length - 1] ?? 4000;
        await retrySleep(delayMs);
      }

      try {
        const response = await this.embeddingClient.embeddings.create({
          model: 'text-embedding-3-small',
          input: texts,
          dimensions: 1536,
        });

        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        return ok(sorted.map(item => item.embedding));
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.logger.error(
          { err: lastError.message, attempt, batchSize: texts.length },
          'ProjectionExtractor: embedding API call failed',
        );
      }
    }

    return err(new Error(`Embedding failed after ${EMBED_MAX_RETRIES} retries: ${lastError.message}`));
  }
}
