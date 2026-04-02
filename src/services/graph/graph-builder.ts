// src/services/graph/graph-builder.ts
// Main orchestrator: extract projections → embed → store → find neighbors → propose edges via Gemini → save.

import OpenAI from 'openai';
import { z } from 'zod';
import { ok, err } from '../../shared/result.js';
import type { Result } from '../../shared/result.js';
import { createMemoryLogger } from '../../logging.js';
import type { MemoryLogger } from '../../logging.js';
import type {
  MemProjection,
  SemanticAxis,
  GraphEdge,
  GraphConfig,
} from './types.js';
import { SEMANTIC_AXES } from './types.js';
import type { GraphStore } from './graph-store.js';
import type { ProjectionExtractor } from './projection-extractor.js';
import type { IGraphEmbeddingService } from './embedding-service.js';

// ──────────────────────────────────────────────────────────────────────────────
// Zod schema for Gemini edge proposals
// ──────────────────────────────────────────────────────────────────────────────

const EdgeProposalSchema = z.object({
  source_id: z.string(),
  target_id: z.string(),
  edge_type: z.enum(['temporal', 'spatial', 'social', 'semantic', 'causal', 'emotional', 'epistemic']),
  label: z.string(),
  relevance: z.number().min(0).max(1),
});

const EdgeProposalsArraySchema = z.array(EdgeProposalSchema);

// ──────────────────────────────────────────────────────────────────────────────
// Axis display names (Russian)
// ──────────────────────────────────────────────────────────────────────────────

const AXIS_DISPLAY_NAMES: Record<SemanticAxis, string> = {
  chronos: 'Хронос (время)',
  topos: 'Топос (место)',
  agents: 'Агенты (люди)',
  theme: 'Тема (содержание)',
  cause: 'Причина (мотивы)',
  emotion: 'Эмоции (переживания)',
  certainty: 'Уверенность (достоверность)',
};

// ──────────────────────────────────────────────────────────────────────────────
// GraphBuilder
// ──────────────────────────────────────────────────────────────────────────────

export class GraphBuilder {
  private readonly geminiClient: OpenAI;
  private readonly geminiModel: string;
  private readonly logger: MemoryLogger;

  constructor(
    private readonly store: GraphStore,
    private readonly extractor: ProjectionExtractor,
    private readonly embedder: IGraphEmbeddingService,
    private readonly config: GraphConfig,
  ) {
    // Use Gemini via OpenRouter if no dedicated Gemini key is set
    const useOpenRouter = config.geminiApiKey === undefined || config.geminiApiKey === '';
    this.geminiClient = new OpenAI({
      apiKey: useOpenRouter ? config.openaiApiKey : config.geminiApiKey,
      baseURL: useOpenRouter
        ? 'https://openrouter.ai/api/v1'
        : 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    this.geminiModel = config.geminiModel;
    this.logger = createMemoryLogger({ name: 'graph-builder' });
  }

  /**
   * Process a newly created mem: extract projections, embed, find neighbors, propose edges via Gemini.
   * Main entry point called after a mem is closed/created.
   */
  async processMem(
    memId: number,
    memText: string,
    contextId: string,
  ): Promise<Result<GraphEdge[], Error>> {
    this.logger.debug({ memId, contextId }, 'GraphBuilder.processMem: start');

    // Step 1: Resolve memstore ID
    const memstoreIdResult = await this.store.getMemstoreId(contextId);
    if (!memstoreIdResult.ok) return memstoreIdResult;
    const memstoreId = memstoreIdResult.value;

    // Step 2: Extract projections
    const extractResult = await this.extractor.extractProjections(String(memId), memText);
    if (!extractResult.ok) return extractResult;
    const projections = extractResult.value;

    if (projections.length === 0) {
      this.logger.debug({ memId }, 'GraphBuilder.processMem: no projections extracted, skipping');
      return ok([]);
    }

    // Step 3: Embed all projection texts in one batch
    const texts = projections.map(p => p.text);
    const embedResult = await this.embedder.embedTexts(texts);
    if (!embedResult.ok) return embedResult;
    const embeddings = embedResult.value;

    // Step 4: Attach embeddings to projections
    const projsWithEmbeddings: MemProjection[] = projections.map((proj, i) => {
      const embedding = embeddings[i];
      return embedding !== undefined ? { ...proj, embedding } : proj;
    });

    // Step 5: Save projections to DB
    const saveResult = await this.store.saveProjections(projsWithEmbeddings, memstoreId);
    if (!saveResult.ok) return saveResult;

    // Step 6: Find similar projections per axis
    // Track: candidateMemId → discoveryAxis (first axis that found this candidate)
    const discoveryAxisMap = new Map<string, SemanticAxis>();
    // Grouped by axis: axis → list of {memId, text, similarity}
    const groupsByAxis = new Map<SemanticAxis, Array<{ memId: string; text: string; similarity: number }>>();

    for (const proj of projsWithEmbeddings) {
      if (proj.embedding === undefined || proj.embedding.length === 0) continue;

      const candidatesResult = await this.store.findSimilarByAxis(
        proj.embedding,
        proj.axis,
        memstoreId,
        memId,
        this.config.similarityThreshold,
        this.config.topKPerAxis,
      );
      if (!candidatesResult.ok) return candidatesResult;

      const candidates = candidatesResult.value;
      if (candidates.length === 0) continue;

      const existingGroup = groupsByAxis.get(proj.axis) ?? [];
      for (const candidate of candidates) {
        existingGroup.push({
          memId: candidate.memId,
          text: candidate.projectionText,
          similarity: candidate.similarity,
        });
        // Only record discoveryAxis if not already found by an earlier axis
        if (!discoveryAxisMap.has(candidate.memId)) {
          discoveryAxisMap.set(candidate.memId, proj.axis);
        }
      }
      groupsByAxis.set(proj.axis, existingGroup);
    }

    // Step 7: If no candidates, nothing to do
    const totalCandidates = Array.from(groupsByAxis.values()).reduce((sum, arr) => sum + arr.length, 0);
    if (totalCandidates === 0) {
      this.logger.debug({ memId }, 'GraphBuilder.processMem: no candidates found, skipping edge proposal');
      return ok([]);
    }

    // Step 8: Fetch original mem texts for all unique candidate mem IDs
    const uniqueMemIdStrings = Array.from(discoveryAxisMap.keys());
    const uniqueMemIds = uniqueMemIdStrings.map(Number);

    const memTextsResult = await this.store.getMemTexts(uniqueMemIds);
    if (!memTextsResult.ok) return memTextsResult;
    const memTextsMap = memTextsResult.value;

    // Step 9: Build Gemini prompt and call
    const prompt = this.buildGeminiPrompt(memId, memText, groupsByAxis, memTextsMap);

    const edgeProposalsResult = await this.callGemini(prompt);
    if (!edgeProposalsResult.ok) return edgeProposalsResult;
    const edgeProposals = edgeProposalsResult.value;

    // Step 10: Convert proposals to GraphEdge[], save and return
    const edges: GraphEdge[] = edgeProposals
      .slice(0, this.config.maxEdgesFromGemini)
      .map(proposal => {
        const targetMemIdStr = extractMemId(proposal.target_id);
        const discoveryAxis: SemanticAxis = targetMemIdStr !== null
          ? (discoveryAxisMap.get(targetMemIdStr) ?? 'theme')
          : 'theme';

        return {
          sourceMemId: String(memId),
          targetMemId: targetMemIdStr ?? proposal.target_id,
          edgeType: proposal.edge_type,
          label: proposal.label,
          relevance: proposal.relevance,
          discoveryAxis,
        };
      });

    const saveEdgesResult = await this.store.saveEdges(edges, memstoreId);
    if (!saveEdgesResult.ok) return saveEdgesResult;

    this.logger.debug(
      { memId, edgeCount: edges.length },
      'GraphBuilder.processMem: complete',
    );

    return ok(edges);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private buildGeminiPrompt(
    sourceMemId: number,
    sourceMemText: string,
    groupsByAxis: Map<SemanticAxis, Array<{ memId: string; text: string; similarity: number }>>,
    memTextsMap: Map<number, string>,
  ): string {
    const lines: string[] = [
      'Ты анализируешь связи между воспоминаниями. Тебе дан текущий мем и кандидаты на связь, найденные по разным семантическим осям.',
      '',
      'Предложи 10-20 наиболее релевантных связей. Каждая связь должна быть важна для будущего припоминания — помогать находить это воспоминание в нужный момент.',
      '',
      'Типы связей:',
      '- temporal: временная связь (произошло до/после, одновременно)',
      '- spatial: пространственная (то же место, рядом)',
      '- social: социальная (те же люди, отношения)',
      '- semantic: тематическая (та же тема, похожий контекст)',
      '- causal: причинно-следственная (одно вызвало другое)',
      '- emotional: эмоциональная (похожие переживания)',
      '- epistemic: эпистемическая (подтверждает/опровергает, уточняет)',
      '',
      'Тип связи НЕ обязан совпадать с осью, по которой найден кандидат. Выбирай тип по смыслу самой связи.',
      '',
      `Текущий мем [mem-${sourceMemId}]:`,
      sourceMemText,
      '',
      'Кандидаты по осям:',
      '',
    ];

    for (const axis of SEMANTIC_AXES) {
      const group = groupsByAxis.get(axis);
      if (group === undefined || group.length === 0) continue;

      const displayName = AXIS_DISPLAY_NAMES[axis];
      lines.push(`=== ${displayName} ===`);

      for (const candidate of group) {
        const candidateIdNum = Number(candidate.memId);
        const candidateText = memTextsMap.get(candidateIdNum) ?? candidate.text;
        lines.push(`[mem-${candidate.memId}]: ${candidateText}`);
      }

      lines.push('');
    }

    lines.push(
      'Ответь строго JSON массивом:',
      '[',
      '  {',
      `    "source_id": "mem-${sourceMemId}",`,
      '    "target_id": "mem-{targetId}",',
      '    "edge_type": "temporal|spatial|social|semantic|causal|emotional|epistemic",',
      '    "label": "краткое_описание_связи",',
      '    "relevance": 0.0-1.0',
      '  }',
      ']',
    );

    return lines.join('\n');
  }

  private async callGemini(
    prompt: string,
  ): Promise<Result<z.infer<typeof EdgeProposalsArraySchema>, Error>> {
    let rawContent: string;
    try {
      const response = await this.geminiClient.chat.completions.create({
        model: this.geminiModel,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });

      const choice = response.choices[0];
      if (choice === undefined || choice.message.content === null) {
        return err(new Error('Gemini returned empty response'));
      }
      rawContent = choice.message.content;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message }, 'GraphBuilder.callGemini: API call failed');
      return err(new Error(`Gemini API call failed: ${message}`));
    }

    // Parse JSON — Gemini may return a JSON object wrapping the array
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, rawContent }, 'GraphBuilder.callGemini: JSON parse failed');
      return err(new Error(`Gemini JSON parse failed: ${message}`));
    }

    // Handle case where Gemini wraps the array in an object
    const arrayToValidate = Array.isArray(parsed)
      ? parsed
      : (parsed !== null && typeof parsed === 'object' ? findArrayInObject(parsed as Record<string, unknown>) : null);

    if (arrayToValidate === null) {
      return err(new Error('Gemini response did not contain a JSON array'));
    }

    const validation = EdgeProposalsArraySchema.safeParse(arrayToValidate);
    if (!validation.success) {
      const message = validation.error.message;
      this.logger.error({ err: message }, 'GraphBuilder.callGemini: schema validation failed');
      return err(new Error(`Gemini response schema validation failed: ${message}`));
    }

    return ok(validation.data);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract numeric mem ID from "mem-123" format string.
 * Returns the string form of the number, or null if not parseable.
 */
function extractMemId(memIdStr: string): string | null {
  const match = /^mem-(\d+)$/.exec(memIdStr);
  if (match === null) return null;
  const id = match[1];
  return id !== undefined ? id : null;
}

/**
 * Find the first array value in a plain object (handles Gemini wrapping an array).
 */
function findArrayInObject(obj: Record<string, unknown>): unknown[] | null {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value as unknown[];
  }
  return null;
}
