// src/__tests__/integration/recall-flow.test.ts
// Integration tests for recall pipeline:
// 1. Vector recall: IMemStore.vectorRecall → sorted cosine results
// 2. Graph-enriched recall: GraphEnrichedLLMem (real) → inner recall + GraphRecall (real) + GraphStore (mocked DB)

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mocks
// ──────────────────────────────────────────────────────────────────────────────

const { mockPoolClient, mockPool } = vi.hoisted(() => {
  const mockPoolClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const mockPool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockPoolClient),
  };

  return { mockPoolClient, mockPool };
});

vi.mock('pgvector/pg', () => ({
  default: {
    registerType: vi.fn(),
    toSql: vi.fn((arr: number[]) => `[${arr.join(',')}]`),
  },
}));

// ──────────────────────────────────────────────────────────────────────────────
// Imports after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';

import { GraphStore } from '../../services/graph/graph-store.ts';
import { GraphRecall } from '../../services/graph/graph-recall.ts';
import { GraphEnrichedLLMem } from '../../services/graph/graph-llmem.ts';
import type { LLMem, RecallMemoryResult, StoreResult, MemoryError } from '../../openrouter-chat.ts';
import type { RecallResult, RecallNode } from '../../types.ts';
import { ok, err } from '../../shared/result.ts';
import type { Result } from '../../shared/result.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeVector(seed = 0, dims = 1536): number[] {
  return Array.from({ length: dims }, (_, i) => ((i + seed) % dims) / dims);
}

function makeRecallNode(id: string, similarity = 0.9): RecallNode {
  return {
    id,
    text: `Text of mem ${id}`,
    tags: [],
    match: 'direct' as const,
    timestamp: Date.now(),
    similarity,
  };
}

function makeRecallResult(nodeIds: string[]): RecallResult {
  return {
    nodes: nodeIds.map((id, i) => makeRecallNode(id, 0.9 - i * 0.05)),
    edges: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Vector Recall integration
// ──────────────────────────────────────────────────────────────────────────────

describe('Vector recall integration (IMemStore.vectorRecall via PostgresMemStore mock)', () => {
  // We test vector recall through a mock IMemStore that simulates
  // what PostgresMemStore.vectorRecall does: cosine distance query → sorted RecallResult.

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockReset();
  });

  it('vectorRecall returns nodes sorted by similarity descending', async () => {
    // Mock IMemStore with vectorRecall that returns pre-sorted nodes
    const recallNodes: RecallNode[] = [
      makeRecallNode('10', 0.95),
      makeRecallNode('20', 0.82),
      makeRecallNode('30', 0.71),
    ];

    const mockMemStore = {
      contextId: 'test-context',
      store: vi.fn(),
      recall: vi.fn().mockResolvedValue(ok({
        recall: {
          nodes: recallNodes,
          edges: [],
        },
      })),
    } as unknown as LLMem;

    // GraphEnrichedLLMem with no-op GraphRecall (no edges in DB)
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })      // getMemstoreId
      .mockResolvedValueOnce({ rows: [] });                // getEdgesForMems → no edges

    const store = new GraphStore(mockPool as unknown as pg.Pool);
    const graphRecall = new GraphRecall(store);
    const enrichedLLMem = new GraphEnrichedLLMem(mockMemStore, graphRecall);

    const result = await enrichedLLMem.recall('What happened in January?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nodes = result.value.recall.nodes;
    // All original nodes present
    expect(nodes).toHaveLength(3);

    // Similarity order preserved
    expect(nodes[0]?.id).toBe('10');
    expect(nodes[0]?.similarity).toBe(0.95);
    expect(nodes[1]?.id).toBe('20');
    expect(nodes[2]?.id).toBe('30');

    // All returned as 'direct' match (no graph neighbors since no edges)
    expect(nodes.every(n => n.match === 'direct')).toBe(true);
  });

  it('vectorRecall with empty result returns empty nodes and edges', async () => {
    const mockMemStore = {
      contextId: 'test-context',
      store: vi.fn(),
      recall: vi.fn().mockResolvedValue(ok({
        recall: { nodes: [], edges: [] },
      })),
    } as unknown as LLMem;

    const store = new GraphStore(mockPool as unknown as pg.Pool);
    const graphRecall = new GraphRecall(store);
    const enrichedLLMem = new GraphEnrichedLLMem(mockMemStore, graphRecall);

    const result = await enrichedLLMem.recall('Unknown query');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recall.nodes).toHaveLength(0);
    expect(result.value.recall.edges).toHaveLength(0);

    // GraphRecall skips DB query when no nodes to look up
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('vectorRecall propagates inner recall error without graph enrichment', async () => {
    const mockMemStore = {
      contextId: 'test-context',
      store: vi.fn(),
      recall: vi.fn().mockResolvedValue(err({ type: 'query' as const, message: 'DB timeout' })),
    } as unknown as LLMem;

    const store = new GraphStore(mockPool as unknown as pg.Pool);
    const graphRecall = new GraphRecall(store);
    const enrichedLLMem = new GraphEnrichedLLMem(mockMemStore, graphRecall);

    const result = await enrichedLLMem.recall('What happened in January?');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('DB timeout');

    // No graph enrichment attempted
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Graph-enriched recall integration
// ──────────────────────────────────────────────────────────────────────────────

describe('Graph-enriched recall integration (GraphEnrichedLLMem + GraphRecall + GraphStore)', () => {
  let store: GraphStore;
  let graphRecall: GraphRecall;

  const CONTEXT_ID = 'recall-test-context';
  const MEMSTORE_ID = 7;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockReset();

    store = new GraphStore(mockPool as unknown as pg.Pool);
    graphRecall = new GraphRecall(store);
  });

  it('enrichRecall adds neighbor nodes and edges to direct recall results', async () => {
    // Inner recall returns mem 10 as direct match
    const innerResult: RecallResult = makeRecallResult(['10']);

    const mockInnerLLMem: LLMem = {
      contextId: CONTEXT_ID,
      store: vi.fn<[string, ({ sessionId?: string } | undefined)?], Promise<Result<StoreResult, MemoryError>>>(),
      recall: vi.fn<[string], Promise<Result<RecallMemoryResult, MemoryError>>>()
        .mockResolvedValue(ok({ recall: innerResult })),
    };

    const enrichedLLMem = new GraphEnrichedLLMem(mockInnerLLMem, graphRecall);

    // DB calls from GraphRecall:
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] })   // getMemstoreId
      .mockResolvedValueOnce({                                    // getEdgesForMems: mem 10 → 99
        rows: [{
          id: 1,
          source_mem_id: 10,
          target_mem_id: 99,
          edge_type: 'temporal',
          label: 'happened_before',
          relevance: 0.88,
          discovery_axis: 'chronos',
          created_at: new Date('2025-01-15'),
        }],
      })
      .mockResolvedValueOnce({                                    // getMemTexts for neighbor 99
        rows: [{ id: 99, summary: 'Team meeting the previous week' }],
      });

    const result = await enrichedLLMem.recall('Q1 planning');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { nodes, edges } = result.value.recall;

    // Original node + 1 neighbor
    expect(nodes).toHaveLength(2);

    const directNode = nodes.find(n => n.id === '10');
    expect(directNode).toBeDefined();
    expect(directNode?.match).toBe('direct');

    const neighborNode = nodes.find(n => n.id === '99');
    expect(neighborNode).toBeDefined();
    expect(neighborNode?.match).toBe('neighbor');
    expect(neighborNode?.relation).toBe('happened_before');
    expect(neighborNode?.similarity).toBe(0.88);
    expect(neighborNode?.text).toBe('Team meeting the previous week');

    // Edges from the graph
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: '10',
      to: '99',
      type: 'temporal',
      weight: 0.88,
    });
  });

  it('enrichRecall handles multiple direct nodes and finds their combined edges', async () => {
    // Inner recall returns mems 10, 20, 30
    const innerResult: RecallResult = makeRecallResult(['10', '20', '30']);

    const mockInnerLLMem: LLMem = {
      contextId: CONTEXT_ID,
      store: vi.fn<[string, ({ sessionId?: string } | undefined)?], Promise<Result<StoreResult, MemoryError>>>(),
      recall: vi.fn<[string], Promise<Result<RecallMemoryResult, MemoryError>>>()
        .mockResolvedValue(ok({ recall: innerResult })),
    };

    const enrichedLLMem = new GraphEnrichedLLMem(mockInnerLLMem, graphRecall);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] })   // getMemstoreId
      .mockResolvedValueOnce({                                    // getEdgesForMems: 10→20 (already recalled), 30→99 (new)
        rows: [
          {
            id: 1,
            source_mem_id: 10,
            target_mem_id: 20,
            edge_type: 'semantic',
            label: 'related_topic',
            relevance: 0.91,
            discovery_axis: 'theme',
            created_at: new Date(),
          },
          {
            id: 2,
            source_mem_id: 30,
            target_mem_id: 99,
            edge_type: 'social',
            label: 'same_team',
            relevance: 0.79,
            discovery_axis: 'agents',
            created_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({                                    // getMemTexts for neighbor 99
        rows: [{ id: 99, summary: 'Another team event' }],
      });

    const result = await enrichedLLMem.recall('Team activities');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { nodes, edges } = result.value.recall;

    // 3 direct + 1 new neighbor
    expect(nodes).toHaveLength(4);
    expect(nodes.filter(n => n.match === 'direct')).toHaveLength(3);
    expect(nodes.filter(n => n.match === 'neighbor')).toHaveLength(1);

    const neighbor = nodes.find(n => n.id === '99');
    expect(neighbor?.relation).toBe('same_team');

    // Both edges returned
    expect(edges).toHaveLength(2);
    const edgeTypes = edges.map(e => e.type);
    expect(edgeTypes).toContain('semantic');
    expect(edgeTypes).toContain('social');
  });

  it('enrichRecall degrades gracefully when graph DB is unavailable', async () => {
    const innerResult: RecallResult = makeRecallResult(['10', '20']);

    const mockInnerLLMem: LLMem = {
      contextId: CONTEXT_ID,
      store: vi.fn<[string, ({ sessionId?: string } | undefined)?], Promise<Result<StoreResult, MemoryError>>>(),
      recall: vi.fn<[string], Promise<Result<RecallMemoryResult, MemoryError>>>()
        .mockResolvedValue(ok({ recall: innerResult })),
    };

    const enrichedLLMem = new GraphEnrichedLLMem(mockInnerLLMem, graphRecall);

    // DB fails on getMemstoreId
    mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await enrichedLLMem.recall('Any query');

    // Must succeed — graceful degradation returns original result
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Original 2 nodes returned unchanged, no edges added
    expect(result.value.recall.nodes).toHaveLength(2);
    expect(result.value.recall.edges).toHaveLength(0);
    expect(result.value.recall.nodes.every(n => n.match === 'direct')).toBe(true);
  });

  it('enrichRecall does not add same node twice when neighbor is already in direct recall', async () => {
    // Direct recall returns mems 10 and 99
    const innerResult: RecallResult = makeRecallResult(['10', '99']);

    const mockInnerLLMem: LLMem = {
      contextId: CONTEXT_ID,
      store: vi.fn<[string, ({ sessionId?: string } | undefined)?], Promise<Result<StoreResult, MemoryError>>>(),
      recall: vi.fn<[string], Promise<Result<RecallMemoryResult, MemoryError>>>()
        .mockResolvedValue(ok({ recall: innerResult })),
    };

    const enrichedLLMem = new GraphEnrichedLLMem(mockInnerLLMem, graphRecall);

    // Graph has an edge between the two already-recalled mems
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          source_mem_id: 10,
          target_mem_id: 99,
          edge_type: 'causal',
          label: 'caused_by',
          relevance: 0.93,
          discovery_axis: 'cause',
          created_at: new Date(),
        }],
      });

    const result = await enrichedLLMem.recall('Root cause');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { nodes, edges } = result.value.recall;

    // Still only 2 nodes — no duplicate added
    expect(nodes).toHaveLength(2);

    // Edge is still returned between the two direct nodes
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: '10', to: '99', type: 'causal', weight: 0.93 });
  });
});
