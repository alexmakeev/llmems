// src/__tests__/integration/ingest-flow.test.ts
// Integration tests for the full ingest pipeline:
// GraphBuilder (real) → ProjectionExtractor (real) → GraphEmbeddingService (real) → GraphStore (real)
// All external I/O (DB pool, OpenAI API) is mocked.

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mocks — must be defined before vi.mock() calls
// ──────────────────────────────────────────────────────────────────────────────

const { mockChatCreate, mockEmbeddingsCreate, mockPoolClient, mockPool } = vi.hoisted(() => {
  const mockChatCreate = vi.fn();
  const mockEmbeddingsCreate = vi.fn();

  const mockPoolClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const mockPool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockPoolClient),
  };

  return { mockChatCreate, mockEmbeddingsCreate, mockPoolClient, mockPool };
});

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockChatCreate } };
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: OpenAI };
});

vi.mock('pgvector/pg', () => ({
  default: {
    registerType: vi.fn(),
    toSql: vi.fn((arr: number[]) => `[${arr.join(',')}]`),
  },
}));

vi.mock('../../retry-sleep.ts', () => ({
  retrySleep: vi.fn().mockResolvedValue(undefined),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Imports after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';

import { GraphBuilder } from '../../services/graph/graph-builder.ts';
import { GraphStore } from '../../services/graph/graph-store.ts';
import { ProjectionExtractor } from '../../services/graph/projection-extractor.ts';
import { GraphEmbeddingService } from '../../services/graph/embedding-service.ts';
import type { GraphConfig } from '../../services/graph/types.ts';
import { ok } from '../../shared/result.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Test config
// ──────────────────────────────────────────────────────────────────────────────

const GRAPH_CONFIG: GraphConfig = {
  similarityThreshold: 0.7,
  topKPerAxis: 5,
  maxEdgesFromGemini: 20,
  openaiApiKey: 'test-openai-key',
  openaiModel: 'text-embedding-3-small',
  geminiModel: 'google/gemini-2.5-flash',
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeVector(dims = 1536): number[] {
  return Array.from({ length: dims }, (_, i) => i / dims);
}

function makeProjectionJson(overrides: Partial<Record<string, string>> = {}): string {
  return JSON.stringify({
    chronos: 'In January 2025',
    topos: 'At the office in Moscow',
    agents: 'Alex and the team',
    theme: 'Q1 planning session',
    cause: 'Upcoming product deadline',
    emotion: 'Focused and motivated',
    certainty: 'First-hand participant',
    ...overrides,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Integration: Full ingest pipeline
// ──────────────────────────────────────────────────────────────────────────────

describe('Ingest pipeline integration (GraphBuilder → ProjectionExtractor → GraphEmbeddingService → GraphStore)', () => {
  let store: GraphStore;
  let extractor: ProjectionExtractor;
  let embedder: GraphEmbeddingService;
  let builder: GraphBuilder;

  const MEM_ID = 55;
  const CONTEXT_ID = 'test-context-ingest';
  const MEMSTORE_ID = 3;
  const MEM_TEXT = 'We had a team meeting in January to discuss Q1 planning. Alex led the session.';

  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolClient.query.mockReset();
    mockPoolClient.release.mockReset();
    mockPool.query.mockReset();
    mockPool.connect.mockResolvedValue(mockPoolClient);

    // PROMPT must be set so ProjectionExtractor can load the prompt file
    savedEnv = { ...process.env };
    process.env['PROMPT'] = 'baseline';

    // Assemble the real dependency graph — same wiring as production
    store = new GraphStore(mockPool as unknown as pg.Pool);
    extractor = new ProjectionExtractor(GRAPH_CONFIG);
    embedder = new GraphEmbeddingService(GRAPH_CONFIG);
    builder = new GraphBuilder(store, extractor, embedder, GRAPH_CONFIG);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('full success: projections extracted → embedded → saved → neighbors searched → edges proposed and saved', async () => {
    // DB: getMemstoreId
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] });

    // Gemini (ProjectionExtractor): returns 7-axis projections
    mockChatCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: makeProjectionJson() } }],
      });

    // OpenAI embeddings: 7 projection texts → 7 vectors
    const projectionVectors = Array.from({ length: 7 }, (_, i) => makeVector().map(v => v + i * 0.01));
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: projectionVectors.map((vec, i) => ({ index: i, embedding: vec })),
    });

    // DB: saveProjections (BEGIN, 7x INSERT, COMMIT)
    mockPoolClient.query.mockResolvedValue({ rows: [] });

    // DB: findSimilarByAxis × 7 — first axis returns one candidate, rest empty
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mem_id: 100, text: 'January planning session', similarity: 0.88 }] }) // chronos
      .mockResolvedValue({ rows: [] }); // topos, agents, theme, cause, emotion, certainty

    // DB: getMemTexts for candidate mem 100
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100, summary: 'Previous team meeting in January' }] });

    // Gemini (GraphBuilder): edge proposals
    mockChatCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify([
            {
              source_id: `mem-${MEM_ID}`,
              target_id: 'mem-100',
              edge_type: 'temporal',
              label: 'same_period_meetings',
              relevance: 0.87,
            },
          ]),
        },
      }],
    });

    // DB: saveEdges (BEGIN, INSERT, COMMIT)
    mockPoolClient.query.mockResolvedValue({ rows: [] });

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    // Pipeline succeeds and returns the created edge
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);

    const edge = result.value[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;

    expect(edge.sourceMemId).toBe(String(MEM_ID));
    expect(edge.targetMemId).toBe('100');
    expect(edge.edgeType).toBe('temporal');
    expect(edge.label).toBe('same_period_meetings');
    expect(edge.relevance).toBe(0.87);

    // Verify all stages of the pipeline were called in sequence
    // Stage 1: ProjectionExtractor called Gemini with mem text
    expect(mockChatCreate).toHaveBeenCalledTimes(2); // once for projections, once for edge proposals
    const firstGeminiCall = mockChatCreate.mock.calls[0];
    expect(firstGeminiCall).toBeDefined();
    const firstMessages = (firstGeminiCall as unknown[][])[0] as { messages: Array<{ content: string }> };
    const userMessage = firstMessages.messages.find((m: { content: string }) => m.content.includes(MEM_TEXT));
    expect(userMessage).toBeDefined();

    // Stage 2: EmbeddingService was called for projection texts (7 texts)
    expect(mockEmbeddingsCreate).toHaveBeenCalledOnce();
    const embeddingCall = mockEmbeddingsCreate.mock.calls[0]?.[0] as { input: string[] };
    expect(embeddingCall.input).toHaveLength(7);

    // Stage 3: GraphStore saved projections (BEGIN + 7 INSERTs + COMMIT = 9 client queries)
    const clientCalls = mockPoolClient.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('COMMIT');
    const insertProjectionCalls = clientCalls.filter(q => q.includes('INSERT INTO mem_projections'));
    expect(insertProjectionCalls).toHaveLength(7);

    // Stage 4: Edges were saved to mem_edges
    const insertEdgeCalls = clientCalls.filter(q => q.includes('INSERT INTO mem_edges'));
    expect(insertEdgeCalls).toHaveLength(1);
  });

  it('pipeline stops early and returns empty edges when no projections are extracted', async () => {
    // DB: getMemstoreId
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] });

    // Gemini returns all empty axes
    mockChatCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            chronos: '',
            topos: '',
            agents: '',
            theme: '',
            cause: '',
            emotion: '',
            certainty: '',
          }),
        },
      }],
    });

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);

    // EmbeddingService must not be called — no projections to embed
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    // No DB writes at all (saveProjections, saveEdges)
    expect(mockPoolClient.query).not.toHaveBeenCalled();
  });

  it('pipeline propagates extraction error as err result', async () => {
    // DB: getMemstoreId
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] });

    // Gemini returns malformed JSON
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'not valid json' } }],
    });

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/JSON parse failed/i);

    // Nothing stored to DB
    expect(mockPoolClient.query).not.toHaveBeenCalled();
  });

  it('pipeline propagates embedding error as err result', async () => {
    // DB: getMemstoreId
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] });

    // Gemini returns valid projections
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionJson() } }],
    });

    // Embedding service fails on all 4 attempts (attempt 0..3)
    mockEmbeddingsCreate.mockRejectedValue(new Error('OpenAI service unavailable'));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Embedding failed after/i);

    // No projections saved to DB since embedding failed
    const clientCalls = mockPoolClient.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(clientCalls.some(q => q.includes('INSERT INTO mem_projections'))).toBe(false);
  });

  it('multi-axis candidate discovery: candidates from multiple axes feed Gemini prompt', async () => {
    // DB: getMemstoreId
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: MEMSTORE_ID }] });

    // Gemini returns projections for all 7 axes
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionJson() } }],
    });

    // Embeddings for 7 projections
    const vecs = Array.from({ length: 7 }, (_, i) => makeVector().map(v => v + i * 0.01));
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: vecs.map((vec, i) => ({ index: i, embedding: vec })),
    });

    // DB: saveProjections
    mockPoolClient.query.mockResolvedValue({ rows: [] });

    // Two axes find candidates: chronos finds mem-100, agents finds mem-200
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mem_id: 100, text: 'January', similarity: 0.88 }] })  // chronos
      .mockResolvedValueOnce({ rows: [] })                                                      // topos
      .mockResolvedValueOnce({ rows: [{ mem_id: 200, text: 'Alex', similarity: 0.82 }] })      // agents
      .mockResolvedValue({ rows: [] });                                                          // theme, cause, emotion, certainty

    // DB: getMemTexts for candidates 100, 200
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 100, summary: 'Meeting in January' },
        { id: 200, summary: 'Alex led the discussion' },
      ],
    });

    // Gemini edge proposals: two edges
    mockChatCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify([
            {
              source_id: `mem-${MEM_ID}`,
              target_id: 'mem-100',
              edge_type: 'temporal',
              label: 'same_time',
              relevance: 0.88,
            },
            {
              source_id: `mem-${MEM_ID}`,
              target_id: 'mem-200',
              edge_type: 'social',
              label: 'same_person',
              relevance: 0.82,
            },
          ]),
        },
      }],
    });

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both edges are created
    expect(result.value).toHaveLength(2);
    const targetIds = result.value.map(e => e.targetMemId);
    expect(targetIds).toContain('100');
    expect(targetIds).toContain('200');

    // discoveryAxis is assigned per candidate
    const edge100 = result.value.find(e => e.targetMemId === '100');
    const edge200 = result.value.find(e => e.targetMemId === '200');
    expect(edge100?.discoveryAxis).toBe('chronos');
    expect(edge200?.discoveryAxis).toBe('agents');
  });
});
