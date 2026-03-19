// src/openrouter-chat.ts
// OpenRouterChat: a chat wrapper that uses LLMem for memory and OpenRouter API for LLM inference.

import { z } from 'zod';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ok, err } from './shared/result.js';
import type { Result } from './shared/result.js';
import type { RecallNode, MessageEntry, MemChunk, RecallResult } from './types.js';
import type { IMemStore } from './types.js';
import { retrySleep } from './retry-sleep.js';

// ============================================================
// Tool calling types
// ============================================================

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatResponseWithTools {
  text: string | null;
  toolCalls: ToolCall[];
  recall: string[];
}

// ---- Inline types for optional session/embedding deps (implementations removed) ----

/** Result of session consolidation */
export interface ConsolidationResult {
  sessionId: string;
  nodeCount: number;
}

/** Session consolidator (optional dep) */
export interface ISessionConsolidator {
  consolidate(contextId: string, sessionId: string, primaryUserName?: string): Promise<Result<ConsolidationResult, { message: string }>>;
}

/** Precontext data loaded before a session */
export interface PrecontextData {
  projectState: string;
  recentSessions: string[];
}

/** Precontext loader (optional dep) */
export interface IPrecontextLoader {
  loadPrecontext(contextId: string): Promise<Result<PrecontextData, { message: string }>>;
}

/** Embedding result */
interface EmbeddingValue {
  compact: number[];
}

/** Embedding service (optional dep) */
export interface IEmbeddingService {
  embed(text: string): Promise<Result<EmbeddingValue, { message: string }>>;
}
import { MemManager, InMemoryMemStore } from './services/mem-manager.js';
import { createMemoryLogger } from './logging.js';

// ============================================================
// LLMem interface — minimal contract for memory backend
// ============================================================

export type MemoryError =
  | { type: 'config'; message: string }
  | { type: 'connection'; message: string }
  | { type: 'extraction'; message: string }
  | { type: 'storage'; message: string }
  | { type: 'query'; message: string };

export interface RecallMemoryResult {
  recall: RecallResult;
}

export interface StoreResult {
  stored: true;
}

/** Minimal interface for a memory backend used by OpenRouterChat */
export interface LLMem {
  /** Context identifier for this memory instance */
  contextId: string;
  /** Store text in memory */
  store(text: string, metadata?: { sessionId?: string }): Promise<Result<StoreResult, MemoryError>>;
  /** Recall relevant knowledge for a query */
  recall(query: string): Promise<Result<RecallMemoryResult, MemoryError>>;
}

// ============================================================
// Types
// ============================================================

export interface OpenRouterChatOptions {
  /** OpenRouter API key */
  apiKey: string;
  /** System prompt for the LLM */
  systemPrompt: string;
  /** Memory module instance (must be initialized) */
  llmem: LLMem;
  /** OpenRouter model name */
  model?: string;
  /** Session consolidator — required for consolidateSession() */
  sessionConsolidator?: ISessionConsolidator;
  /** Precontext loader — required for getPrecontext() */
  precontextLoader?: IPrecontextLoader;
  /** Mem store implementation — if not provided, uses InMemoryMemStore */
  memStore?: IMemStore;
  /** Embedding service — used to generate Matryoshka embeddings for closed mems */
  embeddingService?: IEmbeddingService;
  /** Enable debug logging of every LLM call to a JSONL file */
  debugLog?: boolean;
  /** Path to the debug log file (default: logs/llm-calls.jsonl) */
  debugLogPath?: string;
  /** Optional structured response format for LLM output */
  responseFormat?: {
    schema: z.ZodSchema;
    systemInstructions?: string;
  };
  /** Debounce delay (ms) before background summarization runs. Default: 60000 (60s). */
  backgroundDebounceMs?: number;
  /** Optional callback to retrieve behavior instructions for the LLM context */
  getBehaviorInstructions?: () => Promise<string>;
}

export interface ChatResponse {
  /** The LLM response text */
  text: string;
  /** Recall result used to build context */
  recall: RecallMemoryResult;
}

/** Diagnostic result from dryRun() — shows what the LLM saw and what would happen */
export interface DryRunResult {
  /** The actual response */
  response: string;

  /** What the LLM saw (context assembly) */
  context: {
    systemPrompt: string;
    generalSummary: string;
    closedTopicSummaries: { id: string; summary: string }[];
    recallNodes: { text: string; score?: number }[];
    activeChunkCount: number;
    activeChunks: { content: string }[];
    userMessage: string;
  };

  /** Token budget (approximate) */
  totalContextChars: number;

  /** Topic state */
  currentChunkCount: number;
  closedTopicCount: number;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MAX_RETRIES = 5;
const OPENROUTER_RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

/** Response format for structured JSON output from OpenRouter */
interface ResponseFormat {
  type: string;
  json_schema?: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
}

// TODO: re-enable general summary when memory is mature
// /** JSON schema for general summary update */
// const GENERAL_SUMMARY_UPDATE_FORMAT: ResponseFormat = {
//   type: 'json_schema',
//   json_schema: {
//     name: 'general_summary_update',
//     strict: true,
//     schema: {
//       type: 'object',
//       properties: {
//         general_summary: { type: 'string' },
//       },
//       required: ['general_summary'],
//       additionalProperties: false,
//     },
//   },
// };
//
// /** Zod schema for general summary update result */
// const GeneralSummaryUpdateSchema = z.object({
//   general_summary: z.string(),
// });

/** Zod schema for background summarization LLM result */
const BackgroundSummarizationSchema = z.object({
  topics: z.array(z.object({
    summary: z.string(),
    chunkIds: z.array(z.string()),
  })),
  tailChunkIds: z.array(z.string()),
});

/** Matryoshka embedding set for a closed topic */
type TopicEmbeddings = {
  full: number[];    // 1024 dims
  compact: number[]; // 256 dims
  micro: number[];   // 64 dims
};

/** Empty embeddings fallback when embedding service is unavailable */
const EMPTY_EMBEDDINGS: TopicEmbeddings = { full: [], compact: [], micro: [] };

/** Background summarization result type */
type BackgroundResult = {
  topics: { summary: string; chunkIds: string[]; embeddings: TopicEmbeddings }[];
  tailChunkIds: string[];
  newGeneralSummary: string | null;
};

/** JSON schema for background summarization response */
const BACKGROUND_SUMMARIZATION_FORMAT: ResponseFormat = {
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
            },
            required: ['summary', 'chunkIds'],
            additionalProperties: false,
          },
        },
        tailChunkIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['topics', 'tailChunkIds'],
      additionalProperties: false,
    },
  },
};

/** System prompt for the chat assistant (plain text, no topic detection) */
const CHAT_SYSTEM_PROMPT = `You are a personal AI assistant in a continuous conversation. You are the user's close friend — warm, supportive, emotionally engaged.

You MUST respond in the same language the user writes in. If the user writes in Russian, respond in Russian. If in English, respond in English.`;

// ============================================================
// OpenRouterChat class
// ============================================================

/**
 * Chat wrapper that combines LLMem memory with OpenRouter LLM inference.
 *
 * Main flow (prompt method):
 * 1. Store user message in memory
 * 2. Recall relevant knowledge
 * 3. Build context from recalled nodes
 * 4. Call OpenRouter API with system prompt + context + user message
 * 5. Store LLM response in memory
 * 6. Return response
 *
 * Also re-hosts session methods:
 * - consolidateSession() — delegates to ISessionConsolidator
 * - getPrecontext() — delegates to IPrecontextLoader
 * - buildContext() — formats recalled nodes into text for LLM context
 */
export class OpenRouterChat {
  private readonly apiKey: string;
  private readonly systemPrompt: string;
  private readonly llmem: LLMem;
  private readonly model: string;
  private readonly log = createMemoryLogger({ name: 'openrouter-chat' });
  private readonly memManager: MemManager;
  private readonly debugLog: boolean;
  private readonly debugLogPath: string;
  private readonly responseFormat?: OpenRouterChatOptions['responseFormat'];
  private readonly embeddingService: IEmbeddingService | undefined;
  private readonly backgroundDebounceMs: number;
  private readonly getBehaviorInstructions?: (() => Promise<string>) | undefined;

  // Concurrency management for background summarization
  private isSummarizing = false;
  private pendingResult: BackgroundResult | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;

  // Optional session deps
  private readonly sessionConsolidator?: ISessionConsolidator;
  private readonly precontextLoader?: IPrecontextLoader;

  constructor(options: OpenRouterChatOptions) {
    this.apiKey = options.apiKey;
    this.systemPrompt = options.systemPrompt;
    this.llmem = options.llmem;
    this.model = options.model ?? DEFAULT_MODEL;
    this.memManager = new MemManager(options.memStore ?? new InMemoryMemStore());
    this.embeddingService = options.embeddingService;
    this.debugLog = options.debugLog ?? false;
    this.debugLogPath = options.debugLogPath ?? 'logs/llm-calls.jsonl';
    this.responseFormat = options.responseFormat;
    this.backgroundDebounceMs = options.backgroundDebounceMs ?? 600_000;
    this.getBehaviorInstructions = options.getBehaviorInstructions;

    if (this.debugLog) {
      mkdirSync(dirname(this.debugLogPath), { recursive: true });
    }

    if (options.sessionConsolidator !== undefined) this.sessionConsolidator = options.sessionConsolidator;
    if (options.precontextLoader !== undefined) this.precontextLoader = options.precontextLoader;
  }

  // ---- Topic stats (for external monitoring / testing) ----

  /**
   * Returns topic management statistics for external observation.
   * Useful for integration tests and monitoring topic changes.
   */
  async getTopicStats(): Promise<{
    closedTopicCount: number;
    activeChunkCount: number;
    generalSummary: string;
    closedTopics: Array<{ id: string; summary: string; chunkIds: string[]; closedAt: Date }>;
  }> {
    const contextId = this.llmem.contextId;
    const contextData = await this.memManager.getContextData(contextId);
    const closedTopicCount = await this.memManager.getClosedMemCount(contextId);
    const closedTopics = await this.memManager.getAllClosedMems(contextId);
    return {
      closedTopicCount,
      activeChunkCount: contextData.activeChunks.length,
      generalSummary: contextData.generalSummary,
      closedTopics,
    };
  }

  // ---- Public memory access ----

  /**
   * Store an assistant message in memory (topic manager).
   * Use when the assistant response is handled externally (e.g., tool calls
   * that produce a summary instead of the raw response text).
   */
  async storeAssistantMessage(text: string): Promise<void> {
    const contextId = this.llmem.contextId;
    await this.memManager.addChunk('assistant: ' + text, new Date(), contextId);
  }

  // ---- Main chat method ----

  /**
   * Send a message and get a response.
   *
   * Flow:
   * 1. Apply pending background result if available
   * 2. Store user message in memory and topic manager
   * 3. Recall relevant knowledge via llmem.recall()
   * 4. Build topic-aware context (layered assembly)
   * 5. Call OpenRouter API (plain text or structured if responseFormat set)
   * 6. Store LLM response in memory and topic manager
   * 7. Launch background summarization
   * 8. Return response text
   */
  async prompt(
    message: string,
    options?: { sessionId?: string; dryRun?: boolean },
  ): Promise<Result<ChatResponse, MemoryError>> {
    const isDryRun = options?.dryRun === true;
    const sessionId = options?.sessionId;
    const contextId = this.llmem.contextId;

    // Apply pending background result if available
    if (!isDryRun && this.pendingResult) {
      try {
        await this.memManager.applyBackgroundResult(
          this.pendingResult.topics,
          this.pendingResult.tailChunkIds,
          this.pendingResult.newGeneralSummary,
          contextId,
        );
      } catch (topicError) {
        this.log.warn({ error: topicError }, 'prompt: failed to apply pending topic result, continuing');
      }
      this.pendingResult = null;
    }

    // 1. Store user message in memory
    if (!isDryRun) {
      const storeResult = await this.llmem.store(message, sessionId !== undefined ? { sessionId } : undefined);
      if (!storeResult.ok) {
        this.log.warn({ error: storeResult.error }, 'prompt: failed to store user message, continuing');
      }
    }

    // Add user message to topic manager (with role prefix in content)
    if (!isDryRun) {
      try {
        await this.memManager.addChunk('user: ' + message, new Date(), contextId);
      } catch (topicError) {
        this.log.warn({ error: topicError }, 'prompt: failed to add user chunk to topic manager, continuing');
      }
    }

    // 2. Recall relevant knowledge
    const recallResult = await this.llmem.recall(message);
    if (!recallResult.ok) {
      return err(recallResult.error);
    }
    const recall = recallResult.value;

    // 3. Build topic-aware context
    let systemContent: string;
    let conversationMessages: Array<{ role: string; content: string }>;
    try {
      const topicContext = await this.buildTopicContext(message, recall.recall.nodes);
      systemContent = topicContext.systemContent;
      conversationMessages = topicContext.conversationMessages;
    } catch (topicError) {
      this.log.warn({ error: topicError }, 'prompt: failed to build topic context, using fallback');
      systemContent = CHAT_SYSTEM_PROMPT + (this.systemPrompt.length > 0 ? `\n\n## Your personality and instructions\n\n${this.systemPrompt}` : '');
      conversationMessages = [{ role: 'user', content: message }];
    }

    // In dryRun mode, the user message is not in topicManager, so append it manually
    const finalMessages = isDryRun
      ? [...conversationMessages, { role: 'user', content: message }]
      : conversationMessages;

    // 4. Call OpenRouter API — plain text or structured if responseFormat is configured
    const effectiveSystem = this.responseFormat?.systemInstructions
      ? systemContent + '\n\n' + this.responseFormat.systemInstructions
      : systemContent;
    const apiResult = await this.callOpenRouter(effectiveSystem, finalMessages, undefined, 0);
    if (!apiResult.ok) {
      return err(apiResult.error);
    }

    const responseText = apiResult.value;

    // 5. Store LLM response in memory and topic manager
    if (!isDryRun) {
      const responseStoreResult = await this.llmem.store(responseText, sessionId !== undefined ? { sessionId } : undefined);
      if (!responseStoreResult.ok) {
        this.log.warn({ error: responseStoreResult.error }, 'prompt: failed to store LLM response, continuing');
      }

      try {
        await this.memManager.addChunk('assistant: ' + responseText, new Date(), contextId);
      } catch (topicError) {
        this.log.warn({ error: topicError }, 'prompt: failed to add assistant chunk to topic manager, continuing');
      }
    }

    // 6. Launch background summarization if not already running
    if (!isDryRun) {
      try {
        this.launchBackgroundSummarization(contextId);
      } catch (topicError) {
        this.log.warn({ error: topicError }, 'prompt: failed to launch background summarization, continuing');
      }
    }

    // 7. Return
    return ok({ text: responseText, recall });
  }

  // ---- Read-only query method ----

  /**
   * Send a read-only question that uses memory and topic context but does NOT modify state.
   *
   * Unlike prompt(), ask() does NOT:
   * - Store user or assistant messages in memory (llmem.store)
   * - Add messages to topicManager
   * - Trigger topic change detection
   *
   * It DOES:
   * - Call recall() to retrieve relevant knowledge
   * - Use buildTopicContext() for full conversational context
   * - Call the LLM and return a plain text response
   *
   * Use case: verification questions, read-only probes during testing.
   */
  async ask(question: string): Promise<string> {
    // 1. Recall relevant knowledge (read-only operation)
    const recallResult = await this.llmem.recall(question);
    const recallNodes = recallResult.ok ? recallResult.value.recall.nodes : [];

    // 2. Build topic-aware context (reads current state without modifying it)
    const { systemContent, conversationMessages } = await this.buildTopicContext(question, recallNodes);

    // 3. For ask(), replace the chat system prompt with a simpler one.
    //    buildTopicContext prepends CHAT_SYSTEM_PROMPT — for ask() we want a neutral tone.
    const askSystemContent = systemContent.replace(
      CHAT_SYSTEM_PROMPT,
      'You are a personal AI assistant in a continuous conversation. Respond naturally in plain text.',
    );

    // 4. Append the question as a user turn (not added to topicManager, so not in conversationMessages)
    const messages = [
      ...conversationMessages,
      { role: 'user', content: question },
    ];

    // 5. Call LLM without JSON schema format — plain text response
    const result = await this.callOpenRouter(askSystemContent, messages, undefined, 0);
    if (!result.ok) {
      throw new Error(`ask() failed: ${result.error.message}`);
    }

    return result.value;
  }

  // ---- Dry run (diagnostic) method ----

  /**
   * Run a full prompt cycle without modifying any state.
   *
   * Does everything prompt() does — recall, build context, call LLM, parse response —
   * but does NOT store messages, add to topicManager, close topics, or update summaries.
   *
   * Returns a detailed diagnostic object showing what the LLM saw and what would happen.
   */
  async dryRun(message: string): Promise<DryRunResult> {
    // Delegate to prompt() with dryRun flag — no state modification
    const result = await this.prompt(message, { dryRun: true });
    if (!result.ok) {
      throw new Error(`dryRun failed: ${result.error.message}`);
    }

    const { text: response } = result.value;
    const recallNodes = result.value.recall.recall.nodes;

    // Build context for diagnostics (read-only)
    const contextId = this.llmem.contextId;
    const { systemContent, conversationMessages } = await this.buildTopicContext(message, recallNodes);

    // Collect context diagnostics
    const contextData = await this.memManager.getContextData(contextId);
    const activeChunks = await this.memManager.getActiveChunks(contextId);

    return {
      response,
      context: {
        systemPrompt: systemContent.substring(0, 500) + (systemContent.length > 500 ? '...' : ''),
        generalSummary: contextData.generalSummary,
        closedTopicSummaries: [
          ...contextData.recentClosedMems.map(t => ({ id: t.id, summary: t.summary })),
          ...(contextData.lastClosedMem ? [{ id: contextData.lastClosedMem.id, summary: contextData.lastClosedMem.summary }] : []),
        ],
        recallNodes: recallNodes.map(n => ({ text: n.text?.substring(0, 200) || '', ...(n.similarity !== undefined && { score: n.similarity }) })),
        activeChunkCount: activeChunks.length,
        activeChunks: activeChunks.slice(-5).map(c => ({ content: c.content.substring(0, 200) })),
        userMessage: message,
      },
      totalContextChars: systemContent.length + conversationMessages.reduce((acc, m) => acc + m.content.length, 0) + message.length,
      currentChunkCount: activeChunks.length,
      closedTopicCount: await this.memManager.getClosedMemCount(contextId),
    };
  }

  // ---- Session methods (re-hosted from LLMem) ----

  /**
   * Consolidate a session: create session node, topic segments, link entities,
   * apply temporal classifications, and trigger community re-detection.
   *
   * Requires sessionConsolidator to be provided in constructor options.
   */
  async consolidateSession(
    sessionId: string,
    primaryUserName?: string,
  ): Promise<Result<ConsolidationResult, MemoryError>> {
    if (!this.sessionConsolidator) {
      return err({ type: 'config' as const, message: 'sessionConsolidator not provided — consolidateSession() unavailable' });
    }

    const result = await this.sessionConsolidator.consolidate(this.llmem.contextId, sessionId, primaryUserName);
    if (!result.ok) {
      return err({ type: 'extraction' as const, message: result.error.message });
    }
    return ok(result.value);
  }

  /**
   * Load precontext (project state + recent session summaries).
   *
   * Requires precontextLoader to be provided in constructor options.
   */
  async getPrecontext(): Promise<Result<PrecontextData, MemoryError>> {
    if (!this.precontextLoader) {
      return err({ type: 'config' as const, message: 'precontextLoader not provided — getPrecontext() unavailable' });
    }

    const result = await this.precontextLoader.loadPrecontext(this.llmem.contextId);
    if (!result.ok) {
      return err({ type: 'query' as const, message: result.error.message });
    }
    return ok(result.value);
  }

  /**
   * Build a text context string from messages and recalled knowledge nodes.
   *
   * Used internally by prompt() and exposed for external use (e.g., custom chat loops).
   */
  buildContext(messages: MessageEntry[], recallNodes: RecallNode[]): string {
    const sections: string[] = [];

    // Add recalled knowledge
    if (recallNodes.length > 0) {
      const knowledgeLines: string[] = [];
      for (const node of recallNodes) {
        const parts: string[] = [node.text];

        if (node.fragmentTitle) {
          parts.unshift(`[${node.fragmentTitle}]`);
        }
        if (node.eventTime) {
          parts.push(`(${node.eventTime})`);
        }
        if (node.match === 'neighbor' && node.relation) {
          parts.push(`[via: ${node.relation}]`);
        }

        knowledgeLines.push(`- ${parts.join(' ')}`);
      }
      sections.push(knowledgeLines.join('\n'));
    }

    // Add recent messages for conversational context
    if (messages.length > 0) {
      const messageLines = messages.map(
        (m) => `${m.role}: ${m.content}`,
      );
      sections.push(`### Recent conversation\n${messageLines.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  // ---- Topic management helpers ----

  /**
   * Build topic-aware context with layered assembly.
   *
   * Layer order:
   * 1. System prompt (plain text, no topic detection)
   * 2. General summary (all topics older than last 3)
   * 3. Recent closed topics (N-2, N-1) — just summaries
   * 4. Recall nodes from LLMem
   * 5. Last closed topic (N) — summary for context
   * 6. Active topic chunks (already in conversation)
   * 7. New user message (last in active chunks, becomes the user turn)
   */
  private async buildTopicContext(
    _userMessage: string,
    recallNodes: RecallNode[],
  ): Promise<{ systemContent: string; conversationMessages: Array<{ role: string; content: string }> }> {
    const contextId = this.llmem.contextId;
    const contextData = await this.memManager.getContextData(contextId);
    const systemParts: string[] = [CHAT_SYSTEM_PROMPT];

    // Additional user-provided system prompt
    if (this.systemPrompt.length > 0) {
      systemParts.push(`\n\n## Your personality and instructions\n\n${this.systemPrompt}`);
    }

    // Layer 2: General summary
    // TODO: re-enable general summary when memory is mature
    // if (contextData.generalSummary.length > 0) {
    //   systemParts.push(`\n\n## Conversation history (general summary)\n\n${contextData.generalSummary}`);
    // }

    // Layer 3: Recent closed mems (N-2, N-1) — summaries only
    if (contextData.recentClosedMems.length > 0) {
      const memSummaries = contextData.recentClosedMems
        .map((t) => `- ${t.summary}`)
        .join('\n');
      systemParts.push(`\n\n## Recent topics discussed\n\n${memSummaries}`);
    }

    // Layer 4: Recall nodes
    const recallContext = this.buildContext([], recallNodes);
    if (recallContext.length > 0) {
      systemParts.push(`\n\n## Relevant Memory\n\n${recallContext}`);
    }

    // Layer 5: Last closed mem — summary for context
    if (contextData.lastClosedMem) {
      const last = contextData.lastClosedMem;
      systemParts.push(`\n\n## Previous topic (just ended)\n\nSummary: ${last.summary}`);
    }

    let systemContent = systemParts.join('');

    // Inject behavior instructions if available
    const behaviorInstructions = await this.getBehaviorInstructions?.();
    if (behaviorInstructions) {
      systemContent += `\n<!-- BEHAVIOR_INSTRUCTIONS_START -->\n${behaviorInstructions}\n<!-- BEHAVIOR_INSTRUCTIONS_END -->`;
    }

    // Layer 6+7: Active topic chunks as conversation turns
    // Chunks contain role prefix (e.g. "user: hello") — parse role from content
    const activeChunks = contextData.activeChunks;
    const conversationMessages: Array<{ role: string; content: string }> = [];

    for (const chunk of activeChunks) {
      const { role, content } = parseChunkRole(chunk.content);
      conversationMessages.push({ role, content });
    }

    return { systemContent, conversationMessages };
  }

  // ---- Background summarization ----

  /**
   * Schedule background summarization with debounce.
   *
   * Each call resets the timer. Summarization only runs after
   * `backgroundDebounceMs` milliseconds of quiet (no new messages).
   * contextId is captured at schedule time, not at execution time.
   */
  private launchBackgroundSummarization(contextId: string): void {
    if (this.backgroundTimer !== null) {
      clearTimeout(this.backgroundTimer);
    }

    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;

      if (this.isSummarizing) return;
      this.isSummarizing = true;

      this.memManager.getActiveChunks(contextId)
        .then(chunks => {
          if (chunks.length === 0) {
            this.isSummarizing = false;
            return;
          }
          return this.backgroundSummarize(chunks, contextId)
            .then(async (result) => {
              // Apply immediately in background — don't defer to next prompt()
              if (result.topics.length > 0 || result.newGeneralSummary !== null) {
                try {
                  await this.memManager.applyBackgroundResult(
                    result.topics,
                    result.tailChunkIds,
                    result.newGeneralSummary,
                    contextId
                  );
                  this.log.info({ topicsClosed: result.topics.length }, 'background: applied result immediately');
                } catch (err) {
                  this.log.warn({ error: err }, 'background: failed to apply result, deferring');
                  this.pendingResult = result;
                }
              }
            });
        })
        .catch(error => {
          // Log error but don't crash
          this.log.error({ error }, 'Background summarization failed');
        })
        .finally(() => {
          this.isSummarizing = false;
        });
    }, this.backgroundDebounceMs);
  }

  /**
   * Background summarization: detect completed narrative arcs and summarize them.
   *
   * LLM Call #1: Detection + summarization
   * LLM Call #2: Update general summary (only if topics found)
   */
  private async backgroundSummarize(chunks: MemChunk[], contextId: string): Promise<BackgroundResult> {
    // TODO: re-enable general summary when memory is mature
    // Take snapshot of current state (needed for general summary)
    // const contextData = await this.memManager.getContextData(contextId);
    // const currentGeneralSummary = contextData.generalSummary;

    // Get only the last closed mem — for context that the first chunks may be its tail
    const lastClosedTopic = await this.memManager.getLastClosedMem(contextId);

    // Format chunks with IDs
    const chunksText = chunks
      .map(c => `[id:${c.id}] ${c.content}`)
      .join('\n');

    const systemPrompt = `You segment conversations into mems (atomic topic units).

DEFINITION: A mem is a SEGMENT of conversation about one subject. All messages within a segment — questions, answers, reactions, follow-ups — belong to the SAME mem as long as the subject hasn't changed.

GRANULARITY CALIBRATION:
- TOO FINE (wrong): one mem per message (613), (614), (615)...
- CORRECT: one mem per subject — "Setting up roleplay rules" (613-618), "Meeting in cafe over books" (619-624)
- TOO COARSE (wrong): entire conversation = one mem

MERGING RULE: If two adjacent chunks discuss the same subject (one asks, the other answers) — they are ONE mem. Keep merging until the subject changes.

SPLITTING CHECK: If a mem exceeds 6 chunks, verify the subject didn't shift midway. If it did — split at the shift point. Example: "discussing literature" (10 chunks) might actually be "meeting over Latin American books" + "debating Russian classics" — two different subjects.

The LAST mem is always OPEN — put all its chunks in tailChunkIds. A mem is only CLOSED when a different subject starts after it.

OUTPUT: For each closed mem — chunkIds + summary (1-2 sentences capturing key facts).`;

    const lastTopicContext = lastClosedTopic
      ? `Last closed topic: "${lastClosedTopic.summary.substring(0, 200).trim()}"\nNote: the first chunks below may be a tail from this topic.\n\n`
      : '';

    // LLM Call #1: Detection + summarization
    const detectionPrompt = `${lastTopicContext}Conversation chunks:
${chunksText}

Identify the topics. For each completed topic, provide a summary and the chunk IDs that belong to it. Chunks that belong to the ongoing (not yet completed) topic go into tailChunkIds.`;

    const detectionResult = await this.callOpenRouter(
      systemPrompt,
      [{ role: 'user', content: detectionPrompt }],
      BACKGROUND_SUMMARIZATION_FORMAT,
      0, // temperature=0 for deterministic topic detection
    );

    if (!detectionResult.ok) {
      this.log.warn({ error: detectionResult.error }, 'backgroundSummarize: detection LLM call failed');
      return { topics: [], tailChunkIds: chunks.map(c => c.id), newGeneralSummary: null };
    }

    const parsedJson = safeJsonParse(detectionResult.value);
    const parsed = BackgroundSummarizationSchema.safeParse(parsedJson);

    if (!parsed.success) {
      this.log.warn({ raw: detectionResult.value }, 'backgroundSummarize: failed to parse detection response');
      return { topics: [], tailChunkIds: chunks.map(c => c.id), newGeneralSummary: null };
    }

    let { topics, tailChunkIds } = parsed.data;

    // Input validation: filter out ghost topics with no chunkIds.
    // The LLM sometimes returns topics reconstructed from the general summary
    // rather than actual chunks. A topic without chunks has no meaning.
    const ghostTopics = topics.filter(t => t.chunkIds.length === 0);
    if (ghostTopics.length > 0) {
      this.log.warn(
        { ghostCount: ghostTopics.length, summaries: ghostTopics.map(t => t.summary.substring(0, 60)) },
        'backgroundSummarize: filtered out ghost topics with empty chunkIds',
      );
    }
    topics = topics.filter(t => t.chunkIds.length > 0);

    // LLM Call #2: Update general summary (only if topics were found)
    // TODO: re-enable general summary when memory is mature
    const newGeneralSummary: string | null = null;
    // if (topics.length >= 1) {
    //   const topicSummariesText = topics.map((t, i) => `${i + 1}. ${t.summary}`).join('\n');
    //
    //   const summaryPrompt = currentGeneralSummary.length > 0
    //     ? `Existing general summary:\n${currentGeneralSummary}\n\nNew topic summaries to merge:\n${topicSummariesText}\n\nMerge new topic summaries into the general summary. Each idea = ONE line. NEVER delete existing ideas. Append new ones.`
    //     : `Create a general summary from these topic summaries:\n${topicSummariesText}\n\nEach idea = ONE line.`;
    //
    //   const summaryResult = await this.callOpenRouter(
    //     'Merge new topic summaries into general summary. Each idea = ONE line. NEVER delete existing ideas. Append new ones.',
    //     [{ role: 'user', content: summaryPrompt }],
    //     GENERAL_SUMMARY_UPDATE_FORMAT,
    //     0, // temperature=0 for deterministic summary updates
    //   );
    //
    //   if (summaryResult.ok) {
    //     const summaryParsed = GeneralSummaryUpdateSchema.safeParse(safeJsonParse(summaryResult.value));
    //     if (summaryParsed.success) {
    //       const candidate = summaryParsed.data.general_summary;
    //       // Guard against information loss
    //       if (currentGeneralSummary.length > 0 && candidate.length < currentGeneralSummary.length * 0.8) {
    //         this.log.warn(
    //           { oldLen: currentGeneralSummary.length, newLen: candidate.length },
    //           'backgroundSummarize: LLM shrunk summary by >20%, appending instead',
    //         );
    //         newGeneralSummary = currentGeneralSummary + '\n' + topics.map(t => t.summary).join('\n');
    //       } else {
    //         newGeneralSummary = candidate;
    //       }
    //     }
    //   }
    // }

    // Generate Matryoshka embeddings for each topic
    const topicsWithEmbeddings = await Promise.all(
      topics.map(async (topic) => {
        const embeddings = await this.generateTopicEmbeddings(topic.summary);
        return { ...topic, embeddings };
      }),
    );

    return { topics: topicsWithEmbeddings, tailChunkIds, newGeneralSummary };
  }

  /**
   * Generate Matryoshka embeddings (1024/256/64) for a topic summary.
   * Returns empty embeddings if embedding service is not available or fails.
   */
  private async generateTopicEmbeddings(summary: string): Promise<TopicEmbeddings> {
    if (!this.embeddingService) {
      return EMPTY_EMBEDDINGS;
    }

    const result = await this.embeddingService.embed(summary);
    if (!result.ok) {
      this.log.warn({ error: result.error }, 'Failed to generate topic embeddings, using empty');
      return EMPTY_EMBEDDINGS;
    }

    // Embedding service returns full (4096) and compact (1024).
    // For topics: full=compact(1024), compact=truncate+normalize(256), micro=truncate+normalize(64)
    const vector1024 = result.value.compact; // Already 1024-dim and L2-normalized
    const compact256 = l2Normalize(vector1024.slice(0, 256));
    const micro64 = l2Normalize(vector1024.slice(0, 64));

    return {
      full: vector1024,
      compact: compact256,
      micro: micro64,
    };
  }

  // ---- Tool calling methods ----

  /**
   * Send a message with tool definitions and get a response that may include tool calls.
   *
   * Flow:
   * 1. Apply pending background result if available
   * 2. Store user message in memory and topic manager
   * 3. Recall relevant knowledge via llmem.recall()
   * 4. Build topic-aware context (layered assembly)
   * 5. Call OpenRouter API with tools
   * 6. Store messages in memory (user always, assistant only if text is non-null)
   * 7. Launch background summarization
   * 8. Return { text, toolCalls, recall }
   */
  async promptWithTools(
    message: string,
    tools: ToolDefinition[],
    options?: { sessionId?: string },
  ): Promise<Result<ChatResponseWithTools, MemoryError>> {
    const sessionId = options?.sessionId;
    const contextId = this.llmem.contextId;

    // Apply pending background result if available
    if (this.pendingResult) {
      try {
        await this.memManager.applyBackgroundResult(
          this.pendingResult.topics,
          this.pendingResult.tailChunkIds,
          this.pendingResult.newGeneralSummary,
          contextId,
        );
      } catch (topicError) {
        this.log.warn({ error: topicError }, 'promptWithTools: failed to apply pending topic result, continuing');
      }
      this.pendingResult = null;
    }

    // 1. Store user message in memory
    const storeResult = await this.llmem.store(message, sessionId !== undefined ? { sessionId } : undefined);
    if (!storeResult.ok) {
      this.log.warn({ error: storeResult.error }, 'promptWithTools: failed to store user message, continuing');
    }

    // Add user message to topic manager
    try {
      await this.memManager.addChunk('user: ' + message, new Date(), contextId);
    } catch (topicError) {
      this.log.warn({ error: topicError }, 'promptWithTools: failed to add user chunk to topic manager, continuing');
    }

    // 2. Recall relevant knowledge
    const recallResult = await this.llmem.recall(message);
    if (!recallResult.ok) {
      return err(recallResult.error);
    }
    const recall = recallResult.value;

    // 3. Build topic-aware context
    let systemContent: string;
    let conversationMessages: Array<{ role: string; content: string }>;
    try {
      const topicContext = await this.buildTopicContext(message, recall.recall.nodes);
      systemContent = topicContext.systemContent;
      conversationMessages = topicContext.conversationMessages;
    } catch (topicError) {
      this.log.warn({ error: topicError }, 'promptWithTools: failed to build topic context, using fallback');
      systemContent = CHAT_SYSTEM_PROMPT + (this.systemPrompt.length > 0 ? `\n\n## Your personality and instructions\n\n${this.systemPrompt}` : '');
      conversationMessages = [{ role: 'user', content: message }];
    }

    // 4. Call OpenRouter API with tools
    const apiResult = await this.callOpenRouterWithTools(
      [
        { role: 'system', content: systemContent },
        ...conversationMessages,
      ],
      tools,
    );
    if (!apiResult.ok) {
      return err(apiResult.error);
    }

    const { text, toolCalls } = apiResult.value;

    // 5. Store assistant response in memory (only if text is non-null)
    if (text !== null) {
      const responseStoreResult = await this.llmem.store(text, sessionId !== undefined ? { sessionId } : undefined);
      if (!responseStoreResult.ok) {
        this.log.warn({ error: responseStoreResult.error }, 'promptWithTools: failed to store LLM response, continuing');
      }

      try {
        await this.memManager.addChunk('assistant: ' + text, new Date(), contextId);
      } catch (topicError) {
        this.log.warn({ error: topicError }, 'promptWithTools: failed to add assistant chunk to topic manager, continuing');
      }
    }

    // 6. Launch background summarization
    try {
      this.launchBackgroundSummarization(contextId);
    } catch (topicError) {
      this.log.warn({ error: topicError }, 'promptWithTools: failed to launch background summarization, continuing');
    }

    // 7. Return — recall as string array of node texts
    const recallTexts = recall.recall.nodes.map(n => n.text);
    return ok({ text, toolCalls, recall: recallTexts });
  }

  // ---- Private helpers ----

  /**
   * Call OpenRouter API with tool definitions.
   * Separate from callOpenRouter() to avoid modifying existing callers.
   */
  private async callOpenRouterWithTools(
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
  ): Promise<Result<{ text: string | null; toolCalls: ToolCall[] }, MemoryError>> {
    const startTime = Date.now();
    const callType = this.debugLog ? 'tool_call' : '';

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages,
      tools,
      max_tokens: 32768,
    };

    let lastError: string | null = null;

    for (let attempt = 0; attempt <= OPENROUTER_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(OPENROUTER_API_URL, {
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

          if (OPENROUTER_RETRYABLE_STATUSES.has(response.status) && attempt < OPENROUTER_MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000;
            this.log.warn({ attempt: attempt + 1, status: response.status, delay }, 'OpenRouter (tools): retryable error, retrying');
            await retrySleep(delay);
            continue;
          }

          this.log.error(
            { status: response.status, error: errorText },
            'OpenRouter API error (with tools)',
          );

          if (this.debugLog) {
            this.writeDebugLog({
              callType,
              systemContent: messages[0]?.content ?? '',
              messages: messages.slice(1),
              responseFormat: undefined,
              responseJson: null,
              responseContent: null,
              durationMs: Date.now() - startTime,
              error: lastError,
            });
          }

          return err({
            type: 'query' as const,
            message: `OpenRouter API error (${response.status})`,
          });
        }

        const data = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: ToolCall[];
            };
            finish_reason?: string;
          }>;
        };

        const message = data.choices?.[0]?.message;
        const content = message?.content ?? null;
        const toolCalls = message?.tool_calls ?? [];
        const isEmpty = !content && toolCalls.length === 0;

        if (isEmpty && attempt < OPENROUTER_MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          this.log.warn({ attempt: attempt + 1, delay }, 'OpenRouter (tools): empty response, retrying');
          await retrySleep(delay);
          continue;
        }

        if (this.debugLog) {
          this.writeDebugLog({
            callType,
            systemContent: messages[0]?.content ?? '',
            messages: messages.slice(1),
            responseFormat: undefined,
            responseJson: data,
            responseContent: typeof content === 'string' ? content : null,
            durationMs: Date.now() - startTime,
            error: null,
          });
        }

        return ok({ text: typeof content === 'string' ? content : null, toolCalls });
      } catch (error) {
        lastError = String(error);

        if (attempt < OPENROUTER_MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          this.log.warn({ attempt: attempt + 1, error: lastError, delay }, 'OpenRouter (tools): network error, retrying');
          await retrySleep(delay);
          continue;
        }

        this.log.error({ error }, 'OpenRouter API call with tools failed');

        if (this.debugLog) {
          this.writeDebugLog({
            callType,
            systemContent: messages[0]?.content ?? '',
            messages: messages.slice(1),
            responseFormat: undefined,
            responseJson: null,
            responseContent: null,
            durationMs: Date.now() - startTime,
            error: lastError,
          });
        }

        return err({
          type: 'query' as const,
          message: 'OpenRouter API call with tools failed',
        });
      }
    }

    // Should not reach here, but safety fallback
    return err({
      type: 'query' as const,
      message: `OpenRouter API failed after ${OPENROUTER_MAX_RETRIES} retries: ${lastError}`,
    });
  }

  /**
   * Determine the call type based on systemContent heuristics.
   * Used for debug logging to categorize LLM calls.
   */
  private inferCallType(systemContent: string): string {
    if (systemContent.includes('conversation analyst')) return 'background_summarization';
    if (systemContent.includes('NEVER delete existing ideas')) return 'general_summary_update';
    if (systemContent.includes('Respond naturally in plain text')) return 'ask_query';
    return 'main_response';
  }

  /**
   * Write a debug log entry for an LLM call to the JSONL file.
   */
  private writeDebugLog(entry: {
    callType: string;
    systemContent: string;
    messages: Array<{ role: string; content: string }>;
    responseFormat: ResponseFormat | undefined;
    responseJson: unknown;
    responseContent: string | null;
    durationMs: number;
    error: string | null;
  }): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      model: this.model,
      call_type: entry.callType,
      system_prompt: entry.systemContent,
      messages: entry.messages,
      response_format: entry.responseFormat ?? null,
      response_json: entry.responseJson,
      response_content: entry.responseContent,
      duration_ms: entry.durationMs,
      error: entry.error,
    };
    appendFileSync(this.debugLogPath, JSON.stringify(logEntry) + '\n', 'utf-8');
  }

  private async callOpenRouter(
    systemContent: string,
    messages: Array<{ role: string; content: string }>,
    responseFormat?: ResponseFormat,
    temperature?: number,
  ): Promise<Result<string, MemoryError>> {
    const startTime = Date.now();
    const callType = this.debugLog ? this.inferCallType(systemContent) : '';

    const fullMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemContent },
      ...messages,
    ];

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages: fullMessages,
    };

    if (responseFormat) {
      requestBody['response_format'] = responseFormat;
    }

    if (temperature !== undefined) {
      requestBody['temperature'] = temperature;
    }

    let lastError: string | null = null;

    for (let attempt = 0; attempt <= OPENROUTER_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(OPENROUTER_API_URL, {
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

          if (OPENROUTER_RETRYABLE_STATUSES.has(response.status) && attempt < OPENROUTER_MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000;
            this.log.warn({ attempt: attempt + 1, status: response.status, delay }, 'OpenRouter: retryable error, retrying');
            await retrySleep(delay);
            continue;
          }

          this.log.error(
            { status: response.status, error: errorText },
            'OpenRouter API error',
          );

          if (this.debugLog) {
            this.writeDebugLog({
              callType,
              systemContent,
              messages,
              responseFormat,
              responseJson: null,
              responseContent: null,
              durationMs: Date.now() - startTime,
              error: lastError,
            });
          }

          return err({
            type: 'query' as const,
            message: `OpenRouter API error (${response.status})`,
          });
        }

        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const content = data.choices?.[0]?.message?.content;
        const isEmpty = typeof content !== 'string';

        if (isEmpty && attempt < OPENROUTER_MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          this.log.warn({ attempt: attempt + 1, delay }, 'OpenRouter: empty response, retrying');
          await retrySleep(delay);
          continue;
        }

        if (this.debugLog) {
          this.writeDebugLog({
            callType,
            systemContent,
            messages,
            responseFormat,
            responseJson: data,
            responseContent: typeof content === 'string' ? content : null,
            durationMs: Date.now() - startTime,
            error: null,
          });
        }

        if (typeof content !== 'string') {
          return err({
            type: 'query' as const,
            message: 'OpenRouter API returned no content in response',
          });
        }

        return ok(content);
      } catch (error) {
        lastError = String(error);

        if (attempt < OPENROUTER_MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          this.log.warn({ attempt: attempt + 1, error: lastError, delay }, 'OpenRouter: network error, retrying');
          await retrySleep(delay);
          continue;
        }

        this.log.error({ error }, 'OpenRouter API call failed');

        if (this.debugLog) {
          this.writeDebugLog({
            callType,
            systemContent,
            messages,
            responseFormat,
            responseJson: null,
            responseContent: null,
            durationMs: Date.now() - startTime,
            error: lastError,
          });
        }

        return err({
          type: 'query' as const,
          message: 'OpenRouter API call failed',
        });
      }
    }

    // Should not reach here, but safety fallback
    return err({
      type: 'query' as const,
      message: `OpenRouter API failed after ${OPENROUTER_MAX_RETRIES} retries: ${lastError}`,
    });
  }
}

// ============================================================
// Module-level helpers
// ============================================================

/**
 * L2 normalize a vector (divide each element by the L2 norm).
 * Returns the original vector if norm is 0 (avoids division by zero).
 */
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vec.map(v => v / norm) : vec;
}

/**
 * Safely parse a JSON string, returning undefined on failure.
 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse role prefix from chunk content.
 * Chunks are stored as "user: content" or "assistant: content".
 * Falls back to "user" role if no prefix found.
 */
function parseChunkRole(content: string): { role: string; content: string } {
  if (content.startsWith('user: ')) {
    return { role: 'user', content: content.slice(6) };
  }
  if (content.startsWith('assistant: ')) {
    return { role: 'assistant', content: content.slice(11) };
  }
  // Fallback: treat as user message
  return { role: 'user', content };
}
