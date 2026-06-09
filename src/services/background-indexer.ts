// src/services/background-indexer.ts
// BackgroundIndexer: standalone service that segments active chunks into closed mems.
//
// Originally extracted from OpenRouterChat.backgroundSummarize() (removed in v0.4.0).
// ContextFactory uses BackgroundIndexer directly; consumers wire up an ILLMSummarizer impl.

import { createMemoryLogger } from '../logging.js';
import type { MemChunk, IEmbeddingService, VocabularyTerm } from '../types.js';
import type { MemManager } from './mem-manager.js';

// ============================================================
// Port: ILLMSummarizer
// ============================================================

/**
 * Port: LLM summarizer for background indexing.
 *
 * Wraps the LLM call that segments chunks into topics.
 * Designed to be implemented by any LLM backend.
 * See LLMSummarizer for the concrete OpenAI-compatible implementation.
 *
 * Returns null on failure — BackgroundIndexer handles fallback internally.
 */
export interface ILLMSummarizer {
  /**
   * Call the LLM to segment chunks into topics.
   *
   * @param systemPrompt - The segmentation system prompt (includes vocab context).
   * @param detectionPrompt - The user prompt with chunks text + last topic context.
   * @returns Parsed segmentation result, or null if the LLM call / parse failed.
   */
  summarize(
    systemPrompt: string,
    detectionPrompt: string,
  ): Promise<{
    topics: Array<{ summary: string; chunkIds: string[]; vocabulary: Array<{ term: string; count: number }> }>;
    tailChunkIds: string[];
  } | null>;
}

// ============================================================
// Internal types
// ============================================================

/** Embedding set for a closed topic */
type TopicEmbeddings = {
  full: number[];
};

/** Empty embeddings fallback when embedding service is unavailable */
const EMPTY_EMBEDDINGS: TopicEmbeddings = { full: [] };

// ============================================================
// BackgroundIndexer
// ============================================================

/**
 * Standalone background indexer service.
 *
 * Segments active conversation chunks into closed mems (topics):
 * 1. Get active chunks from MemManager.
 * 2. Ask ILLMSummarizer to segment them into topics.
 * 3. Generate 1536-dim embeddings for each topic summary via IEmbeddingService.
 * 4. Apply result to store via MemManager.applyBackgroundResult().
 * 5. Return archived chunkIds (all chunkIds from closed topics).
 *
 * Ghost topics (empty chunkIds) are filtered out before apply.
 */
export class BackgroundIndexer {
  private readonly memManager: MemManager;
  private readonly embeddingService: IEmbeddingService | undefined;
  private readonly llmSummarizer: ILLMSummarizer;
  private readonly log = createMemoryLogger({ name: 'background-indexer' });

  constructor(
    memManager: MemManager,
    embeddingService: IEmbeddingService | undefined,
    llmSummarizer: ILLMSummarizer,
  ) {
    this.memManager = memManager;
    this.embeddingService = embeddingService;
    this.llmSummarizer = llmSummarizer;
  }

  /**
   * Run background indexing for the given contextId.
   *
   * Flow:
   * 1. Get active chunks — if empty, return [] immediately.
   * 2. Build system prompt (with known vocab terms + last closed topic).
   * 3. Build detection prompt (chunks text).
   * 4. Call ILLMSummarizer — returns topics + tailChunkIds or null on failure.
   * 5. Filter ghost topics (empty chunkIds).
   * 6. Generate embeddings for each topic summary.
   * 7. Apply result to MemManager.
   * 8. Return archived chunkIds (all chunkIds from closed topics).
   *
   * On LLM/embed failure: applies empty topics (no mems closed), returns [].
   */
  async index(contextId: string): Promise<string[]> {
    const chunks = await this.memManager.getActiveChunks(contextId);

    if (chunks.length === 0) {
      return [];
    }

    const { systemPrompt, detectionPrompt } = await this.buildPrompts(chunks, contextId);

    const llmResult = await this.llmSummarizer.summarize(systemPrompt, detectionPrompt);

    if (llmResult === null) {
      this.log.warn({}, 'BackgroundIndexer.index: LLM summarizer returned null, no topics closed');
      return [];
    }

    let { topics, tailChunkIds } = llmResult;

    // Filter ghost topics (empty chunkIds) — LLM sometimes reconstructs topics
    // from the general summary rather than actual chunks.
    const ghostTopics = topics.filter(t => t.chunkIds.length === 0);
    if (ghostTopics.length > 0) {
      this.log.warn(
        { ghostCount: ghostTopics.length, summaries: ghostTopics.map(t => t.summary.substring(0, 60)) },
        'BackgroundIndexer.index: filtered out ghost topics with empty chunkIds',
      );
    }
    topics = topics.filter(t => t.chunkIds.length > 0);

    // Generate embeddings for each topic summary
    const topicsWithEmbeddings = await Promise.all(
      topics.map(async (topic) => {
        const embeddings = await this.generateTopicEmbeddings(topic.summary);
        return { ...topic, embeddings, vocabulary: topic.vocabulary || [] };
      }),
    );

    // Apply result: close mems, archive chunks
    const newGeneralSummary: string | null = null;
    if (topicsWithEmbeddings.length > 0) {
      try {
        await this.memManager.applyBackgroundResult(
          topicsWithEmbeddings,
          tailChunkIds,
          newGeneralSummary,
          contextId,
        );
        this.log.info({ topicsClosed: topicsWithEmbeddings.length }, 'BackgroundIndexer.index: applied result');
      } catch (applyError) {
        this.log.warn({ error: applyError }, 'BackgroundIndexer.index: applyBackgroundResult failed');
        return [];
      }
    }

    // Return archived chunkIds (all chunkIds across all closed topics)
    const archivedChunkIds = topicsWithEmbeddings.flatMap(t => t.chunkIds);
    return archivedChunkIds;
  }

  // ---- Private helpers ----

  /**
   * Build the system and detection prompts for the LLM summarizer.
   *
   * Builds the system and detection prompts for the ILLMSummarizer call.
   */
  private async buildPrompts(
    chunks: MemChunk[],
    contextId: string,
  ): Promise<{ systemPrompt: string; detectionPrompt: string }> {
    const knownTerms = await this.memManager.getEstablishedVocabulary(contextId, 3);
    const lastClosedTopic = await this.memManager.getLastClosedMem(contextId);

    const knownTermsSection = knownTerms.length > 0
      ? `Known vocabulary (use these exact spellings when matching):\n${knownTerms.map((t: VocabularyTerm) => `- ${t.term}`).join('\n')}\n`
      : 'No known vocabulary yet. Extract new domain-specific terms freely.\n';

    const systemPrompt = `You segment conversations into mems (atomic topic units).

DEFINITION: A mem is a SEGMENT of conversation about one subject. All messages within a segment — questions, answers, reactions, follow-ups — belong to the SAME mem as long as the subject hasn't changed.

GRANULARITY CALIBRATION:
- TOO FINE (wrong): one mem per message (613), (614), (615)...
- CORRECT: one mem per subject — "Setting up roleplay rules" (613-618), "Meeting in cafe over books" (619-624)
- TOO COARSE (wrong): entire conversation = one mem

MERGING RULE: If two adjacent chunks discuss the same subject (one asks, the other answers) — they are ONE mem. Keep merging until the subject changes.

SPLITTING CHECK: If a mem exceeds 6 chunks, verify the subject didn't shift midway. If it did — split at the shift point. Example: "discussing literature" (10 chunks) might actually be "meeting over Latin American books" + "debating Russian classics" — two different subjects.

The LAST mem is always OPEN — put all its chunks in tailChunkIds. A mem is only CLOSED when a different subject starts after it.

OUTPUT: For each closed mem — chunkIds + summary.

SUMMARY RULES:
- Write the summary in the SAME LANGUAGE as the conversation
- The summary is a MEMORY, not a headline. It must contain all extractable facts in a concise form
- PRESERVE: numbers, dates, names, specific facts, relationships, conclusions, decisions, actionable details
- SECONDARY: emotions, filler words, pleasantries — include only if they carry meaning
- Length: as many sentences as needed to capture all key facts (typically 3-8 sentences for substantive topics, 1-2 for simple exchanges)
- Think of it as: "What would someone need to know to continue this conversation after forgetting everything?"

VOCABULARY EXTRACTION:
For each closed topic, extract domain-specific TERMS — words and phrases that serve as "points in meaning space", anchoring thoughts to specific domains, technologies, or concepts. Terms connect mems that share the same subject matter.

WHAT IS A TERM:
A term has a SPECIFIC REFERENT — it names a concrete thing, not an abstract action or category:
- "PostgreSQL" YES (specific DB), "database" NO (category)
- "React" YES (specific library), "framework" NO (category)
A term is a NAMED ENTITY in the broadest sense: a technology, library, tool, protocol, pattern, methodology, product, project, service, role, concept, or standard.
It would appear in a glossary or index, not in a dictionary of common words.

WHAT IS NOT A TERM:
- Category words without specific referent: server, database, function, component, module, endpoint
- Action verbs even if technical: deploy, refactor, debug, implement, configure, migrate
- Generic adjectives/adverbs: async, recursive, scalable
- Everyday words: message, answer, problem, result, list

${knownTermsSection}
Rules:
- For each term: count = approximate number of occurrences within this topic's chunks
- Match to known vocabulary first (use the exact spelling from the list above)
- Only add NEW terms if they are clearly domain-specific and NOT from voice-transcribed content
- Voice-transcribed content (marked with [Voice] or similar indicators): ONLY match to known terms, do NOT introduce new terms from voice input — transcription errors would pollute the vocabulary
- A high count for a term in one topic suggests that topic contains the term's definition
- Preserve original capitalization for new terms
- When unsure if something qualifies — include it. Precision is ensured by the count threshold: noise terms naturally stay below the threshold and get filtered out`;

    const chunksText = chunks
      .map(c => `[id:${c.id}] ${c.content}`)
      .join('\n');

    const lastTopicContext = lastClosedTopic
      ? `Last closed topic: "${lastClosedTopic.summary.substring(0, 200).trim()}"\nNote: the first chunks below may be a tail from this topic.\n\n`
      : '';

    const detectionPrompt = `${lastTopicContext}Conversation chunks:
${chunksText}

Identify the topics. For each completed topic, provide a summary and the chunk IDs that belong to it. Chunks that belong to the ongoing (not yet completed) topic go into tailChunkIds.`;

    return { systemPrompt, detectionPrompt };
  }

  /**
   * Generate embedding (1536-dim) for a topic summary.
   * Returns empty embeddings if embedding service is not available or fails.
   */
  private async generateTopicEmbeddings(summary: string): Promise<TopicEmbeddings> {
    if (!this.embeddingService) {
      return EMPTY_EMBEDDINGS;
    }

    const result = await this.embeddingService.embed(summary);
    if (!result.ok) {
      this.log.warn({ error: result.error }, 'BackgroundIndexer: failed to generate topic embeddings, using empty');
      return EMPTY_EMBEDDINGS;
    }

    return {
      full: result.value.compact,
    };
  }
}
