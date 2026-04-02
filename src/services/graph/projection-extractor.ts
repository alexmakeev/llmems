// src/services/graph/projection-extractor.ts
// Extracts 7 semantic projections from a mem's text using an LLM (Gemini Flash via OpenRouter).

import type OpenAI from 'openai';
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
// Prompt
// ──────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты извлекаешь семантические проекции из воспоминания. Для каждой оси выдели ключевую информацию в 1-2 предложениях. Если ось не представлена в тексте, верни пустую строку.

Оси:
- chronos: Когда это произошло? Временные маркеры, даты, последовательность событий
- topos: Где это произошло? Места, локации, география
- agents: Кто участвовал? Люди, роли, отношения между ними
- theme: О чём это? Тема, предмет, область
- cause: Почему? Причины, мотивы, последствия
- emotion: Какие эмоции? Настроение, тон, интенсивность переживаний
- certainty: Насколько уверен? Факт, предположение, слух, мнение

Отвечай строго JSON без markdown-обёртки.`;

// ──────────────────────────────────────────────────────────────────────────────
// ProjectionExtractor
// ──────────────────────────────────────────────────────────────────────────────

export class ProjectionExtractor {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger: MemoryLogger;

  constructor(config: Pick<GraphConfig, 'geminiApiKey' | 'geminiModel' | 'openaiApiKey'>) {
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
          { role: 'system', content: SYSTEM_PROMPT },
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
