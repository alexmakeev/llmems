// src/memory/utils/temporal.ts
// Utility helpers for temporal reasoning over KnowledgeNode fields.

import type { KnowledgeNode } from '../types.ts';

/**
 * Return the most semantically meaningful date for a KnowledgeNode.
 *
 * Priority:
 *   1. tValid   — the date when the fact was actually true (event date)
 *   2. tMentioned — the session timestamp when this fact was mentioned
 *   3. undefined — no temporal anchor available
 *
 * Use this function whenever you need a single representative date for
 * temporal proximity scoring, avoiding the ingestion timestamp (KnowledgeNode.timestamp)
 * which reflects when the node was written to the database, not when the event occurred.
 */
export function getEffectiveDate(node: Pick<KnowledgeNode, 'tValid' | 'tMentioned'>): string | undefined {
  return node.tValid ?? node.tMentioned;
}
