// src/services/chat-manager.ts
// ChatManager: manages per-user OpenRouterChat instances with PostgreSQL-backed memory.

import { OpenRouterChat } from '../openrouter-chat.js';
import { PostgresMemStore } from './postgres-mem-store.js';
import { ok } from '../shared/result.js';
import type { LLMem, StoreResult, MemoryError } from '../openrouter-chat.js';
import type { Result } from '../shared/result.js';
import type { RecallMemoryResult } from '../openrouter-chat.js';

// ── Minimal LLMem implementation ──────────────────────────────────────────────

/**
 * MinimalLLMem: a no-op memory backend that satisfies the LLMem interface.
 *
 * store() — returns success without persisting (MemManager in OpenRouterChat
 *           handles actual chunk storage via the IMemStore).
 * recall() — returns empty results (no vector search — topic-based context
 *            from MemManager is sufficient for this use case).
 */
class MinimalLLMem implements LLMem {
  readonly contextId: string;

  constructor(contextId: string) {
    this.contextId = contextId;
  }

  async store(_text: string, _metadata?: { sessionId?: string }): Promise<Result<StoreResult, MemoryError>> {
    return ok({ stored: true as const });
  }

  async recall(_query: string): Promise<Result<RecallMemoryResult, MemoryError>> {
    return ok({
      recall: {
        nodes: [],
        edges: [],
      },
    });
  }
}

// ── ChatManager ────────────────────────────────────────────────────────────────

/**
 * Manages one OpenRouterChat instance per conversation context.
 * Each instance has its own PostgreSQL-backed MemStore keyed by contextId.
 *
 * Use ChatManager.getContextId() to compute a contextId from Telegram parameters.
 */
export class ChatManager {
  private readonly chats = new Map<string, OpenRouterChat>();
  private readonly memStores = new Map<string, PostgresMemStore>();
  private readonly postgresUrl: string;
  private readonly openRouterApiKey: string;
  private readonly systemPrompt: string;
  private readonly model: string;

  constructor(options: {
    postgresUrl: string;
    openRouterApiKey: string;
    systemPrompt?: string;
    model?: string;
  }) {
    this.postgresUrl = options.postgresUrl;
    this.openRouterApiKey = options.openRouterApiKey;
    this.systemPrompt = options.systemPrompt ?? '';
    this.model = options.model ?? 'google/gemini-2.5-flash';
  }

  /**
   * Compute a contextId from Telegram chat parameters.
   *
   * - Private chat or regular group: `tg_{chatId}`
   * - Supergroup with topic (threadId): `tg_{chatId}_{threadId}`
   * - Supergroup without topic: `tg_{chatId}`
   */
  static getContextId(chatId: number, chatType: string, threadId?: number): string {
    if (chatType === 'supergroup' && threadId !== undefined) {
      return `tg_${chatId}_${threadId}`;
    }
    return `tg_${chatId}`;
  }

  /**
   * Get or create an OpenRouterChat for the given contextId.
   *
   * contextId is the unique key for the conversation context
   * (use ChatManager.getContextId() to compute it from Telegram parameters).
   */
  async getChat(contextId: string): Promise<OpenRouterChat> {
    const cached = this.chats.get(contextId);
    if (cached !== undefined) {
      return cached;
    }

    const memStore = new PostgresMemStore(this.postgresUrl);
    this.memStores.set(contextId, memStore);

    const llmem = new MinimalLLMem(contextId);

    const chat = new OpenRouterChat({
      apiKey: this.openRouterApiKey,
      systemPrompt: this.systemPrompt,
      llmem,
      memStore,
      model: this.model,
      getBehaviorInstructions: async () => {
        return memStore.getBehaviorInstructions(contextId);
      },
    });

    this.chats.set(contextId, chat);
    return chat;
  }

  /**
   * Get behavior instructions for a given context.
   * Delegates to the PostgresMemStore associated with the contextId.
   */
  async getBehaviorInstructions(contextId: string): Promise<string> {
    const store = this.memStores.get(contextId);
    if (!store) {
      return '';
    }
    return store.getBehaviorInstructions(contextId);
  }

  /**
   * Set behavior instructions for a given context.
   * Delegates to the PostgresMemStore associated with the contextId.
   */
  async setBehaviorInstructions(instructions: string, contextId: string): Promise<void> {
    const store = this.memStores.get(contextId);
    if (!store) {
      return;
    }
    await store.setBehaviorInstructions(instructions, contextId);
  }

  /**
   * Close all PostgreSQL connection pools. Call on application shutdown.
   */
  async shutdown(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const store of this.memStores.values()) {
      closePromises.push(store.close());
    }
    await Promise.all(closePromises);
    this.chats.clear();
    this.memStores.clear();
  }
}
