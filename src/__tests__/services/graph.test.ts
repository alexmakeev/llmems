// src/__tests__/services/graph.test.ts
// Tests for the graph module: ProjectionExtractor, GraphEmbeddingService, GraphStore,
// GraphBuilder, GraphRecall, GraphEnrichedLLMem.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mock objects — defined before vi.mock() hoisting
// ──────────────────────────────────────────────────────────────────────────────

const { mockChatCreate, mockEmbeddingsCreate, mockClient, mockPool } = vi.hoisted(() => {
  const mockChatCreate = vi.fn();
  const mockEmbeddingsCreate = vi.fn();

  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const mockPool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
  };

  return { mockChatCreate, mockEmbeddingsCreate, mockClient, mockPool };
});

// ──────────────────────────────────────────────────────────────────────────────
// Module mocks
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockChatCreate } };
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: OpenAI };
});

vi.mock('pgvector/pg', () => {
  return {
    default: {
      registerType: vi.fn(),
      toSql: vi.fn((arr: number[]) => `[${arr.join(',')}]`),
    },
  };
});

vi.mock('../../retry-sleep.ts', () => ({
  retrySleep: vi.fn().mockResolvedValue(undefined),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Imports after mocks
// ──────────────────────────────────────────────────────────────────────────────

import type pg from 'pg';
import { ProjectionExtractor } from '../../services/graph/projection-extractor.ts';
import { GraphEmbeddingService } from '../../services/graph/embedding-service.ts';
import { GraphStore } from '../../services/graph/graph-store.ts';
import { GraphBuilder } from '../../services/graph/graph-builder.ts';
import { GraphRecall } from '../../services/graph/graph-recall.ts';
import { GraphEnrichedLLMem } from '../../services/graph/graph-llmem.ts';
import type { GraphConfig, MemProjection, GraphEdge } from '../../services/graph/types.ts';
import type { LLMem, RecallMemoryResult, StoreResult, MemoryError } from '../../openrouter-chat.ts';
import type { RecallResult } from '../../types.ts';
import { ok, err } from '../../shared/result.ts';
import type { Result } from '../../shared/result.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Shared test config
// ──────────────────────────────────────────────────────────────────────────────

const TEST_CONFIG: GraphConfig = {
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

function makeProjectionResponse(overrides: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    chronos: 'In January 2025',
    topos: 'At the office',
    agents: 'John and Maria',
    theme: 'Project planning',
    cause: 'Deadline approaching',
    emotion: 'Stressed but focused',
    certainty: 'Certain, first-hand knowledge',
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. ProjectionExtractor
// ──────────────────────────────────────────────────────────────────────────────

describe('ProjectionExtractor', () => {
  let extractor: ProjectionExtractor;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { ...process.env };
    // PROMPT must be set; use the real baseline.md file in the project
    process.env['PROMPT'] = 'baseline';
    extractor = new ProjectionExtractor(TEST_CONFIG);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('returns 7 projections when all axes have content', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse() } }],
    });

    const result = await extractor.extractProjections('42', 'Team meeting about Q1 planning');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(7);
    const axes = result.value.map(p => p.axis);
    expect(axes).toContain('chronos');
    expect(axes).toContain('topos');
    expect(axes).toContain('agents');
    expect(axes).toContain('theme');
    expect(axes).toContain('cause');
    expect(axes).toContain('emotion');
    expect(axes).toContain('certainty');
    // All projections have the correct memId
    for (const p of result.value) {
      expect(p.memId).toBe('42');
    }
  });

  it('filters out axes with empty text', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: makeProjectionResponse({
              topos: '',        // empty — should be filtered
              emotion: '  ',   // whitespace only — should be filtered
            }),
          },
        },
      ],
    });

    const result = await extractor.extractProjections('42', 'Some text');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(5);
    const axes = result.value.map(p => p.axis);
    expect(axes).not.toContain('topos');
    expect(axes).not.toContain('emotion');
  });

  it('returns err when LLM returns invalid JSON', async () => {
    // All 3 attempts (1 initial + 2 retries) return malformed JSON
    const badResponse = { choices: [{ message: { content: 'this is not json {{{' } }] };
    mockChatCreate
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(badResponse);

    const result = await extractor.extractProjections('42', 'Some text');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/JSON parse failed/i);
  });

  it('returns err when LLM returns empty response (null content)', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    });

    const result = await extractor.extractProjections('42', 'Some text');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/empty response/i);
  });

  it('returns err when LLM returns empty response (no choices)', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [],
    });

    const result = await extractor.extractProjections('42', 'Some text');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/empty response/i);
  });

  it('returns err when schema validation fails (missing fields)', async () => {
    // All 3 attempts (1 initial + 2 retries) return schema-invalid JSON
    const badResponse = { choices: [{ message: { content: JSON.stringify({ chronos: 'yes' }) } }] };
    mockChatCreate
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(badResponse);

    const result = await extractor.extractProjections('42', 'Some text');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/schema validation failed/i);
  });

  it('returns err when LLM call throws', async () => {
    mockChatCreate.mockRejectedValueOnce(new Error('Network error'));

    const result = await extractor.extractProjections('42', 'Some text');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/LLM call failed/i);
  });

  it('passes max_tokens to the LLM call', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse() } }],
    });

    await extractor.extractProjections('42', 'Some mem text');

    expect(mockChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: expect.any(Number),
      }),
    );
    // The value must be >=4096 (generous headroom for full 7-axis JSON)
    const callArgs = mockChatCreate.mock.calls[0]?.[0] as { max_tokens: number };
    expect(callArgs.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  it('retries and succeeds when first response is malformed JSON then valid', async () => {
    // First call returns malformed JSON
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ invalid json' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: makeProjectionResponse() } }] });

    const result = await extractor.extractProjections('42', 'Some mem text');

    expect(result.ok).toBe(true);
    // Two LLM calls were made (retry on failure)
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
    if (!result.ok) return;
    expect(result.value).toHaveLength(7);
  });

  it('retries and succeeds when first response fails schema validation then valid', async () => {
    // First call returns valid JSON but wrong schema (missing required fields)
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ chronos: 'only' }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: makeProjectionResponse() } }] });

    const result = await extractor.extractProjections('42', 'Some mem text');

    expect(result.ok).toBe(true);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  it('returns err after exhausting all retries on persistent JSON parse failures', async () => {
    // All 3 attempts return malformed JSON (1 initial + 2 retries)
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ bad' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ still bad' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ still bad 2' } }] });

    const result = await extractor.extractProjections('42', 'Some mem text');

    expect(result.ok).toBe(false);
    expect(mockChatCreate).toHaveBeenCalledTimes(3);
    if (result.ok) return;
    expect(result.error.message).toMatch(/JSON parse failed/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. ProjectionExtractor — queryToProjections
// ──────────────────────────────────────────────────────────────────────────────

describe('ProjectionExtractor — queryToProjections', () => {
  let extractor: ProjectionExtractor;
  let savedEnv: NodeJS.ProcessEnv;

  function makeQueryVector(dims = 1536): number[] {
    return Array.from({ length: dims }, (_, i) => i / dims);
  }

  beforeEach(() => {
    // Use resetAllMocks (not clearAllMocks) to also flush unconsumed Once-queues,
    // preventing mock state from leaking into subsequent describe blocks.
    vi.resetAllMocks();
    savedEnv = { ...process.env };
    process.env['PROMPT'] = 'baseline';
    extractor = new ProjectionExtractor(TEST_CONFIG);
  });

  afterEach(() => {
    // Also reset after each test so any unconsumed Once-mocks don't leak.
    vi.resetAllMocks();
    process.env = savedEnv;
  });

  it('returns per-axis projections each with an embedding for a full query', async () => {
    const vectors = Array.from({ length: 7 }, (_, i) => makeQueryVector().map(v => v + i));

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse() } }],
    });
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    });

    const result = await extractor.queryToProjections('Team meeting about Q1 planning?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(7);
    for (const p of result.value) {
      expect(p.embedding).toBeDefined();
      expect(p.embedding).toHaveLength(1536);
    }
    const axes = result.value.map(p => p.axis);
    expect(axes).toContain('chronos');
    expect(axes).toContain('topos');
    expect(axes).toContain('agents');
    expect(axes).toContain('theme');
    expect(axes).toContain('cause');
    expect(axes).toContain('emotion');
    expect(axes).toContain('certainty');
  });

  it('uses the arm prompt (same system message as mem extraction)', async () => {
    const vectors = [makeQueryVector()];

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse({ topos: '', agents: '', theme: '', cause: '', emotion: '', certainty: '' }) } }],
    });
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ index: 0, embedding: vectors[0] }],
    });

    await extractor.queryToProjections('When did it happen?');

    // The LLM must have been called with the arm system prompt
    expect(mockChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
        ]),
      }),
    );
    const callArgs = mockChatCreate.mock.calls[0]?.[0];
    const systemMsg = callArgs?.messages?.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg?.content).toBeTruthy();
    // Same system prompt as used by extractProjections
    const extractorAny = extractor as unknown as { systemPrompt: string };
    expect(systemMsg?.content).toBe(extractorAny.systemPrompt);
  });

  it('omits axes with empty projection text (only non-empty axes returned)', async () => {
    const vectors = Array.from({ length: 5 }, (_, i) => makeQueryVector().map(v => v + i));

    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse({ topos: '', emotion: '' }) } }],
    });
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    });

    const result = await extractor.queryToProjections('Some question');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(5);
    const axes = result.value.map(p => p.axis);
    expect(axes).not.toContain('topos');
    expect(axes).not.toContain('emotion');
  });

  it('returns Err when LLM call fails', async () => {
    mockChatCreate.mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await extractor.queryToProjections('Some query');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/LLM call failed/i);
  });

  it('returns Err when LLM returns invalid JSON', async () => {
    // All 3 attempts (1 initial + 2 retries) return malformed JSON
    const badResponse = { choices: [{ message: { content: 'not valid json {{' } }] };
    mockChatCreate
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(badResponse);

    const result = await extractor.queryToProjections('Some query');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/JSON parse failed/i);
  });

  it('returns Err when embedding call fails', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse() } }],
    });
    // MAX_RETRIES=3, so 4 total attempts — use Once per attempt to avoid leaking persistent state
    mockEmbeddingsCreate
      .mockRejectedValueOnce(new Error('OpenAI embedding error'))
      .mockRejectedValueOnce(new Error('OpenAI embedding error'))
      .mockRejectedValueOnce(new Error('OpenAI embedding error'))
      .mockRejectedValueOnce(new Error('OpenAI embedding error'));

    const result = await extractor.queryToProjections('Some query');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Embedding failed after/i);
  });

  it('returns empty array when all axes are empty (no embeddings called)', async () => {
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeProjectionResponse({
        chronos: '', topos: '', agents: '', theme: '', cause: '', emotion: '', certainty: '',
      }) } }],
    });

    const result = await extractor.queryToProjections('Empty query');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. GraphEmbeddingService
// ──────────────────────────────────────────────────────────────────────────────

describe('GraphEmbeddingService', () => {
  let service: GraphEmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GraphEmbeddingService(TEST_CONFIG);
  });

  it('embedSingle returns a 1536-dimensional vector', async () => {
    const vector = makeVector(1536);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ index: 0, embedding: vector }],
    });

    const result = await service.embedSingle('Hello world');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1536);
    expect(result.value).toEqual(vector);
  });

  it('embedTexts returns correct number of vectors', async () => {
    const texts = ['first', 'second', 'third'];
    const vectors = texts.map((_, i) => makeVector(1536).map(v => v + i));
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: texts.map((_, i) => ({ index: i, embedding: vectors[i] })),
    });

    const result = await service.embedTexts(texts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });

  it('embedTexts returns empty array for empty input', async () => {
    const result = await service.embedTexts([]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });

  it('returns err after retries are exhausted on API error', async () => {
    // MAX_RETRIES = 3, so attempt 0..3 = 4 calls total
    mockEmbeddingsCreate.mockRejectedValue(new Error('Service unavailable'));

    const result = await service.embedTexts(['text']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Embedding failed after/i);
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(4); // attempt 0,1,2,3
  });

  it('embedTexts sorts embeddings by index to guarantee order', async () => {
    const texts = ['first', 'second'];
    const vec0 = [1, 0];
    const vec1 = [0, 1];
    // Return in reversed order — should still come out correctly
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [
        { index: 1, embedding: vec1 },
        { index: 0, embedding: vec0 },
      ],
    });

    const result = await service.embedTexts(texts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual(vec0);
    expect(result.value[1]).toEqual(vec1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. GraphStore
// ──────────────────────────────────────────────────────────────────────────────

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    mockPool.query.mockReset();
    mockPool.connect.mockResolvedValue(mockClient);

    store = new GraphStore(mockPool as unknown as pg.Pool);
  });

  // ── getMemstoreId ────────────────────────────────────────────────────────

  describe('getMemstoreId', () => {
    it('returns the id when memstore exists', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });

      const result = await store.getMemstoreId('my-context');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(7);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM memstores'),
        ['my-context'],
      );
    });

    it('returns err when memstore not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await store.getMemstoreId('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/memstore not found/i);
    });

    it('returns err on DB exception', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await store.getMemstoreId('ctx');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/getMemstoreId failed/i);
    });
  });

  // ── saveProjections ──────────────────────────────────────────────────────

  describe('saveProjections', () => {
    it('returns ok without any DB calls for empty projections', async () => {
      const result = await store.saveProjections([], 1);

      expect(result.ok).toBe(true);
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('calls INSERT with correct SQL and parameters including pgvector format', async () => {
      const vector = makeVector(1536);
      const projections: MemProjection[] = [
        { memId: '10', axis: 'theme', text: 'Project planning', embedding: vector },
      ];

      // BEGIN, INSERT, COMMIT
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await store.saveProjections(projections, 5);

      expect(result.ok).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO mem_projections'),
        expect.arrayContaining([10, 5, 'theme', 'Project planning']),
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back and returns err on DB exception', async () => {
      const projections: MemProjection[] = [
        { memId: '10', axis: 'theme', text: 'Test', embedding: makeVector() },
      ];

      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('constraint violation')); // INSERT fails

      const result = await store.saveProjections(projections, 5);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/saveProjections failed/i);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ── findSimilarByAxis ────────────────────────────────────────────────────

  describe('findSimilarByAxis', () => {
    it('returns candidates sorted by similarity from DB', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { mem_id: 20, text: 'Similar projection', similarity: 0.92 },
          { mem_id: 30, text: 'Another projection', similarity: 0.81 },
        ],
      });

      const result = await store.findSimilarByAxis(makeVector(), 'theme', 1, 10, 0.7, 5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toMatchObject({
        memId: '20',
        axis: 'theme',
        similarity: 0.92,
        projectionText: 'Similar projection',
      });
      expect(result.value[1]).toMatchObject({ memId: '30', similarity: 0.81 });
    });

    it('returns empty array when no candidates found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await store.findSimilarByAxis(makeVector(), 'chronos', 1, 10, 0.9, 5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('returns err on DB exception', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Query failed'));

      const result = await store.findSimilarByAxis(makeVector(), 'theme', 1, 10, 0.7, 5);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/findSimilarByAxis failed/i);
    });
  });

  // ── saveEdges ────────────────────────────────────────────────────────────

  describe('saveEdges', () => {
    it('returns ok without DB calls for empty edges', async () => {
      const result = await store.saveEdges([], 1);

      expect(result.ok).toBe(true);
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('calls correct SQL for each edge', async () => {
      const edges: GraphEdge[] = [
        {
          sourceMemId: '10',
          targetMemId: '20',
          edgeType: 'temporal',
          label: 'happened_before',
          relevance: 0.9,
          discoveryAxis: 'chronos',
        },
      ];

      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await store.saveEdges(edges, 5);

      expect(result.ok).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO mem_edges'),
        expect.arrayContaining([5, 10, 20, 'temporal', 'happened_before', 0.9, 'chronos']),
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back and returns err on DB exception', async () => {
      const edges: GraphEdge[] = [
        {
          sourceMemId: '10',
          targetMemId: '20',
          edgeType: 'semantic',
          label: 'related',
          relevance: 0.8,
          discoveryAxis: 'theme',
        },
      ];

      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')); // INSERT fails

      const result = await store.saveEdges(edges, 5);

      expect(result.ok).toBe(false);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ── getEdgesForMems ──────────────────────────────────────────────────────

  describe('getEdgesForMems', () => {
    it('returns ok empty array for empty memIds without DB call', async () => {
      const result = await store.getEdgesForMems([], 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('returns edges for given mem IDs', async () => {
      const createdAt = new Date('2025-01-01');
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            source_mem_id: 10,
            target_mem_id: 20,
            edge_type: 'temporal',
            label: 'before',
            relevance: 0.95,
            discovery_axis: 'chronos',
            created_at: createdAt,
          },
        ],
      });

      const result = await store.getEdgesForMems([10, 20], 5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({
        id: '1',
        sourceMemId: '10',
        targetMemId: '20',
        edgeType: 'temporal',
        label: 'before',
        relevance: 0.95,
        discoveryAxis: 'chronos',
        createdAt,
      });
    });

    it('returns err on DB exception', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Connection lost'));

      const result = await store.getEdgesForMems([10], 5);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/getEdgesForMems failed/i);
    });
  });

  // ── getMemTexts ──────────────────────────────────────────────────────────

  describe('getMemTexts', () => {
    it('returns empty map for empty input without DB call', async () => {
      const result = await store.getMemTexts([]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.size).toBe(0);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('returns map of id to text', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 10, summary: 'First mem text' },
          { id: 20, summary: 'Second mem text' },
        ],
      });

      const result = await store.getMemTexts([10, 20]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.get(10)).toBe('First mem text');
      expect(result.value.get(20)).toBe('Second mem text');
    });

    it('returns err on DB exception', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Query timeout'));

      const result = await store.getMemTexts([10]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/getMemTexts failed/i);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. GraphBuilder
// ──────────────────────────────────────────────────────────────────────────────

describe('GraphBuilder', () => {
  let mockStore: {
    getMemstoreId: ReturnType<typeof vi.fn>;
    saveProjections: ReturnType<typeof vi.fn>;
    findSimilarByAxis: ReturnType<typeof vi.fn>;
    saveEdges: ReturnType<typeof vi.fn>;
    getEdgesForMems: ReturnType<typeof vi.fn>;
    getMemTexts: ReturnType<typeof vi.fn>;
  };

  let mockExtractor: { extractProjections: ReturnType<typeof vi.fn> };
  let mockEmbedder: { embedTexts: ReturnType<typeof vi.fn>; embedSingle: ReturnType<typeof vi.fn> };
  let builder: GraphBuilder;

  const MEM_ID = 42;
  const MEM_TEXT = 'We had a team meeting in January to plan Q1 goals.';
  const CONTEXT_ID = 'test-context';
  const MEMSTORE_ID = 7;

  function makeProjections(): MemProjection[] {
    return [
      { memId: String(MEM_ID), axis: 'chronos', text: 'January 2025' },
      { memId: String(MEM_ID), axis: 'theme', text: 'Q1 planning' },
    ];
  }

  function makeEmbeddings(count: number): number[][] {
    return Array.from({ length: count }, (_, i) => makeVector().map(v => v + i));
  }

  function makeEdgeProposalJson(): string {
    return JSON.stringify([
      {
        source_id: `mem-${MEM_ID}`,
        target_id: 'mem-100',
        edge_type: 'temporal',
        label: 'same_period',
        relevance: 0.85,
      },
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      getMemstoreId: vi.fn(),
      saveProjections: vi.fn(),
      findSimilarByAxis: vi.fn(),
      saveEdges: vi.fn(),
      getEdgesForMems: vi.fn(),
      getMemTexts: vi.fn(),
    };

    mockExtractor = {
      extractProjections: vi.fn(),
    };

    mockEmbedder = {
      embedTexts: vi.fn(),
      embedSingle: vi.fn(),
    };

    builder = new GraphBuilder(
      mockStore as unknown as GraphStore,
      mockExtractor as unknown as ProjectionExtractor,
      mockEmbedder,
      TEST_CONFIG,
    );
  });

  it('full pipeline success: projections extracted, embedded, saved, neighbors found, Gemini called, edges saved', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    // One candidate found for the 'chronos' axis
    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([])); // other axes return nothing

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));

    // Gemini responds with one edge proposal
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeEdgeProposalJson() } }],
    });

    mockStore.saveEdges.mockResolvedValueOnce(ok(undefined));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      sourceMemId: String(MEM_ID),
      targetMemId: '100',
      edgeType: 'temporal',
      label: 'same_period',
      relevance: 0.85,
    });

    expect(mockExtractor.extractProjections).toHaveBeenCalledWith(String(MEM_ID), MEM_TEXT);
    expect(mockEmbedder.embedTexts).toHaveBeenCalledOnce();
    expect(mockStore.saveProjections).toHaveBeenCalledOnce();
    expect(mockStore.saveEdges).toHaveBeenCalledOnce();
  });

  it('returns empty edges array when no candidates found', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));
    // All axes return no candidates
    mockStore.findSimilarByAxis.mockResolvedValue(ok([]));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockStore.saveEdges).not.toHaveBeenCalled();
  });

  it('returns empty edges when no projections extracted', async () => {
    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok([]));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
    expect(mockEmbedder.embedTexts).not.toHaveBeenCalled();
  });

  it('returns err when extraction fails', async () => {
    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(
      err(new Error('LLM unavailable')),
    );

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/LLM unavailable/i);
  });

  it('returns err when memstore lookup fails', async () => {
    mockStore.getMemstoreId.mockResolvedValueOnce(
      err(new Error('memstore not found')),
    );

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/memstore not found/i);
  });

  it('processMem returns err when Gemini API throws', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([]));

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));

    mockChatCreate.mockRejectedValueOnce(new Error('Gemini API error'));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Gemini API call failed/i);
  });

  it('processMem skips proposals with unparseable target_id', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([]));

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));

    // Gemini returns proposals: one with invalid target_id, one valid
    mockChatCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify([
            {
              source_id: `mem-${MEM_ID}`,
              target_id: 'invalid-id',
              edge_type: 'temporal',
              label: 'bad_proposal',
              relevance: 0.9,
            },
            {
              source_id: `mem-${MEM_ID}`,
              target_id: 'mem-100',
              edge_type: 'semantic',
              label: 'good_proposal',
              relevance: 0.85,
            },
          ]),
        },
      }],
    });

    mockStore.saveEdges.mockResolvedValueOnce(ok(undefined));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the valid proposal should be included
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.targetMemId).toBe('100');
    expect(result.value[0]?.label).toBe('good_proposal');
  });

  it('processMem handles findArrayInObject (Gemini wraps array in object)', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([]));

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));

    // Gemini wraps array in an object
    mockChatCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            edges: [
              {
                source_id: `mem-${MEM_ID}`,
                target_id: 'mem-100',
                edge_type: 'temporal',
                label: 'same_period',
                relevance: 0.85,
              },
            ],
          }),
        },
      }],
    });

    mockStore.saveEdges.mockResolvedValueOnce(ok(undefined));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.targetMemId).toBe('100');
    expect(result.value[0]?.edgeType).toBe('temporal');
  });

  it('callGemini passes max_tokens to the LLM call', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([]));

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));
    mockChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: makeEdgeProposalJson() } }],
    });
    mockStore.saveEdges.mockResolvedValueOnce(ok(undefined));

    await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(mockChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: expect.any(Number),
      }),
    );
    // The value must be >=4096 (generous headroom for 10-20 edge proposals)
    const callArgs = mockChatCreate.mock.calls[0]?.[0] as { max_tokens: number };
    expect(callArgs.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  it('callGemini retries and succeeds when first response is malformed JSON then valid', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([]));

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));

    // First Gemini call returns malformed JSON, second returns valid
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ invalid json' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: makeEdgeProposalJson() } }] });

    mockStore.saveEdges.mockResolvedValueOnce(ok(undefined));

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(true);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('callGemini returns err after exhausting all retries on persistent malformed JSON', async () => {
    const projections = makeProjections();
    const embeddings = makeEmbeddings(2);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockExtractor.extractProjections.mockResolvedValueOnce(ok(projections));
    mockEmbedder.embedTexts.mockResolvedValueOnce(ok(embeddings));
    mockStore.saveProjections.mockResolvedValueOnce(ok(undefined));

    mockStore.findSimilarByAxis
      .mockResolvedValueOnce(ok([
        { memId: '100', axis: 'chronos', similarity: 0.88, projectionText: 'January period' },
      ]))
      .mockResolvedValue(ok([]));

    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[100, 'Another meeting in January']])));

    // All 3 Gemini attempts return malformed JSON (1 initial + 2 retries)
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ bad1' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ bad2' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{ bad3' } }] });

    const result = await builder.processMem(MEM_ID, MEM_TEXT, CONTEXT_ID);

    expect(result.ok).toBe(false);
    expect(mockChatCreate).toHaveBeenCalledTimes(3);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Gemini JSON parse failed/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. GraphRecall
// ──────────────────────────────────────────────────────────────────────────────

describe('GraphRecall', () => {
  let mockStore: {
    getMemstoreId: ReturnType<typeof vi.fn>;
    getEdgesForMems: ReturnType<typeof vi.fn>;
    getMemTexts: ReturnType<typeof vi.fn>;
    saveProjections: ReturnType<typeof vi.fn>;
    findSimilarByAxis: ReturnType<typeof vi.fn>;
    saveEdges: ReturnType<typeof vi.fn>;
  };

  let graphRecall: GraphRecall;

  const CONTEXT_ID = 'ctx-123';
  const MEMSTORE_ID = 3;

  function makeRecallResult(nodeIds: string[]): RecallResult {
    return {
      nodes: nodeIds.map(id => ({
        id,
        text: `Text of mem ${id}`,
        tags: [],
        match: 'direct' as const,
        timestamp: Date.now(),
        similarity: 0.9,
      })),
      edges: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      getMemstoreId: vi.fn(),
      getEdgesForMems: vi.fn(),
      getMemTexts: vi.fn(),
      saveProjections: vi.fn(),
      findSimilarByAxis: vi.fn(),
      saveEdges: vi.fn(),
    };

    graphRecall = new GraphRecall(mockStore as unknown as GraphStore);
  });

  it('adds neighbor nodes from graph edges', async () => {
    const recallResult = makeRecallResult(['10']);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(ok([
      {
        id: '1',
        sourceMemId: '10',
        targetMemId: '99',
        edgeType: 'temporal',
        label: 'happened_before',
        relevance: 0.88,
        discoveryAxis: 'chronos',
      },
    ]));
    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[99, 'Neighbor mem text']])));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Original node still there + 1 neighbor added
    expect(result.value.nodes).toHaveLength(2);
    const neighbor = result.value.nodes.find(n => n.id === '99');
    expect(neighbor).toBeDefined();
    expect(neighbor?.match).toBe('neighbor');
    expect(neighbor?.relation).toBe('happened_before');
    expect(neighbor?.similarity).toBe(0.88);

    // RecallEdge added
    expect(result.value.edges).toHaveLength(1);
    expect(result.value.edges[0]).toMatchObject({ from: '10', to: '99', type: 'temporal', weight: 0.88 });
  });

  it('returns original result unchanged when no edges found', async () => {
    const recallResult = makeRecallResult(['10', '20']);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(ok([]));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes).toHaveLength(2);
    expect(result.value.edges).toHaveLength(0);
    expect(mockStore.getMemTexts).not.toHaveBeenCalled();
  });

  it('returns original result unchanged when recall has no valid mem IDs', async () => {
    const emptyRecall = makeRecallResult([]);

    const result = await graphRecall.enrichRecall(emptyRecall, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes).toHaveLength(0);
    expect(mockStore.getMemstoreId).not.toHaveBeenCalled();
  });

  it('respects max 10 neighbor limit', async () => {
    // Recall has 1 node, 12 neighbors found via edges
    const recallResult = makeRecallResult(['1']);
    const edges: GraphEdge[] = Array.from({ length: 12 }, (_, i) => ({
      sourceMemId: '1',
      targetMemId: String(100 + i),
      edgeType: 'semantic' as const,
      label: 'related',
      relevance: 0.8 + i * 0.01,
      discoveryAxis: 'theme' as const,
    }));

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(ok(edges));

    const textMap = new Map<number, string>();
    for (let i = 0; i < 12; i++) {
      textMap.set(100 + i, `Neighbor ${i} text`);
    }
    mockStore.getMemTexts.mockResolvedValueOnce(ok(textMap));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1 original + max 10 neighbors
    expect(result.value.nodes).toHaveLength(11);
  });

  it('deduplicates neighbors and keeps the one with best relevance', async () => {
    const recallResult = makeRecallResult(['10', '20']);

    // Mem 99 appears as neighbor from both edge1 and edge2 with different relevance
    const edges: GraphEdge[] = [
      {
        sourceMemId: '10',
        targetMemId: '99',
        edgeType: 'semantic' as const,
        label: 'related_low',
        relevance: 0.70,
        discoveryAxis: 'theme' as const,
      },
      {
        sourceMemId: '20',
        targetMemId: '99',
        edgeType: 'causal' as const,
        label: 'related_high',
        relevance: 0.92,
        discoveryAxis: 'cause' as const,
      },
    ];

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(ok(edges));
    mockStore.getMemTexts.mockResolvedValueOnce(ok(new Map([[99, 'Deduplicated neighbor text']])));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2 original + 1 deduplicated neighbor
    expect(result.value.nodes).toHaveLength(3);
    const neighbor = result.value.nodes.find(n => n.id === '99');
    expect(neighbor).toBeDefined();
    // Best relevance kept
    expect(neighbor?.similarity).toBe(0.92);
    expect(neighbor?.relation).toBe('related_high');
  });

  it('returns original result gracefully when getMemstoreId fails', async () => {
    const recallResult = makeRecallResult(['10']);

    mockStore.getMemstoreId.mockResolvedValueOnce(err(new Error('DB down')));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(recallResult);
  });

  it('returns original result gracefully when getEdgesForMems fails', async () => {
    const recallResult = makeRecallResult(['10']);

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(err(new Error('Query failed')));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(recallResult);
  });

  it('enrichRecall adds edges even when no new neighbors found (all edges connect already-recalled mems)', async () => {
    // Both mems are already in the recall result
    const recallResult = makeRecallResult(['10', '99']);

    const edges: GraphEdge[] = [
      {
        sourceMemId: '10',
        targetMemId: '99',
        edgeType: 'temporal' as const,
        label: 'happened_before',
        relevance: 0.88,
        discoveryAxis: 'chronos' as const,
      },
    ];

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(ok(edges));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No new neighbor nodes added (both were already recalled)
    expect(result.value.nodes).toHaveLength(2);
    // getMemTexts was NOT called (no new neighbors to fetch)
    expect(mockStore.getMemTexts).not.toHaveBeenCalled();
    // But the RecallEdge is still added
    expect(result.value.edges).toHaveLength(1);
    expect(result.value.edges[0]).toMatchObject({ from: '10', to: '99', type: 'temporal', weight: 0.88 });
  });

  it('enrichRecall handles getMemTexts failure mid-enrichment', async () => {
    const recallResult = makeRecallResult(['10']);

    const edges: GraphEdge[] = [
      {
        sourceMemId: '10',
        targetMemId: '99',
        edgeType: 'semantic' as const,
        label: 'related',
        relevance: 0.75,
        discoveryAxis: 'theme' as const,
      },
    ];

    mockStore.getMemstoreId.mockResolvedValueOnce(ok(MEMSTORE_ID));
    mockStore.getEdgesForMems.mockResolvedValueOnce(ok(edges));
    mockStore.getMemTexts.mockResolvedValueOnce(err(new Error('DB timeout')));

    const result = await graphRecall.enrichRecall(recallResult, CONTEXT_ID);

    // Graceful degradation: returns original nodes with edges (no new neighbor nodes)
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Original nodes unchanged
    expect(result.value.nodes).toHaveLength(1);
    expect(result.value.nodes[0]?.id).toBe('10');
    // Edges are still added even though neighbor texts failed to fetch
    expect(result.value.edges).toHaveLength(1);
    expect(result.value.edges[0]).toMatchObject({ from: '10', to: '99', type: 'semantic', weight: 0.75 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. GraphEnrichedLLMem
// ──────────────────────────────────────────────────────────────────────────────

describe('GraphEnrichedLLMem', () => {
  let mockInner: {
    contextId: string;
    store: ReturnType<typeof vi.fn>;
    recall: ReturnType<typeof vi.fn>;
  };

  let mockGraphRecall: { enrichRecall: ReturnType<typeof vi.fn> };
  let enrichedLLMem: GraphEnrichedLLMem;

  const CONTEXT_ID = 'llmem-context';

  function makeInnerRecallResult(nodeIds: string[]): Result<RecallMemoryResult, MemoryError> {
    return ok({
      recall: {
        nodes: nodeIds.map(id => ({
          id,
          text: `Node ${id}`,
          tags: [],
          match: 'direct' as const,
          timestamp: Date.now(),
          similarity: 0.9,
        })),
        edges: [],
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockInner = {
      contextId: CONTEXT_ID,
      store: vi.fn(),
      recall: vi.fn(),
    };

    mockGraphRecall = {
      enrichRecall: vi.fn(),
    };

    enrichedLLMem = new GraphEnrichedLLMem(
      mockInner as unknown as LLMem,
      mockGraphRecall as unknown as GraphRecall,
    );
  });

  it('contextId is taken from inner LLMem', () => {
    expect(enrichedLLMem.contextId).toBe(CONTEXT_ID);
  });

  it('store() delegates to inner LLMem', async () => {
    const storeResult: Result<StoreResult, MemoryError> = ok({ stored: true });
    mockInner.store.mockResolvedValueOnce(storeResult);

    const result = await enrichedLLMem.store('Hello world', { sessionId: 'sess-1' });

    expect(result).toEqual(storeResult);
    expect(mockInner.store).toHaveBeenCalledWith('Hello world', { sessionId: 'sess-1' });
    expect(mockGraphRecall.enrichRecall).not.toHaveBeenCalled();
  });

  it('recall() enriches result with graph data', async () => {
    const innerResult = makeInnerRecallResult(['10']);
    mockInner.recall.mockResolvedValueOnce(innerResult);

    const enrichedRecall: RecallResult = {
      nodes: [
        ...(innerResult.ok ? innerResult.value.recall.nodes : []),
        {
          id: '99',
          text: 'Graph neighbor',
          tags: [],
          match: 'neighbor' as const,
          relation: 'related',
          timestamp: Date.now(),
          similarity: 0.8,
        },
      ],
      edges: [{ from: '10', to: '99', type: 'semantic', weight: 0.8 }],
    };

    mockGraphRecall.enrichRecall.mockResolvedValueOnce(ok(enrichedRecall));

    const result = await enrichedLLMem.recall('What happened in January?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recall.nodes).toHaveLength(2);
    expect(result.value.recall.edges).toHaveLength(1);
    expect(mockGraphRecall.enrichRecall).toHaveBeenCalledOnce();
  });

  it('recall() returns original result if inner recall fails', async () => {
    const innerError: Result<RecallMemoryResult, MemoryError> = {
      ok: false,
      error: { type: 'query', message: 'Recall DB error' },
    };
    mockInner.recall.mockResolvedValueOnce(innerError);

    const result = await enrichedLLMem.recall('query');

    expect(result.ok).toBe(false);
    expect(mockGraphRecall.enrichRecall).not.toHaveBeenCalled();
  });

  it('recall() returns original result if graph enrichment fails (graceful degradation)', async () => {
    const innerResult = makeInnerRecallResult(['10', '20']);
    mockInner.recall.mockResolvedValueOnce(innerResult);

    mockGraphRecall.enrichRecall.mockResolvedValueOnce(err(new Error('Graph DB down')));

    const result = await enrichedLLMem.recall('query');

    // Graceful degradation: returns inner result unchanged
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recall.nodes).toHaveLength(2);
    expect(result.value.recall.edges).toHaveLength(0);
  });
});
