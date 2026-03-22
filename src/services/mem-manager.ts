// src/services/mem-manager.ts
// Mem Manager: manages conversation mem lifecycle — active chunks,
// closed mem summaries, and general summary for long-term context.

import { randomUUID } from 'node:crypto';
import type { MemChunk, Mem, MemContextData, IMemStore, VocabularyTerm } from '../types.js';

/** Generate a chunk ID — used when no external ID is provided */
const generateChunkId = (): string => randomUUID();

// ──────────────────────────── InMemoryMemStore ─────────────────────────────

/**
 * Simple in-memory implementation of IMemStore.
 * Stores active chunks, closed mems, and a general summary.
 * contextId is accepted but ignored (single-context in-memory store).
 */
export class InMemoryMemStore implements IMemStore {
  private activeChunks: MemChunk[] = [];
  private closedMems: Mem[] = [];
  private generalSummary: string = '';
  private behaviorInstructions: string = '';
  private vocabularyIndex = new Map<string, { term: string; count: number; memIds: Set<string> }>();

  async getActiveChunks(_contextId: string): Promise<MemChunk[]> {
    return this.activeChunks;
  }

  async getClosedMems(_contextId: string, limit?: number): Promise<Mem[]> {
    if (limit === undefined || limit >= this.closedMems.length) {
      return this.closedMems;
    }
    return this.closedMems.slice(-limit);
  }

  async getGeneralSummary(_contextId: string): Promise<string> {
    return this.generalSummary;
  }

  async addChunk(content: string, timestamp: Date, _contextId: string): Promise<MemChunk> {
    const id = generateChunkId();
    const chunk: MemChunk = { id, content, timestamp };
    this.activeChunks.push(chunk);
    return chunk;
  }

  async updateGeneralSummary(summary: string, _contextId: string): Promise<void> {
    this.generalSummary = summary;
  }

  async getBehaviorInstructions(_contextId: string): Promise<string> {
    return this.behaviorInstructions;
  }

  async setBehaviorInstructions(instructions: string, _contextId: string): Promise<void> {
    this.behaviorInstructions = instructions;
  }

  /**
   * Remove the oldest closed mem (first element).
   * Used when merging old mems into the general summary.
   */
  async removeOldestClosedMem(_contextId: string): Promise<void> {
    this.closedMems.shift();
  }

  async getLastClosedMem(_contextId: string): Promise<Mem | null> {
    if (this.closedMems.length === 0) return null;
    return this.closedMems[this.closedMems.length - 1] ?? null;
  }

  async buildMemContext(_contextId: string): Promise<MemContextData> {
    const allClosed = this.closedMems;
    let recentClosedMems: Mem[];
    let lastClosedMem: Mem | null;

    if (allClosed.length === 0) {
      recentClosedMems = [];
      lastClosedMem = null;
    } else {
      lastClosedMem = allClosed[allClosed.length - 1] ?? null;
      recentClosedMems = allClosed.slice(0, -1);
    }

    return {
      generalSummary: this.generalSummary,
      recentClosedMems,
      lastClosedMem,
      activeChunks: this.activeChunks,
    };
  }

  /**
   * Apply background summarization result: close mems, trim active chunks, update summary.
   *
   * For each mem → create Mem (generate id, set closedAt=now), add to closedMems.
   * summarizedIds = all chunkIds from mems (no exceptions — tailChunkIds are informational only).
   * activeChunks = activeChunks.filter(c => !summarizedIds.has(c.id)).
   * If newGeneralSummary !== null → update generalSummary.
   */
  async applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] }; vocabulary?: { term: string; count: number }[] }[],
    _tailChunkIds: string[],
    newGeneralSummary: string | null,
    _contextId: string,
  ): Promise<void> {
    // Order: summary → mems → remove chunks.
    // If a concurrent buildContext() reads mid-apply, it sees the new summary
    // alongside not-yet-removed old chunks — safe duplication, never data loss.

    // 1. Update general summary FIRST
    if (newGeneralSummary !== null) {
      this.generalSummary = newGeneralSummary;
    }

    // 2. Add closed mems
    const summarizedIds = new Set<string>();
    for (const mem of mems) {
      const memId = randomUUID();
      const memState: Mem = {
        id: memId,
        summary: mem.summary,
        chunkIds: mem.chunkIds,
        embeddings: mem.embeddings,
        closedAt: new Date(),
      };
      this.closedMems.push(memState);

      for (const chunkId of mem.chunkIds) {
        summarizedIds.add(chunkId);
      }

      // 2a. Update vocabulary index
      if (mem.vocabulary) {
        for (const v of mem.vocabulary) {
          const lower = v.term.toLowerCase();
          const existing = this.vocabularyIndex.get(lower);
          if (existing) {
            existing.count += v.count;
            existing.memIds.add(memId);
          } else {
            this.vocabularyIndex.set(lower, { term: v.term, count: v.count, memIds: new Set([memId]) });
          }
        }
      }
    }

    // 3. Remove summarized chunks from active list LAST (tailChunkIds do not prevent removal)
    this.activeChunks = this.activeChunks.filter(c => !summarizedIds.has(c.id));
  }

  async getEstablishedVocabulary(_contextId: string, minCount: number = 3): Promise<VocabularyTerm[]> {
    return Array.from(this.vocabularyIndex.values())
      .filter(v => v.count >= minCount)
      .map(v => ({ term: v.term, count: v.count }))
      .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  }

  async getVocabulary(_contextId: string): Promise<VocabularyTerm[]> {
    return Array.from(this.vocabularyIndex.values())
      .map(v => ({ term: v.term, count: v.count }))
      .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  }
}

// ──────────────────────────── MemManager ───────────────────────────────────

/**
 * High-level state machine for mem lifecycle management.
 * Coordinates mem creation, closing, and context data assembly.
 */
export class MemManager {
  private store: IMemStore;

  constructor(store: IMemStore) {
    this.store = store;
  }

  async addChunk(content: string, timestamp: Date, contextId: string): Promise<MemChunk> {
    return this.store.addChunk(content, timestamp, contextId);
  }

  async applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] }; vocabulary?: { term: string; count: number }[] }[],
    tailChunkIds: string[],
    newGeneralSummary: string | null,
    contextId: string,
  ): Promise<void> {
    await this.store.applyBackgroundResult(mems, tailChunkIds, newGeneralSummary, contextId);
  }

  /**
   * Returns structured context data for building LLM prompts.
   * Splits closed mems into:
   * - recentClosedMems: all except the last one (middle context)
   * - lastClosedMem: the most recent closed mem (immediate context)
   */
  async getContextData(contextId: string): Promise<MemContextData> {
    return this.store.buildMemContext(contextId);
  }

  async getAllClosedMems(contextId: string): Promise<Mem[]> {
    return this.store.getClosedMems(contextId);
  }

  async getClosedMemCount(contextId: string): Promise<number> {
    const mems = await this.store.getClosedMems(contextId);
    return mems.length;
  }

  async removeOldestClosedMem(contextId: string): Promise<void> {
    await this.store.removeOldestClosedMem(contextId);
  }

  async getLastClosedMem(contextId: string): Promise<Mem | null> {
    return this.store.getLastClosedMem(contextId);
  }

  async updateGeneralSummary(summary: string, contextId: string): Promise<void> {
    await this.store.updateGeneralSummary(summary, contextId);
  }

  async getActiveChunks(contextId: string): Promise<MemChunk[]> {
    return this.store.getActiveChunks(contextId);
  }

  async getEstablishedVocabulary(contextId: string, minCount?: number): Promise<VocabularyTerm[]> {
    if (this.store.getEstablishedVocabulary) {
      return this.store.getEstablishedVocabulary(contextId, minCount);
    }
    return [];
  }

  async getVocabulary(contextId: string): Promise<VocabularyTerm[]> {
    if (this.store.getVocabulary) {
      return this.store.getVocabulary(contextId);
    }
    return [];
  }
}
