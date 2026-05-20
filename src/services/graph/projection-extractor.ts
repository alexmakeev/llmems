// src/services/graph/projection-extractor.ts
// Extracts 7 semantic projections from a mem's text using an LLM (Gemini Flash via OpenRouter).
//
// PROMPT env var contract:
//   PROMPT — required. Name of the prompt file (without extension) inside config/prompts/.
//            Example: PROMPT=baseline → loads config/prompts/baseline.md
//   Fails fast at construction if PROMPT is unset or the resolved file does not exist.
//   Prompt is loaded once at construction and reused for every extractProjections call.

import type OpenAI from 'openai';
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

export class ProjectionExtractor {
  private readonly client: OpenAI;
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
    this.model = config.geminiModel;
    this.logger = createMemoryLogger({ name: 'projection-extractor' });
  }

  /**
   * Extract up to 7 semantic projections from a mem's text.
   * Axes with no relevant content are omitted from the result.
   */
  async extractProjections(
    memId: string,
    memText: string,
  ): Promise<Result<MemProjection[], Error>> {
    const userPrompt = `Воспоминание:\n${memText}`;

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
      this.logger.error({ err: message, memId }, 'ProjectionExtractor: LLM call failed');
      return err(new Error(`LLM call failed: ${message}`));
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, rawContent, memId }, 'ProjectionExtractor: JSON parse failed');
      return err(new Error(`JSON parse failed: ${message}`));
    }

    // Validate with zod
    const validation = ProjectionResponseSchema.safeParse(parsed);
    if (!validation.success) {
      const message = validation.error.message;
      this.logger.error({ err: message, memId }, 'ProjectionExtractor: schema validation failed');
      return err(new Error(`Schema validation failed: ${message}`));
    }

    const data: ProjectionResponse = validation.data;

    // Build MemProjection array — skip axes with empty text
    const projections: MemProjection[] = SEMANTIC_AXES
      .map((axis: SemanticAxis): MemProjection | null => {
        const text = data[axis].trim();
        if (text === '') return null;
        return { memId, axis, text };
      })
      .filter((p): p is MemProjection => p !== null);

    this.logger.debug(
      { memId, count: projections.length },
      'ProjectionExtractor: projections extracted',
    );

    return ok(projections);
  }
}
