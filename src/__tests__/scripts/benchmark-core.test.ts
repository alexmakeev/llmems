// Tests for scripts/benchmark/lib/benchmark-core.ts (bead llmems-g3a).
// Pure orchestration over injected embed/search — offline, no network, no DB.
import { describe, it, expect, vi } from 'vitest';
import { loadGoldSet, runBenchmark } from '../../../scripts/benchmark/lib/benchmark-core.js';

const GOLD = {
  memstoreId: 4,
  generatedAt: '2026-05-19T00:00:00.000Z',
  judgeModel: 'google/gemini-2.5-flash',
  questions: {
    'Какой код проекта?': { expectedMemIds: ['1', '2'] },
    'Где отпуск?': { expectedMemIds: ['3'] },
    'Вопрос без голда?': { expectedMemIds: [] },
  },
};

function deps(rankings: Record<string, string[]>) {
  const embed = vi.fn(async (q: string) => ({ vector: new Array(1536).fill(0.1), q }));
  const search = vi.fn(async (v: { q: string }) => {
    const ids = rankings[v.q] ?? [];
    return ids.map((id) => ({ id, summary: `mem-${id}` }));
  });
  return { embed: embed as never, search: search as never, embedMock: embed, searchMock: search };
}

describe('loadGoldSet', () => {
  it('parses a valid gold set and checks memstoreId', () => {
    const parsed = loadGoldSet(JSON.stringify(GOLD), 4);
    expect(Object.keys(parsed.questions)).toHaveLength(3);
    expect(parsed.judgeModel).toBe('google/gemini-2.5-flash');
  });

  it('throws loudly on memstoreId mismatch (wrong gold set for this corpus)', () => {
    expect(() => loadGoldSet(JSON.stringify(GOLD), 5)).toThrowError(/memstoreId/);
  });

  it('throws on structurally invalid content', () => {
    expect(() => loadGoldSet('{"no":"questions"}', 4)).toThrowError(/questions/);
    expect(() => loadGoldSet('not json', 4)).toThrowError();
  });
});

describe('runBenchmark', () => {
  it('computes per-question and aggregate metrics; zero-expected questions excluded from recall', async () => {
    const d = deps({
      'Какой код проекта?': ['1', 'x', '2', 'y'], // R@5 = 2/2
      'Где отпуск?': ['z', 'q', 'w'],             // R@5 = 0
      'Вопрос без голда?': ['1'],                 // excluded (null recall)
    });
    const gold = loadGoldSet(JSON.stringify(GOLD), 4);

    const result = await runBenchmark({ goldSet: gold, embed: d.embed, search: d.search, kValues: [5, 10] });

    expect(result.aggregate.evaluated).toBe(2);
    expect(result.aggregate.excludedZeroExpected).toBe(1);
    expect(result.aggregate.recallAt5).toBeCloseTo((1 + 0) / 2);
    expect(result.perQuestion).toHaveLength(3);
    const first = result.perQuestion[0]!;
    expect(first.recallAt5).toBe(1);
    expect(first.precisionAt5).toBeCloseTo(2 / 4);
  });

  it('QUESTION_LIMIT caps processed questions; unset = all (architect cheap-subset-first)', async () => {
    const d = deps({});
    const gold = loadGoldSet(JSON.stringify(GOLD), 4);

    const capped = await runBenchmark({
      goldSet: gold, embed: d.embed, search: d.search, kValues: [5, 10], questionLimit: 2,
    });
    expect(capped.perQuestion).toHaveLength(2);
    expect(d.embedMock).toHaveBeenCalledTimes(2);

    const full = await runBenchmark({ goldSet: gold, embed: d.embed, search: d.search, kValues: [5, 10] });
    expect(full.perQuestion).toHaveLength(3);
  });

  it('rejects QUESTION_LIMIT of 0 or negative (zero-question aggregates are misleading)', async () => {
    const d = deps({});
    const gold = loadGoldSet(JSON.stringify(GOLD), 4);

    await expect(
      runBenchmark({ goldSet: gold, embed: d.embed, search: d.search, kValues: [5], questionLimit: 0 }),
    ).rejects.toThrowError(/questionLimit/i);
    await expect(
      runBenchmark({ goldSet: gold, embed: d.embed, search: d.search, kValues: [5], questionLimit: -1 }),
    ).rejects.toThrowError(/questionLimit/i);
    expect(d.embedMock).not.toHaveBeenCalled();
  });

  it('fails fast (loud) when embed throws — no silent partial results', async () => {
    const gold = loadGoldSet(JSON.stringify(GOLD), 4);
    const embed = vi.fn(async () => {
      throw new Error('embeddings endpoint down');
    });
    const search = vi.fn(async () => []);

    await expect(
      runBenchmark({ goldSet: gold, embed: embed as never, search: search as never, kValues: [5] }),
    ).rejects.toThrowError(/embeddings endpoint down/);
  });

  it('fails fast when search throws', async () => {
    const gold = loadGoldSet(JSON.stringify(GOLD), 4);
    const embed = vi.fn(async () => ({ vector: [0.1], q: 'x' }));
    const search = vi.fn(async () => {
      throw new Error('db unreachable');
    });

    await expect(
      runBenchmark({ goldSet: gold, embed: embed as never, search: search as never, kValues: [5] }),
    ).rejects.toThrowError(/db unreachable/);
  });

  it('reports deviation vs the archived baseline (sanity gate for .10)', async () => {
    const d = deps({
      'Какой код проекта?': ['1', '2'],
      'Где отпуск?': ['3'],
      'Вопрос без голда?': [],
    });
    const gold = loadGoldSet(JSON.stringify(GOLD), 4);

    const result = await runBenchmark({ goldSet: gold, embed: d.embed, search: d.search, kValues: [5, 10] });

    // perfect run: recall@5 = 1.0 → deviation vs 0.524 archived
    expect(result.archivedBaseline.recallAt5).toBeCloseTo(0.524);
    expect(result.archivedBaseline.recallAt10).toBeCloseTo(0.668);
    expect(result.deviation.recallAt5).toBeCloseTo(1.0 - 0.524);
  });
});
