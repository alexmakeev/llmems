// Tests for scripts/benchmark/lib/longmemeval-core.ts (bead llmems-mdg).
// LongMemEval-S adapter: dataset parsing, category filter, session dedup,
// session-id provenance, spend preflight (budget gate BEFORE any embed call),
// seed/recall orchestration over injected ports. Fully offline — no network,
// no DB, synthetic mini-fixture mirroring the pinned dataset schema.
import { describe, it, expect, vi } from 'vitest';
import {
  parseDataset,
  isAbstention,
  filterByCategory,
  sessionText,
  collectUniqueSessions,
  encodeProvenance,
  decodeProvenance,
  truncateForEmbedding,
  computePreflight,
  assertBudget,
  runSeed,
  runRoundSeed,
  splitRounds,
  collectUniqueSessionTurns,
  runRecallScoring,
  CATEGORY_GROUPS,
  MAX_EMBED_CHARS,
  CHARS_PER_TOKEN,
  EMBEDDING_USD_PER_1M_TOKENS,
  type LmeQuestion,
} from '../../../scripts/benchmark/lib/longmemeval-core.js';

// ── Fixture: synthetic mini-dataset, schema-identical to longmemeval_s.json ──

function turns(text: string, hasAnswer = false): { role: string; content: string; has_answer?: boolean }[] {
  return [
    { role: 'user', content: `${text} (user turn)`, ...(hasAnswer ? { has_answer: true } : {}) },
    { role: 'assistant', content: `${text} (assistant turn)` },
  ];
}

// Shared session contents keyed by session id — same id MUST mean same content.
const SESSIONS: Record<string, { role: string; content: string; has_answer?: boolean }[]> = {
  s1: turns('degree in business administration', true),
  s2: turns('weather smalltalk'),
  s3: turns('marathon training plan', true),
  s4: turns('vacation in lisbon', true),
  s5: turns('new job at the bakery', true),
  s6: turns('crossword puzzle hints'),
  s7: turns('allergy to peanuts discovered', true),
  s8: turns('prefers window seats', true),
};

function q(
  id: string,
  type: string,
  sessionIds: string[],
  answerIds: string[],
  question = `question ${id}?`,
): LmeQuestion {
  return {
    question_id: id,
    question_type: type,
    question,
    question_date: '2023/05/30 (Tue) 23:40',
    answer: `answer ${id}`,
    answer_session_ids: answerIds,
    haystack_dates: sessionIds.map(() => '2023/05/20 (Sat) 02:21'),
    haystack_session_ids: sessionIds,
    haystack_sessions: sessionIds.map((sid) => SESSIONS[sid]!),
  };
}

const FIXTURE: LmeQuestion[] = [
  q('q1', 'single-session-user', ['s1', 's2'], ['s1']),
  q('q2', 'single-session-assistant', ['s2', 's3'], ['s3']),
  q('q3', 'multi-session', ['s3', 's4', 's5'], ['s4', 's5']),
  q('q4_abs', 'multi-session', ['s6'], ['answer_dummy_abs']),
  q('q5', 'knowledge-update', ['s1', 's7'], ['s7']),
  q('q6', 'single-session-preference', ['s8'], ['s8']),
];
// Unique sessions across FIXTURE: s1..s8 = 8 (11 refs).

// ── parseDataset ──────────────────────────────────────────────────────────────

describe('parseDataset', () => {
  it('accepts a schema-valid dataset', () => {
    const parsed = parseDataset(JSON.parse(JSON.stringify(FIXTURE)));
    expect(parsed).toHaveLength(6);
    expect(parsed[0]!.question_id).toBe('q1');
  });

  it('rejects a non-array root', () => {
    expect(() => parseDataset({ not: 'an array' })).toThrowError(/array/i);
  });

  it('accepts a numeric answer (32 multi-session counting questions in the real dataset)', () => {
    const variant = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    (variant[2] as { answer: unknown }).answer = 3;
    expect(parseDataset(variant)).toHaveLength(6);
  });

  it('rejects a question with misaligned haystack ids vs sessions', () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    broken[0]!.haystack_session_ids = ['s1'];
    expect(() => parseDataset(broken)).toThrowError(/haystack/i);
  });

  it('rejects an unknown question_type (schema drift guard)', () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    broken[1]!.question_type = 'brand-new-type';
    expect(() => parseDataset(broken)).toThrowError(/question_type/i);
  });

  it('rejects a turn without role/content strings', () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    (broken[0]!.haystack_sessions[0] as unknown[])[0] = { role: 'user' };
    expect(() => parseDataset(broken)).toThrowError(/turn/i);
  });

  it('rejects empty answer_session_ids', () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    broken[0]!.answer_session_ids = [];
    expect(() => parseDataset(broken)).toThrowError(/answer_session_ids/i);
  });
});

// ── abstention + category filter ──────────────────────────────────────────────

describe('isAbstention', () => {
  it('detects _abs question ids (official print_retrieval_metrics.py rule)', () => {
    expect(isAbstention({ question_id: 'q4_abs' })).toBe(true);
    expect(isAbstention({ question_id: '0862e8bf_abs' })).toBe(true);
    expect(isAbstention({ question_id: 'q1' })).toBe(false);
    // _abs is a suffix marker, not a substring anywhere
    expect(isAbstention({ question_id: 'q_absolute' })).toBe(false);
  });
});

describe('filterByCategory', () => {
  it('returns all questions when category is undefined', () => {
    expect(filterByCategory(FIXTURE, undefined)).toHaveLength(6);
  });

  it('info-extraction grouping = the three single-session types', () => {
    expect(CATEGORY_GROUPS['info-extraction']).toEqual([
      'single-session-user',
      'single-session-assistant',
      'single-session-preference',
    ]);
    const ie = filterByCategory(FIXTURE, 'info-extraction');
    expect(ie.map((x) => x.question_id)).toEqual(['q1', 'q2', 'q6']);
  });

  it('filters by raw question_type', () => {
    const ms = filterByCategory(FIXTURE, 'multi-session');
    expect(ms.map((x) => x.question_id)).toEqual(['q3', 'q4_abs']);
  });

  it('throws loudly on an unknown category, listing valid values', () => {
    expect(() => filterByCategory(FIXTURE, 'nope')).toThrowError(/info-extraction/);
    expect(() => filterByCategory(FIXTURE, 'nope')).toThrowError(/multi-session/);
  });
});

// ── session text + dedup ──────────────────────────────────────────────────────

describe('sessionText', () => {
  it('joins turns as "role: content" blocks', () => {
    const text = sessionText(SESSIONS['s1']!);
    expect(text).toBe(
      'user: degree in business administration (user turn)\n\n' +
        'assistant: degree in business administration (assistant turn)',
    );
  });
});

describe('collectUniqueSessions', () => {
  it('collects each unique session ONCE across questions (dedup ingestion)', () => {
    const unique = collectUniqueSessions(FIXTURE);
    expect(unique.size).toBe(8);
    expect([...unique.keys()].sort()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    expect(unique.get('s1')).toBe(sessionText(SESSIONS['s1']!));
  });

  it('throws loudly when the same session id carries different content', () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    broken[4]!.haystack_sessions[0] = turns('DIFFERENT content under same id');
    expect(() => collectUniqueSessions(broken)).toThrowError(/s1/);
  });
});

// ── provenance ────────────────────────────────────────────────────────────────

describe('provenance encode/decode', () => {
  it('round-trips a session id through the mem summary', () => {
    const summary = encodeProvenance('sharegpt_yywfIrx_0', 'multi\nline\ntext with ] bracket');
    expect(decodeProvenance(summary)).toBe('sharegpt_yywfIrx_0');
    expect(summary).toContain('multi\nline\ntext with ] bracket');
  });

  it('throws on a summary without the provenance marker (foreign mem in store)', () => {
    expect(() => decodeProvenance('just a plain summary')).toThrowError(/provenance|marker/i);
  });

  it('rejects session ids that would corrupt the marker', () => {
    expect(() => encodeProvenance('bad]id', 'text')).toThrowError(/session id/i);
    expect(() => encodeProvenance('bad\nid', 'text')).toThrowError(/session id/i);
  });
});

// ── truncation + preflight ────────────────────────────────────────────────────

describe('truncateForEmbedding', () => {
  it('cap is FROZEN at the token-verified value (re-scan required to change)', () => {
    // 26 000 is backed by an EXHAUSTIVE cl100k_base scan of the sha-pinned corpus
    // (2026-06-12): worst session = 7 652 tokens ≤ 8 192 API limit, 7/19 195 truncated.
    // 28 000 was proven WRONG live: sharegpt_xGoJZ6Z_0 → 8 222 tokens → API 400.
    // Bumping this without re-running the token scan reintroduces that failure.
    expect(MAX_EMBED_CHARS).toBe(26_000);
  });

  it('passes short text through untouched', () => {
    expect(truncateForEmbedding('short')).toEqual({ text: 'short', truncated: false });
  });

  it('caps text at MAX_EMBED_CHARS and flags it', () => {
    const long = 'x'.repeat(MAX_EMBED_CHARS + 500);
    const result = truncateForEmbedding(long);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(MAX_EMBED_CHARS);
  });
});

describe('computePreflight', () => {
  it('projects sessions, tokens and USD for the full selection', () => {
    const p = computePreflight(FIXTURE, undefined);
    expect(p.questionsSelected).toBe(6);
    expect(p.questionsScored).toBe(5); // q4_abs excluded from scoring
    expect(p.uniqueSessions).toBe(8);
    expect(p.truncatedUnits).toBe(0);
    expect(p.granularity).toBe('session'); // default
    expect(p.embedUnits).toBe(8); // session granularity → one embed input per session

    const sessionChars = [...collectUniqueSessions(FIXTURE).values()].reduce((a, t) => a + t.length, 0);
    const questionChars = FIXTURE.filter((x) => !isAbstention(x)).reduce((a, x) => a + x.question.length, 0);
    const expectedTokens = Math.ceil(sessionChars / CHARS_PER_TOKEN) + Math.ceil(questionChars / CHARS_PER_TOKEN);
    expect(p.estimatedTokens).toBe(expectedTokens);
    expect(p.projectedUsd).toBeCloseTo((expectedTokens / 1_000_000) * EMBEDDING_USD_PER_1M_TOKENS, 10);
  });

  it('projects the category slice only (ingestion scope = selected questions incl. their _abs)', () => {
    const p = computePreflight(FIXTURE, 'multi-session');
    expect(p.questionsSelected).toBe(2); // q3 + q4_abs
    expect(p.questionsScored).toBe(1); // q3
    expect(p.uniqueSessions).toBe(4); // s3,s4,s5 + s6 (abs haystack still ingested)
    expect(p.category).toBe('multi-session');
  });

  it('counts sessions that will be truncated at embed time', () => {
    const longFixture = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    // fresh session id — mutating a SHARED id's content would (correctly) trip the dedup guard
    longFixture[0]!.haystack_session_ids[1] = 's9';
    longFixture[0]!.haystack_sessions[1] = [
      { role: 'user', content: 'y'.repeat(MAX_EMBED_CHARS + 1000) },
    ];
    const p = computePreflight(longFixture, undefined);
    expect(p.truncatedUnits).toBe(1);
    // tokens are estimated on the TRUNCATED text (that is what gets embedded)
    const unique = collectUniqueSessions(longFixture);
    const cappedChars = [...unique.values()].reduce(
      (a, t) => a + Math.min(t.length, MAX_EMBED_CHARS),
      0,
    );
    const questionChars = longFixture
      .filter((x) => !isAbstention(x))
      .reduce((a, x) => a + x.question.length, 0);
    expect(p.estimatedTokens).toBe(
      Math.ceil(cappedChars / CHARS_PER_TOKEN) + Math.ceil(questionChars / CHARS_PER_TOKEN),
    );
  });
});

describe('assertBudget', () => {
  it('passes when projection is within budget', () => {
    expect(() => assertBudget(0.35, 1)).not.toThrow();
  });

  it('aborts loudly when projection exceeds the budget', () => {
    expect(() => assertBudget(1.2, 1)).toThrowError(/budget/i);
    expect(() => assertBudget(1.2, 1)).toThrowError(/1\.2/);
  });

  it('rejects a non-positive budget (misconfigured env)', () => {
    expect(() => assertBudget(0.1, 0)).toThrowError(/budget/i);
    expect(() => assertBudget(0.1, -1)).toThrowError(/budget/i);
  });
});

// ── seed orchestration ────────────────────────────────────────────────────────

function seedPorts(existing: string[] = []) {
  const stored: { summary: string; embedding: number[] }[] = [];
  const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
  const storeMems = vi.fn(async (mems: { summary: string; embedding: number[] }[]) => {
    stored.push(...mems);
  });
  const existingSessionIds = vi.fn(async () => new Set(existing));
  return { embedBatch, storeMems, existingSessionIds, stored };
}

describe('runSeed', () => {
  it('embeds each unique session exactly once, with provenance on every stored mem', async () => {
    const ports = seedPorts();
    const report = await runSeed({ questions: FIXTURE, budgetUsd: 1, ports });

    expect(report.uniqueSessions).toBe(8);
    expect(report.alreadyPresent).toBe(0);
    expect(report.embedded).toBe(8);

    const embeddedTexts = ports.embedBatch.mock.calls.flatMap(([texts]) => texts);
    expect(embeddedTexts).toHaveLength(8);
    expect(new Set(embeddedTexts).size).toBe(8);

    expect(ports.stored).toHaveLength(8);
    const decodedIds = ports.stored.map((m) => decodeProvenance(m.summary)).sort();
    expect(decodedIds).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    for (const mem of ports.stored) {
      expect(mem.embedding).toEqual([0.1, 0.2, 0.3]);
    }
  });

  it('is idempotent: skips sessions already present in the store', async () => {
    const ports = seedPorts(['s1', 's2']);
    const report = await runSeed({ questions: FIXTURE, budgetUsd: 1, ports });

    expect(report.alreadyPresent).toBe(2);
    expect(report.embedded).toBe(6);
    const embeddedTexts = ports.embedBatch.mock.calls.flatMap(([texts]) => texts);
    expect(embeddedTexts).not.toContain(sessionText(SESSIONS['s1']!));
    expect(ports.stored.map((m) => decodeProvenance(m.summary)).sort()).toEqual(
      ['s3', 's4', 's5', 's6', 's7', 's8'],
    );
  });

  it('NEVER calls embed when the projected cost exceeds the budget (spend gate)', async () => {
    const ports = seedPorts();
    await expect(
      runSeed({ questions: FIXTURE, budgetUsd: 0.0000001, ports }),
    ).rejects.toThrowError(/budget/i);
    expect(ports.embedBatch).not.toHaveBeenCalled();
    expect(ports.storeMems).not.toHaveBeenCalled();
  });

  it('gates on the cost of MISSING sessions only (idempotent top-up stays cheap)', async () => {
    // budget that covers 1 remaining session but not all 8
    const oneSessionUsd =
      (Math.ceil(sessionText(SESSIONS['s8']!).length / CHARS_PER_TOKEN) / 1_000_000) *
      EMBEDDING_USD_PER_1M_TOKENS;
    const ports = seedPorts(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    const report = await runSeed({
      questions: FIXTURE,
      budgetUsd: oneSessionUsd * 1.5,
      ports,
    });
    expect(report.embedded).toBe(1);
  });

  it('truncates over-long sessions before embedding and reports the count', async () => {
    const longFixture = JSON.parse(JSON.stringify(FIXTURE)) as LmeQuestion[];
    // fresh session id — mutating a SHARED id's content would (correctly) trip the dedup guard
    longFixture[0]!.haystack_session_ids[1] = 's9';
    longFixture[0]!.haystack_sessions[1] = [
      { role: 'user', content: 'y'.repeat(MAX_EMBED_CHARS + 1000) },
    ];
    const ports = seedPorts();
    const report = await runSeed({ questions: longFixture, budgetUsd: 1, ports });

    expect(report.truncated).toBe(1);
    const embeddedTexts = ports.embedBatch.mock.calls.flatMap(([texts]) => texts);
    for (const text of embeddedTexts) {
      expect(text.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
    }
    // stored summary keeps provenance even for the truncated session
    expect(ports.stored.map((m) => decodeProvenance(m.summary))).toContain('s9');
  });

  it('respects the category filter for ingestion scope', async () => {
    const ports = seedPorts();
    const report = await runSeed({
      questions: FIXTURE,
      category: 'info-extraction',
      budgetUsd: 1,
      ports,
    });
    // q1,q2,q6 → s1,s2,s3,s8
    expect(report.uniqueSessions).toBe(4);
    expect(ports.stored.map((m) => decodeProvenance(m.summary)).sort()).toEqual(
      ['s1', 's2', 's3', 's8'],
    );
  });
});

// ── round-level granularity (splitRounds + runRoundSeed) ──────────────────────

describe('splitRounds', () => {
  const t = (role: string, content = role) => ({ role, content });

  it('splits strictly-alternating turns into user+assistant rounds', () => {
    const r = splitRounds([t('user', 'u1'), t('assistant', 'a1'), t('user', 'u2'), t('assistant', 'a2')]);
    expect(r.map((round) => round.map((x) => x.content))).toEqual([['u1', 'a1'], ['u2', 'a2']]);
  });

  it('opens a fresh round at each user turn, absorbing following non-user turns', () => {
    const r = splitRounds([t('user'), t('assistant'), t('assistant'), t('user')]);
    expect(r.map((round) => round.map((x) => x.role))).toEqual([
      ['user', 'assistant', 'assistant'],
      ['user'],
    ]);
  });

  it('puts leading non-user turns (assistant-first session) in their own round', () => {
    const r = splitRounds([t('assistant'), t('user'), t('assistant')]);
    expect(r.map((round) => round.map((x) => x.role))).toEqual([['assistant'], ['user', 'assistant']]);
  });

  it('handles consecutive user turns as separate rounds; loses no turn', () => {
    const turnsIn = [t('user', 'u1'), t('user', 'u2'), t('assistant', 'a1')];
    const r = splitRounds(turnsIn);
    expect(r).toEqual([[t('user', 'u1')], [t('user', 'u2'), t('assistant', 'a1')]]);
    // concat of rounds === input (universal, no drop/dup)
    expect(r.flat()).toEqual(turnsIn);
  });

  it('returns no rounds for an empty session', () => {
    expect(splitRounds([])).toEqual([]);
  });
});

describe('computePreflight (round granularity)', () => {
  it('counts rounds (not sessions) as embed inputs and projects their tokens', () => {
    const session = computePreflight(FIXTURE, undefined, 'session');
    const round = computePreflight(FIXTURE, undefined, 'round');
    expect(round.granularity).toBe('round');
    expect(round.uniqueSessions).toBe(session.uniqueSessions); // same sessions
    // every fixture session is a single user-turn → exactly one round each here
    const sessions = collectUniqueSessionTurns(FIXTURE);
    const totalRounds = [...sessions.values()].reduce((a, ts) => a + splitRounds(ts).length, 0);
    expect(round.embedUnits).toBe(totalRounds);
    expect(round.embedUnits).toBeGreaterThanOrEqual(session.embedUnits);
  });
});

describe('runRoundSeed', () => {
  it('stores one mem per round, all carrying the session-id provenance marker', async () => {
    const ports = seedPorts();
    const report = await runRoundSeed({ questions: FIXTURE, budgetUsd: 1, ports });

    const sessions = collectUniqueSessionTurns(FIXTURE);
    const expectedRounds = [...sessions.values()].reduce((a, ts) => a + splitRounds(ts).length, 0);
    expect(report.uniqueSessions).toBe(sessions.size);
    expect(report.roundsEmbedded).toBe(expectedRounds);
    expect(ports.stored).toHaveLength(expectedRounds);
    // every stored mem decodes to a real session id (provenance preserved)
    const decoded = new Set(ports.stored.map((m) => decodeProvenance(m.summary)));
    expect(decoded).toEqual(new Set(sessions.keys()));
  });

  it('emits MULTIPLE rounds for a multi-round session, all sharing the session-id marker', async () => {
    // A session with 3 user-started rounds (NOT one-round-per-session like the
    // shared FIXTURE) — exercises round mode genuinely diverging from session mode.
    const multiRound: LmeQuestion = {
      question_id: 'qmr',
      question_type: 'single-session-user',
      question: 'multi round question?',
      question_date: '2023/05/30 (Tue) 23:40',
      answer: 'a',
      answer_session_ids: ['smr'],
      haystack_dates: ['2023/05/20 (Sat) 02:21'],
      haystack_session_ids: ['smr'],
      haystack_sessions: [
        [
          { role: 'user', content: 'r1 user' },
          { role: 'assistant', content: 'r1 asst' },
          { role: 'user', content: 'r2 user' },
          { role: 'assistant', content: 'r2 asst' },
          { role: 'user', content: 'r3 user' },
        ],
      ],
    };
    const ports = seedPorts();
    const report = await runRoundSeed({ questions: [multiRound], budgetUsd: 1, ports });

    expect(report.uniqueSessions).toBe(1);
    expect(report.roundsEmbedded).toBe(3); // 3 user-started rounds
    expect(report.roundsEmbedded).toBeGreaterThan(report.uniqueSessions); // ≠ session mode
    expect(ports.stored).toHaveLength(3);
    // every round mem decodes to the SAME session id (provenance repeated per round)
    expect(ports.stored.map((m) => decodeProvenance(m.summary))).toEqual(['smr', 'smr', 'smr']);

    // round preflight agrees: embed inputs = rounds (3) > sessions (1)
    const p = computePreflight([multiRound], undefined, 'round');
    expect(p.embedUnits).toBe(3);
    expect(p.uniqueSessions).toBe(1);
    expect(p.embedUnits).toBeGreaterThan(p.uniqueSessions);
  });

  it('aborts loudly on a non-empty target store (no idempotent round resume)', async () => {
    const ports = seedPorts(['s1']); // store already has a session
    await expect(runRoundSeed({ questions: FIXTURE, budgetUsd: 1, ports })).rejects.toThrowError(
      /EMPTY target memstore|fresh contextId/i,
    );
    expect(ports.embedBatch).not.toHaveBeenCalled(); // no spend on a dirty store
  });

  it('NEVER embeds when the projected round cost exceeds the budget (spend gate)', async () => {
    const ports = seedPorts();
    await expect(runRoundSeed({ questions: FIXTURE, budgetUsd: 1e-12, ports })).rejects.toThrowError(
      /budget/i,
    );
    expect(ports.embedBatch).not.toHaveBeenCalled();
  });
});

// ── recall scoring ────────────────────────────────────────────────────────────

function recallPorts(opts: {
  stored?: string[];
  ranked: Record<string, string[]>;
}) {
  const storedIds = opts.stored ?? ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  const embeddedQuestions: string[] = [];
  const embedQuestion = vi.fn(async (text: string) => {
    embeddedQuestions.push(text);
    return [embeddedQuestions.length - 1];
  });
  const searchMems = vi.fn(async (vector: number[]) => {
    const text = embeddedQuestions[vector[0]!];
    const question = FIXTURE.find((x) => x.question === text);
    const ids = (question && opts.ranked[question.question_id]) ?? [];
    return ids.map((sid) => ({ summary: encodeProvenance(sid, `text of ${sid}`) }));
  });
  const storedSessionIds = vi.fn(async () => new Set(storedIds));
  return { embedQuestion, searchMems, storedSessionIds };
}

describe('runRecallScoring', () => {
  it('computes recall_any@5/@10/@20/@30 with abstention excluded from the denominator', async () => {
    const ports = recallPorts({
      ranked: {
        q1: ['s1', 's2'], // hit@5
        q2: ['s2', 's1', 's4', 's5', 's6', 's3'], // s3 at rank 6 → miss@5, hit@10
        q3: ['s6', 's2'], // miss
        q5: ['s7'], // hit@5
        q6: ['s8'], // hit@5
      },
    });
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });

    expect(result.aggregate.scored).toBe(5);
    expect(result.aggregate.abstentionExcluded).toBe(1);
    expect(result.aggregate.recallAnyAt5).toBeCloseTo(3 / 5);
    expect(result.aggregate.recallAnyAt10).toBeCloseTo(4 / 5);
    // deeper K is monotone non-decreasing; the longest ranked list here is 6 ids
    // (< 20), so @20 and @30 equal @10 — every hit already lands within top-10.
    expect(result.aggregate.recallAnyAt20).toBeCloseTo(4 / 5);
    expect(result.aggregate.recallAnyAt30).toBeCloseTo(4 / 5);
    // abstention question is never embedded or searched
    expect(ports.embedQuestion).toHaveBeenCalledTimes(5);
  });

  it('recall_any@K is monotone non-decreasing in K: a hit beyond top-10 lifts @20/@30 only', async () => {
    const ports = recallPorts({
      ranked: {
        // s1 (q1 evidence) at rank 15 → miss@10, hit@20 and hit@30
        q1: [
          'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10',
          'd11', 'd12', 'd13', 'd14', 's1',
        ],
        q2: ['s3'],
        q3: ['s6'], // s6 ∉ q3 expected (s4,s5) → miss at every K
        q5: ['s7'],
        q6: ['s8'],
      },
    });
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });
    const q1 = result.perQuestion.find((x) => x.question_id === 'q1')!;
    expect(q1.hitAt5).toBe(0);
    expect(q1.hitAt10).toBe(0);
    expect(q1.hitAt20).toBe(1);
    expect(q1.hitAt30).toBe(1);
    // q2,q3(miss),q5,q6 unaffected by K → @10 = 3/5, @20 = @30 = 4/5
    expect(result.aggregate.recallAnyAt10).toBeCloseTo(3 / 5);
    expect(result.aggregate.recallAnyAt20).toBeCloseTo(4 / 5);
    expect(result.aggregate.recallAnyAt30).toBeCloseTo(4 / 5);
    // full-depth ranking is persisted (not truncated to 10) for offline re-score
    expect(q1.topSessions.length).toBe(15);
  });

  it('dedupes retrieved sessions to UNIQUE ids before applying K', async () => {
    const ports = recallPorts({
      ranked: {
        // duplicates must NOT consume K slots: dedup → ['s2','s1'] → s1 lands in top-5
        q1: ['s2', 's2', 's2', 's2', 's2', 's1'],
        q2: ['s3'],
        q3: ['s4', 's5'],
        q5: ['s7'],
        q6: ['s8'],
      },
    });
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });
    const q1 = result.perQuestion.find((x) => x.question_id === 'q1')!;
    expect(q1.hitAt5).toBe(1); // dedup → ['s2','s1'] → s1 within top-5
    expect(result.aggregate.recallAnyAt5).toBeCloseTo(1);
  });

  it('reports per-category aggregates', async () => {
    const ports = recallPorts({
      ranked: { q1: ['s1'], q2: ['s2'], q3: ['s4'], q5: ['s1'], q6: ['s8'] },
    });
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });
    expect(result.aggregate.byCategory['single-session-user']!.recallAnyAt5).toBe(1);
    expect(result.aggregate.byCategory['single-session-assistant']!.recallAnyAt5).toBe(0);
    expect(result.aggregate.byCategory['multi-session']!.scored).toBe(1);
    expect(result.aggregate.byCategory['knowledge-update']!.recallAnyAt5).toBe(0);
  });

  it('SANITY: aborts when fetchK is saturated but dedups to <30 unique sessions (round underfetch)', async () => {
    // 30 ranked rows (= default fetchK) collapsing to 2 unique sessions — exactly
    // the round-granularity hazard: more unique sessions may exist beyond the cap,
    // so @20/@30 would be falsely truncated. Must abort with a raise-fetch-k hint.
    const ranked30 = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 's1' : 's2'));
    const ports = recallPorts({
      ranked: { q1: ranked30, q2: ['s3'], q3: ['s4'], q5: ['s7'], q6: ['s8'] },
    });
    await expect(runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports })).rejects.toThrowError(
      /FETCH-K TOO SMALL|fetch-k/i,
    );
  });

  it('does NOT flag underfetch when the ANN limit is not saturated (fewer rows than fetchK)', async () => {
    // short ranked lists (< fetchK) ⇒ store returned everything in range ⇒ metric exact, no abort
    const ports = recallPorts({
      ranked: { q1: ['s1'], q2: ['s3'], q3: ['s4'], q5: ['s7'], q6: ['s8'] },
    });
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });
    expect(result.aggregate.scored).toBe(5);
  });

  it('SANITY: aborts loudly when evidence sessions are missing from the store (broken ingestion ≠ weak recall)', async () => {
    const ports = recallPorts({
      stored: ['s1', 's2', 's3', 's4', 's5', 's6', 's8'], // s7 missing — q5 evidence
      ranked: {},
    });
    await expect(runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports })).rejects.toThrowError(/s7/);
    expect(ports.embedQuestion).not.toHaveBeenCalled(); // no spend on a broken store
  });

  it('SANITY: aborts loudly on EXTRA sessions in the store (selection vs corpus condition mismatch)', async () => {
    // store seeded with the full set, recall asked for the info-extraction slice:
    // ANN would search the larger corpus — a silently different retrieval condition.
    const ports = recallPorts({
      stored: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], // s4..s7 are NOT in the IE selection
      ranked: {},
    });
    await expect(
      runRecallScoring({ questions: FIXTURE, category: 'info-extraction', budgetUsd: 1, ports }),
    ).rejects.toThrowError(/extra|condition/i);
    expect(ports.embedQuestion).not.toHaveBeenCalled(); // no spend on a mismatched corpus
  });

  it('SANITY: abstention dummy evidence ids are NOT required to exist in the store', async () => {
    const ports = recallPorts({
      ranked: { q1: ['s1'], q2: ['s3'], q3: ['s4'], q5: ['s7'], q6: ['s8'] },
    });
    // store has s1..s8 but NOT answer_dummy_abs — must not throw
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });
    expect(result.sanity.pass).toBe(true);
    expect(result.sanity.missingEvidenceSessions).toEqual([]);
  });

  it('reports stored vs expected session counts for implementation-sanity', async () => {
    const ports = recallPorts({
      ranked: { q1: ['s1'], q2: ['s3'], q3: ['s4'], q5: ['s7'], q6: ['s8'] },
    });
    const result = await runRecallScoring({ questions: FIXTURE, budgetUsd: 1, ports });
    expect(result.sanity.expectedSessions).toBe(8);
    expect(result.sanity.storedSessions).toBe(8);
  });

  it('respects the category filter for scoring scope', async () => {
    const ports = recallPorts({
      stored: ['s1', 's2', 's3', 's8'],
      ranked: { q1: ['s1'], q2: ['s2'], q6: ['s8'] },
    });
    const result = await runRecallScoring({
      questions: FIXTURE,
      category: 'info-extraction',
      budgetUsd: 1,
      ports,
    });
    expect(result.aggregate.scored).toBe(3);
    expect(result.aggregate.recallAnyAt5).toBeCloseTo(2 / 3);
  });

  it('NEVER embeds questions when their projected cost exceeds the budget (spend gate)', async () => {
    const ports = recallPorts({ ranked: {} });
    await expect(
      runRecallScoring({ questions: FIXTURE, budgetUsd: 1e-12, ports }),
    ).rejects.toThrowError(/budget/i);
    expect(ports.embedQuestion).not.toHaveBeenCalled();
  });
});
