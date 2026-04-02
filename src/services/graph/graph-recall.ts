// src/services/graph/graph-recall.ts
// Service that enriches recall results with graph edges and neighbor nodes.

import { ok } from '../../shared/result.js';
import type { Result } from '../../shared/result.js';
import { createMemoryLogger } from '../../logging.js';
import type { MemoryLogger } from '../../logging.js';
import type { RecallResult, RecallNode, RecallEdge } from '../../types.js';
import { GraphStore } from './graph-store.js';

const MAX_GRAPH_NEIGHBORS = 10;

export class GraphRecall {
  private readonly logger: MemoryLogger;

  constructor(
    private readonly store: GraphStore,
  ) {
    this.logger = createMemoryLogger({ name: 'graph-recall' });
  }

  /**
   * Enrich recall results with graph edges.
   *
   * 1. Extract mem IDs from recalled nodes
   * 2. Query graph for edges connecting those mems
   * 3. Find 1-hop neighbor mems not already in recall
   * 4. Fetch neighbor texts
   * 5. Create RecallNode entries for neighbors (match: 'neighbor', relation: edge label)
   * 6. Return enriched RecallResult
   */
  async enrichRecall(
    recallResult: RecallResult,
    contextId: string,
  ): Promise<Result<RecallResult, Error>> {
    // Step 1: Extract numeric mem IDs from recalled nodes
    const existingIds = new Set<string>(recallResult.nodes.map(n => n.id));
    const memIds: number[] = recallResult.nodes
      .map(n => Number(n.id))
      .filter(id => !isNaN(id));

    if (memIds.length === 0) {
      return ok(recallResult);
    }

    // Step 2: Resolve memstore ID
    const memstoreIdResult = await this.store.getMemstoreId(contextId);
    if (!memstoreIdResult.ok) {
      this.logger.warn(
        { err: memstoreIdResult.error.message, contextId },
        'GraphRecall: failed to resolve memstoreId, skipping graph enrichment',
      );
      return ok(recallResult);
    }
    const memstoreId = memstoreIdResult.value;

    // Step 3: Query graph for edges
    const edgesResult = await this.store.getEdgesForMems(memIds, memstoreId);
    if (!edgesResult.ok) {
      this.logger.warn(
        { err: edgesResult.error.message, contextId },
        'GraphRecall: failed to get edges, returning original result',
      );
      return ok(recallResult);
    }

    const graphEdges = edgesResult.value;
    if (graphEdges.length === 0) {
      return ok(recallResult);
    }

    // Step 4: Collect neighbor memIds not already in recall
    // Track best edge per neighbor (highest relevance)
    const neighborBestEdge = new Map<number, { relevance: number; label: string }>();

    for (const edge of graphEdges) {
      const sourceId = String(edge.sourceMemId);
      const targetId = String(edge.targetMemId);

      // Determine which end is the neighbor (the one NOT already in recall)
      const candidates: Array<{ id: string; relevance: number; label: string }> = [];

      if (!existingIds.has(sourceId)) {
        candidates.push({ id: sourceId, relevance: edge.relevance, label: edge.label });
      }
      if (!existingIds.has(targetId)) {
        candidates.push({ id: targetId, relevance: edge.relevance, label: edge.label });
      }

      for (const candidate of candidates) {
        const numId = Number(candidate.id);
        if (isNaN(numId)) continue;

        const existing = neighborBestEdge.get(numId);
        if (existing === undefined || candidate.relevance > existing.relevance) {
          neighborBestEdge.set(numId, { relevance: candidate.relevance, label: candidate.label });
        }
      }
    }

    if (neighborBestEdge.size === 0) {
      // All edges connect already-recalled mems; still add RecallEdges
      const recallEdges: RecallEdge[] = graphEdges.map(edge => ({
        from: edge.sourceMemId,
        to: edge.targetMemId,
        type: edge.edgeType,
        weight: edge.relevance,
      }));

      return ok({
        nodes: recallResult.nodes,
        edges: [...recallResult.edges, ...recallEdges],
      });
    }

    // Step 5: Sort neighbors by relevance desc, take top MAX_GRAPH_NEIGHBORS
    const sortedNeighbors = Array.from(neighborBestEdge.entries())
      .sort((a, b) => b[1].relevance - a[1].relevance)
      .slice(0, MAX_GRAPH_NEIGHBORS);

    const neighborIds = sortedNeighbors.map(([id]) => id);

    // Step 6: Fetch neighbor texts
    const textsResult = await this.store.getMemTexts(neighborIds);
    if (!textsResult.ok) {
      this.logger.warn(
        { err: textsResult.error.message, contextId },
        'GraphRecall: failed to fetch neighbor texts, returning original result with edges only',
      );

      const recallEdges: RecallEdge[] = graphEdges.map(edge => ({
        from: edge.sourceMemId,
        to: edge.targetMemId,
        type: edge.edgeType,
        weight: edge.relevance,
      }));

      return ok({
        nodes: recallResult.nodes,
        edges: [...recallResult.edges, ...recallEdges],
      });
    }

    const textMap = textsResult.value;

    // Step 7: Create RecallNode entries for neighbors
    const neighborNodes: RecallNode[] = [];
    for (const [numId, edgeInfo] of sortedNeighbors) {
      const text = textMap.get(numId);
      if (text === undefined) {
        this.logger.debug({ memId: numId }, 'GraphRecall: neighbor text not found, skipping');
        continue;
      }

      neighborNodes.push({
        id: String(numId),
        text,
        tags: [],
        match: 'neighbor' as const,
        relation: edgeInfo.label,
        similarity: edgeInfo.relevance,
        timestamp: Date.now(),
      });
    }

    // Step 8: Convert GraphEdge[] to RecallEdge[]
    const recallEdges: RecallEdge[] = graphEdges.map(edge => ({
      from: edge.sourceMemId,
      to: edge.targetMemId,
      type: edge.edgeType,
      weight: edge.relevance,
    }));

    return ok({
      nodes: [...recallResult.nodes, ...neighborNodes],
      edges: [...recallResult.edges, ...recallEdges],
    });
  }
}
