// scripts/benchmark/lib/longmemeval-core.ts — LongMemEval-S adapter core
// (bead llmems-mdg). Pure orchestration over injected ports: dataset parsing,
// category filter, unique-session dedup, session-id provenance, spend preflight
// (budget gate BEFORE any embedding call), seed + retrieval-only recall_any@K
// scoring. Fully offline-testable — no network, no DB, no fs in this module.
//
// Dataset pin (bead llmems-yn7): HF xiaowu0162/longmemeval-cleaned,
// longmemeval_s_cleaned.json, saved as materials/benchmark-data/longmemeval_s.json.
// 500 questions; retrieval denominator = 470 (the 30 "_abs" abstention questions
// are excluded from scoring, mirroring official print_retrieval_metrics.py —
// their answer_session_ids are dummies absent from the haystack).

import { recallAnyAtK } from './recall-metrics.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** SHA256 of the pinned dataset file (bead llmems-yn7). Verified before any run. */
export const LONGMEMEVAL_S_SHA256 =
  'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';

/** Pinned local dataset path (gitignored materials/; see bead llmems-yn7). */
export const DEFAULT_DATASET_PATH = 'materials/benchmark-data/longmemeval_s.json';

/** text-embedding-3-small, real-time tier (materials/research-2026-06-11). */
export const EMBEDDING_USD_PER_1M_TOKENS = 0.02;

/** Conservative chars→tokens heuristic for English chat text. */
export const CHARS_PER_TOKEN = 4;

/**
 * Embedding input cap. The embeddings API rejects inputs over 8 192 tokens.
 *
 * 26 000 is TOKEN-VERIFIED against the entire sha-pinned corpus (cl100k_base
 * exhaustive scan, 2026-06-12): worst capped session = 7 652 tokens
 * (sharegpt_xGoJZ6Z_0; 540-token margin), 7 of 19 195 unique sessions truncated.
 * The previous chars/4-heuristic cap (28 000) failed live: that same session
 * tokenized to 8 222 → API 400. The input domain is CLOSED (dataset sha256 is
 * verified on every run), so the exhaustive scan is sound; the API error stays
 * as the loud guard for any future re-pin. Re-run the scan before changing this.
 */
export const MAX_EMBED_CHARS = 26_000;

/** The six question_type values present in LongMemEval-S (schema-drift guard). */
export const QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
] as const;

/**
 * Category groupings accepted by the --category filter, in addition to the raw
 * question_type values. "info-extraction" = the paper's IE ability bucket —
 * a GROUPING, not a question_type (the file has no such type).
 *
 * Mapping verified against the pinned file (2026-06-12, binding contract):
 *   single-session-user       70 total /  64 non-abs
 *   single-session-assistant  56 total /  56 non-abs
 *   single-session-preference 30 total /  30 non-abs
 *   IE group                 156 total / 150 non-abs  ← stage-1 denominator 150 ✓
 * (ssu+ssa alone would be 126/120 — does NOT reproduce the expected 150.)
 */
export const CATEGORY_GROUPS: Record<string, readonly string[]> = {
  'info-extraction': [
    'single-session-user',
    'single-session-assistant',
    'single-session-preference',
  ],
};

// ── Dataset types + validation ────────────────────────────────────────────────

export interface LmeTurn {
  role: string;
  content: string;
  /** Evidence marker: true on turns containing the answer (cleaned dataset). */
  has_answer?: boolean;
}

export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  /** Gold answer for the (unused-here) QA judge; numeric on 32 counting questions. */
  answer: string | number;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LmeTurn[][];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

/** Validate the parsed dataset JSON against the pinned field contract (yn7). */
export function parseDataset(data: unknown): LmeQuestion[] {
  if (!Array.isArray(data)) {
    throw new Error('LongMemEval dataset invalid: root must be an array of questions');
  }
  const knownTypes = new Set<string>(QUESTION_TYPES);
  data.forEach((raw: unknown, index: number) => {
    const q = raw as Partial<LmeQuestion>;
    const label = `question[${index}] (${String(q.question_id ?? '?')})`;
    for (const field of ['question_id', 'question_type', 'question'] as const) {
      if (typeof q[field] !== 'string' || q[field] === '') {
        throw new Error(`LongMemEval dataset invalid: ${label} lacks string field "${field}"`);
      }
    }
    // `answer` feeds only the (optional, out-of-scope) QA judge — string normally,
    // numeric on the 32 multi-session counting questions. Presence still required.
    if (typeof q.answer !== 'string' && typeof q.answer !== 'number') {
      throw new Error(`LongMemEval dataset invalid: ${label} lacks string/number field "answer"`);
    }
    if (!knownTypes.has(q.question_type as string)) {
      throw new Error(
        `LongMemEval dataset invalid: ${label} has unknown question_type ` +
          `"${String(q.question_type)}" — schema drift? Known: ${QUESTION_TYPES.join(', ')}`,
      );
    }
    if (!isStringArray(q.answer_session_ids) || q.answer_session_ids.length === 0) {
      throw new Error(
        `LongMemEval dataset invalid: ${label} lacks non-empty answer_session_ids[]`,
      );
    }
    if (!isStringArray(q.haystack_session_ids) || !Array.isArray(q.haystack_sessions)) {
      throw new Error(`LongMemEval dataset invalid: ${label} lacks haystack arrays`);
    }
    if (q.haystack_session_ids.length !== q.haystack_sessions.length) {
      throw new Error(
        `LongMemEval dataset invalid: ${label} haystack_session_ids (${q.haystack_session_ids.length}) ` +
          `misaligned with haystack_sessions (${q.haystack_sessions.length})`,
      );
    }
    for (const session of q.haystack_sessions) {
      if (!Array.isArray(session)) {
        throw new Error(`LongMemEval dataset invalid: ${label} has a non-array session`);
      }
      for (const turn of session) {
        const t = turn as Partial<LmeTurn>;
        if (typeof t.role !== 'string' || typeof t.content !== 'string') {
          throw new Error(
            `LongMemEval dataset invalid: ${label} has a turn without role/content strings`,
          );
        }
      }
    }
  });
  return data as LmeQuestion[];
}

// ── Abstention + category selection ──────────────────────────────────────────

/**
 * Abstention questions carry a "_abs" question_id SUFFIX (yn7: identified ONLY
 * by suffix, no separate question_type). Excluded from the scoring denominator
 * per official print_retrieval_metrics.py; their haystacks ARE still ingested
 * (keeps the corpus identical to the official full-haystack setup and leaves
 * the door open for a separate abstention metric later).
 */
export function isAbstention(question: { question_id: string }): boolean {
  return question.question_id.endsWith('_abs');
}

/**
 * Select questions by category: a raw question_type, a CATEGORY_GROUPS alias
 * (e.g. "info-extraction"), or undefined = all. Unknown value throws, listing
 * every valid option.
 */
export function filterByCategory(
  questions: LmeQuestion[],
  category: string | undefined,
): LmeQuestion[] {
  if (category === undefined) return questions;
  const groupTypes = CATEGORY_GROUPS[category];
  if (groupTypes !== undefined) {
    const allowed = new Set(groupTypes);
    return questions.filter((q) => allowed.has(q.question_type));
  }
  if ((QUESTION_TYPES as readonly string[]).includes(category)) {
    return questions.filter((q) => q.question_type === category);
  }
  throw new Error(
    `Unknown category "${category}". Valid: ${[
      ...Object.keys(CATEGORY_GROUPS),
      ...QUESTION_TYPES,
    ].join(', ')}`,
  );
}

// ── Session text + unique-session dedup ──────────────────────────────────────

/** Canonical embeddable text of one session: "role: content" blocks. */
export function sessionText(turns: LmeTurn[]): string {
  return turns.map((t) => `${t.role}: ${t.content}`).join('\n\n');
}

/**
 * Collect each unique session ONCE across all selected questions (dedup
 * ingestion — 19 195 unique of 23 867 refs on the full set). Shared session ids
 * are verified content-identical (yn7 confirmed 0 mismatches; a mismatch here
 * means a corrupted dataset → loud abort).
 */
export function collectUniqueSessionTurns(questions: LmeQuestion[]): Map<string, LmeTurn[]> {
  const unique = new Map<string, LmeTurn[]>();
  for (const q of questions) {
    q.haystack_session_ids.forEach((sessionId, i) => {
      const turns = q.haystack_sessions[i]!;
      const existing = unique.get(sessionId);
      if (existing === undefined) {
        unique.set(sessionId, turns);
      } else if (sessionText(existing) !== sessionText(turns)) {
        throw new Error(
          `Session id "${sessionId}" carries DIFFERENT content across questions — ` +
            'dataset corrupted, session-level dedup would be unsound. Aborting.',
        );
      }
    });
  }
  return unique;
}

export function collectUniqueSessions(questions: LmeQuestion[]): Map<string, string> {
  const unique = new Map<string, string>();
  for (const [sessionId, turns] of collectUniqueSessionTurns(questions)) {
    unique.set(sessionId, sessionText(turns));
  }
  return unique;
}

/**
 * Split one session's turns into ROUNDS for round-level granularity seeding.
 * A new round begins at each `user` turn; the round absorbs the following
 * non-user turns up to (not including) the next user turn. Leading non-user
 * turns (a session opening with an assistant turn) form the first round.
 *
 * Universal — assumes NOTHING about strict user/assistant alternation: every
 * turn lands in exactly one round, original order preserved, no turn dropped or
 * duplicated. `concat` of all rounds === the input turns.
 */
export function splitRounds(turns: LmeTurn[]): LmeTurn[][] {
  const rounds: LmeTurn[][] = [];
  let current: LmeTurn[] = [];
  for (const turn of turns) {
    if (turn.role === 'user' && current.length > 0) {
      rounds.push(current);
      current = [];
    }
    current.push(turn);
  }
  if (current.length > 0) rounds.push(current);
  return rounds;
}

// ── Session-id provenance (on every ingested mem) ────────────────────────────
//
// The recall assert contract is session-level, but the v0.4.0 mems schema has
// no metadata column and the library must not change (bead constraint). The
// ONLY on-mem channel is the summary text: a fixed first-line marker carries
// the session id; the session text follows verbatim. The marker is NEVER part
// of the embedded input (embeddings are computed from the raw session text),
// so the embedding space stays uncontaminated.

const PROVENANCE_PREFIX = '[longmemeval session=';
const PROVENANCE_RE = /^\[longmemeval session=([^\]\n ]+)\]\n/;

/** Encode session-id provenance into a mem summary (marker line + text). */
export function encodeProvenance(sessionId: string, text: string): string {
  if (!/^[^\]\n ]+$/.test(sessionId)) {
    throw new Error(
      `Invalid session id "${sessionId}" — must be non-empty without "]", spaces or newlines ` +
        '(would corrupt the provenance marker).',
    );
  }
  return `${PROVENANCE_PREFIX}${sessionId}]\n${text}`;
}

/** Decode the session id from a mem summary; throws on a foreign (marker-less) mem. */
export function decodeProvenance(summary: string): string {
  const match = PROVENANCE_RE.exec(summary);
  if (match === null) {
    throw new Error(
      'Mem summary lacks the longmemeval provenance marker — foreign mem in the ' +
        'benchmark memstore (wrong contextId / polluted store?). Aborting.',
    );
  }
  return match[1]!;
}

// ── Truncation + spend preflight ──────────────────────────────────────────────

/** Cap text at MAX_EMBED_CHARS for embedding; flags when truncation happened. */
export function truncateForEmbedding(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EMBED_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_EMBED_CHARS), truncated: true };
}

function estimateTokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function projectUsd(tokens: number): number {
  return (tokens / 1_000_000) * EMBEDDING_USD_PER_1M_TOKENS;
}

/** Seeding granularity: one mem per whole session, or one mem per round. */
export type Granularity = 'session' | 'round';

export interface Preflight {
  category: string | null;
  granularity: Granularity;
  questionsSelected: number;
  /** Non-abstention questions = the recall_any@K denominator. */
  questionsScored: number;
  uniqueSessions: number;
  /** Embedding inputs = sessions ('session') or rounds ('round'). */
  embedUnits: number;
  /** Embedding inputs truncated at MAX_EMBED_CHARS. */
  truncatedUnits: number;
  sessionChars: number;
  /** Embed inputs (truncated lengths) + scored question texts. */
  estimatedTokens: number;
  projectedUsd: number;
}

/** Embed-input texts for a granularity: whole sessions, or rounds within them. */
function embedTexts(
  sessions: Map<string, LmeTurn[]>,
  granularity: Granularity,
): string[] {
  if (granularity === 'session') {
    return [...sessions.values()].map((turns) => sessionText(turns));
  }
  const texts: string[] = [];
  for (const turns of sessions.values()) {
    for (const round of splitRounds(turns)) texts.push(sessionText(round));
  }
  return texts;
}

/**
 * Spend preflight: project embed-unit count, tokens and USD for a category
 * selection at the given granularity. Pure computation — callers gate spending
 * via assertBudget BEFORE any embedding call.
 */
export function computePreflight(
  questions: LmeQuestion[],
  category: string | undefined,
  granularity: Granularity = 'session',
): Preflight {
  const selected = filterByCategory(questions, category);
  const scored = selected.filter((q) => !isAbstention(q));
  const sessions = collectUniqueSessionTurns(selected);
  const texts = embedTexts(sessions, granularity);

  let sessionChars = 0;
  let cappedChars = 0;
  let truncatedUnits = 0;
  for (const text of texts) {
    sessionChars += text.length;
    cappedChars += Math.min(text.length, MAX_EMBED_CHARS);
    if (text.length > MAX_EMBED_CHARS) truncatedUnits += 1;
  }
  const questionChars = scored.reduce((sum, q) => sum + q.question.length, 0);
  const estimatedTokens =
    estimateTokensForChars(cappedChars) + estimateTokensForChars(questionChars);

  return {
    category: category ?? null,
    granularity,
    questionsSelected: selected.length,
    questionsScored: scored.length,
    uniqueSessions: sessions.size,
    embedUnits: texts.length,
    truncatedUnits,
    sessionChars,
    estimatedTokens,
    projectedUsd: projectUsd(estimatedTokens),
  };
}

/** Loud spend gate: projection over budget (or absurd budget) → abort. */
export function assertBudget(projectedUsd: number, budgetUsd: number): void {
  if (!(budgetUsd > 0)) {
    throw new Error(
      `LLMEMS_BENCH_BUDGET_USD must be a positive budget in USD, got ${budgetUsd}`,
    );
  }
  if (projectedUsd > budgetUsd) {
    throw new Error(
      `SPEND PREFLIGHT FAILED: projected embedding cost $${projectedUsd.toFixed(4)} ` +
        `exceeds budget $${budgetUsd.toFixed(4)} (LLMEMS_BENCH_BUDGET_USD). ` +
        'No embedding call was made. Narrow the --category slice or raise the budget explicitly.',
    );
  }
}

// ── Seed (ingestion) ──────────────────────────────────────────────────────────

export interface SeedPorts {
  /** Embed a batch of session texts; must return one vector per input, in order. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Persist mems (provenance summary + embedding) into the benchmark store. */
  storeMems(mems: { summary: string; embedding: number[] }[]): Promise<void>;
  /** Session ids already present in the store (idempotent re-seed / top-up). */
  existingSessionIds(): Promise<Set<string>>;
}

export interface SeedReport {
  category: string | null;
  uniqueSessions: number;
  alreadyPresent: number;
  embedded: number;
  truncated: number;
  estimatedTokens: number;
  projectedUsd: number;
}

export interface RunSeedOptions {
  questions: LmeQuestion[];
  category?: string;
  budgetUsd: number;
  ports: SeedPorts;
  /** Sessions per embeddings request / store transaction. */
  batchSize?: number;
  log?: (message: string) => void;
}

/**
 * Seed phase: embed every unique session of the selection that is NOT yet in
 * the store, with session-id provenance on every mem. The budget gate runs on
 * the MISSING set only — before the first embedding call — so an interrupted
 * seed resumes cheaply and never double-spends on already-stored sessions.
 */
export async function runSeed(opts: RunSeedOptions): Promise<SeedReport> {
  const { questions, category, budgetUsd, ports } = opts;
  const batchSize = opts.batchSize ?? 64;
  const log = opts.log ?? (() => undefined);

  const selected = filterByCategory(questions, category);
  const unique = collectUniqueSessions(selected);
  const existing = await ports.existingSessionIds();

  const missing: { sessionId: string; embedText: string; fullText: string }[] = [];
  let truncated = 0;
  let missingChars = 0;
  for (const [sessionId, fullText] of unique) {
    if (existing.has(sessionId)) continue;
    const capped = truncateForEmbedding(fullText);
    if (capped.truncated) truncated += 1;
    missingChars += capped.text.length;
    missing.push({ sessionId, embedText: capped.text, fullText });
  }

  const estimatedTokens = estimateTokensForChars(missingChars);
  const projectedUsd = projectUsd(estimatedTokens);
  // SPEND GATE — before ANY embedding call, on the actually-missing set only.
  assertBudget(projectedUsd, budgetUsd);
  log(
    `seed: ${unique.size} unique sessions in selection, ${unique.size - missing.length} present, ` +
      `${missing.length} to embed (~${estimatedTokens} tokens, ~$${projectedUsd.toFixed(4)})`,
  );

  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const batch = missing.slice(offset, offset + batchSize);
    const vectors = await ports.embedBatch(batch.map((s) => s.embedText));
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding batch size mismatch: sent ${batch.length} inputs, got ${vectors.length} vectors`,
      );
    }
    await ports.storeMems(
      batch.map((s, i) => ({
        summary: encodeProvenance(s.sessionId, s.fullText),
        embedding: vectors[i]!,
      })),
    );
    log(`seed: stored ${Math.min(offset + batchSize, missing.length)}/${missing.length}`);
  }

  return {
    category: category ?? null,
    uniqueSessions: unique.size,
    alreadyPresent: unique.size - missing.length,
    embedded: missing.length,
    truncated,
    estimatedTokens,
    projectedUsd,
  };
}

// ── Round-level seed (granularity experiment, bead llmems-3io.11 / B1) ────────

export interface RoundSeedReport {
  category: string | null;
  uniqueSessions: number;
  roundsEmbedded: number;
  truncatedRounds: number;
  estimatedTokens: number;
  projectedUsd: number;
}

export interface RunRoundSeedOptions {
  questions: LmeQuestion[];
  category?: string;
  budgetUsd: number;
  ports: SeedPorts;
  /** Rounds per embeddings request / store transaction. */
  batchSize?: number;
  log?: (message: string) => void;
}

/**
 * Round-level seed: ingest each unique session of the selection as MULTIPLE mems
 * — one per round (see splitRounds) — each carrying the SAME session-id
 * provenance marker, so recall_any@K (which dedups retrieved mems to unique
 * session ids) needs no change. Embedding is computed from the raw round text
 * (marker excluded), capped at MAX_EMBED_CHARS.
 *
 * No idempotent resume: provenance carries only the session id (not a round
 * index), so a partial re-seed cannot be detected per round. The target memstore
 * MUST be empty (a fresh contextId) — a non-empty store aborts loudly. The
 * budget gate runs on the full round set BEFORE the first embedding call.
 */
export async function runRoundSeed(opts: RunRoundSeedOptions): Promise<RoundSeedReport> {
  const { questions, category, budgetUsd, ports } = opts;
  const batchSize = opts.batchSize ?? 64;
  const log = opts.log ?? (() => undefined);

  const existing = await ports.existingSessionIds();
  if (existing.size > 0) {
    throw new Error(
      `ROUND SEED requires an EMPTY target memstore (fresh contextId) — found ${existing.size} ` +
        'sessions already present. Round-level granularity has no idempotent resume (provenance ' +
        'carries only the session id, not a round index). Use a new contextId or truncate the store.',
    );
  }

  const selected = filterByCategory(questions, category);
  const sessions = collectUniqueSessionTurns(selected);

  const units: { sessionId: string; embedText: string; fullText: string }[] = [];
  let truncatedRounds = 0;
  let totalChars = 0;
  for (const [sessionId, turns] of sessions) {
    for (const round of splitRounds(turns)) {
      const fullText = sessionText(round);
      const capped = truncateForEmbedding(fullText);
      if (capped.truncated) truncatedRounds += 1;
      totalChars += capped.text.length;
      units.push({ sessionId, embedText: capped.text, fullText });
    }
  }

  const estimatedTokens = estimateTokensForChars(totalChars);
  const projectedUsd = projectUsd(estimatedTokens);
  assertBudget(projectedUsd, budgetUsd);
  log(
    `round seed: ${sessions.size} unique sessions → ${units.length} rounds to embed ` +
      `(~${estimatedTokens} tokens, ~$${projectedUsd.toFixed(4)})`,
  );

  for (let offset = 0; offset < units.length; offset += batchSize) {
    const batch = units.slice(offset, offset + batchSize);
    const vectors = await ports.embedBatch(batch.map((u) => u.embedText));
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding batch size mismatch: sent ${batch.length} inputs, got ${vectors.length} vectors`,
      );
    }
    await ports.storeMems(
      batch.map((u, i) => ({
        summary: encodeProvenance(u.sessionId, u.fullText),
        embedding: vectors[i]!,
      })),
    );
    log(`round seed: stored ${Math.min(offset + batchSize, units.length)}/${units.length}`);
  }

  return {
    category: category ?? null,
    uniqueSessions: sessions.size,
    roundsEmbedded: units.length,
    truncatedRounds,
    estimatedTokens,
    projectedUsd,
  };
}

// ── Recall (retrieval-only scoring) ───────────────────────────────────────────

export interface RecallPorts {
  /** Embed one question text. */
  embedQuestion(text: string): Promise<number[]>;
  /** Ranked ANN search; returns mems whose summaries carry provenance markers. */
  searchMems(vector: number[], fetchK: number): Promise<{ summary: string }[]>;
  /** All session ids currently in the store (implementation-sanity checks). */
  storedSessionIds(): Promise<Set<string>>;
}

export interface QuestionScore {
  question_id: string;
  question_type: string;
  expected: string[];
  /**
   * Deduped unique-session ranking actually used for scoring, kept to the full
   * fetchK depth (30) so @{10,20,30} stay recomputable offline from the artifact.
   */
  topSessions: string[];
  hitAt5: 0 | 1;
  hitAt10: 0 | 1;
  hitAt20: 0 | 1;
  hitAt30: 0 | 1;
}

export interface RecallScoringResult {
  aggregate: {
    scored: number;
    abstentionExcluded: number;
    /** Primary metric (predeclared): recall_any@10; @5/@20/@30 also recorded. */
    recallAnyAt5: number;
    recallAnyAt10: number;
    recallAnyAt20: number;
    recallAnyAt30: number;
    byCategory: Record<
      string,
      { scored: number; recallAnyAt5: number; recallAnyAt10: number; recallAnyAt20: number; recallAnyAt30: number }
    >;
  };
  sanity: {
    storedSessions: number;
    expectedSessions: number;
    missingEvidenceSessions: string[];
    pass: boolean;
  };
  perQuestion: QuestionScore[];
}

export interface RunRecallScoringOptions {
  questions: LmeQuestion[];
  category?: string;
  budgetUsd: number;
  ports: RecallPorts;
  /** Raw ANN fetch depth before session dedup (defensive headroom over K=10). */
  fetchK?: number;
  log?: (message: string) => void;
}

/**
 * Recall phase: retrieval-only recall_any@{5,10} over non-abstention questions.
 *
 * Implementation-sanity FIRST (broken ingestion must never read as weak
 * memory): every scored question's evidence sessions must exist in the store
 * and the selection's full unique-session set must be present — otherwise
 * abort loudly BEFORE spending on question embeddings.
 */
export async function runRecallScoring(
  opts: RunRecallScoringOptions,
): Promise<RecallScoringResult> {
  const { questions, category, budgetUsd, ports } = opts;
  const fetchK = opts.fetchK ?? 30;
  const log = opts.log ?? (() => undefined);

  const selected = filterByCategory(questions, category);
  const scoredQuestions = selected.filter((q) => !isAbstention(q));
  const expectedSessions = collectUniqueSessions(selected);

  // ── Implementation-sanity gate (Codex: rule out broken ingestion) ──────────
  const stored = await ports.storedSessionIds();
  const missingEvidence = new Set<string>();
  for (const q of scoredQuestions) {
    for (const sessionId of q.answer_session_ids) {
      if (!stored.has(sessionId)) missingEvidence.add(sessionId);
    }
  }
  const missingFromSelection = [...expectedSessions.keys()].filter((id) => !stored.has(id));
  if (missingEvidence.size > 0 || missingFromSelection.length > 0) {
    throw new Error(
      'INGESTION SANITY FAILED — recall would measure a broken store, not weak memory. ' +
        `Evidence sessions missing: [${[...missingEvidence].slice(0, 10).join(', ')}` +
        `${missingEvidence.size > 10 ? ', …' : ''}] (${missingEvidence.size} total); ` +
        `selection sessions missing: ${missingFromSelection.length} of ${expectedSessions.size}. ` +
        'Re-run seed for this selection first.',
    );
  }
  // EXTRA sessions are equally disqualifying: ANN over a larger corpus than the
  // selection is a silently DIFFERENT retrieval condition (e.g. category slice
  // scored against the fully-seeded store). Per-category numbers over the full
  // corpus come from a full recall's byCategory breakdown instead.
  const extraInStore = [...stored].filter((id) => !expectedSessions.has(id));
  if (extraInStore.length > 0) {
    throw new Error(
      `CORPUS CONDITION MISMATCH — store holds ${extraInStore.length} extra sessions beyond the ` +
        `selection (${stored.size} stored vs ${expectedSessions.size} expected): ` +
        `[${extraInStore.slice(0, 5).join(', ')}${extraInStore.length > 5 ? ', …' : ''}]. ` +
        'ANN would search a different corpus than this selection — the metric would not be ' +
        'comparable. Run recall on the selection that matches the seeded corpus ' +
        '(per-category numbers are reported by the full run), or use a fresh store.',
    );
  }
  log(
    `recall sanity: store sessions = selection sessions = ${stored.size}; ` +
      'all evidence sessions present',
  );

  // ── Spend gate for question embeddings ──────────────────────────────────────
  const questionChars = scoredQuestions.reduce((sum, q) => sum + q.question.length, 0);
  assertBudget(projectUsd(estimateTokensForChars(questionChars)), budgetUsd);

  // ── Score ───────────────────────────────────────────────────────────────────
  // Deepest K scored — fetchK must surface at least this many UNIQUE sessions or
  // the deep-K metrics are silently truncated (acute with round granularity:
  // many mems share a session, so raw fetchK rows dedup to fewer sessions).
  const MAX_SCORED_K = 30;
  const perQuestion: QuestionScore[] = [];
  const underfetched: string[] = [];
  for (const q of scoredQuestions) {
    const vector = await ports.embedQuestion(q.question);
    const mems = await ports.searchMems(vector, fetchK);
    const rankedSessionIds = mems.map((m) => decodeProvenance(m.summary));
    const expected = new Set(q.answer_session_ids);

    const seen = new Set<string>();
    const topSessions: string[] = [];
    for (const id of rankedSessionIds) {
      if (!seen.has(id)) {
        seen.add(id);
        topSessions.push(id);
      }
    }

    // Underfetch guard: the ANN LIMIT was saturated (mems.length === fetchK) yet
    // the rows dedup to fewer than MAX_SCORED_K unique sessions — more unique
    // sessions may exist beyond the cap, so @20/@30 could be FALSE misses.
    // (Not saturated ⇒ the store returned everything in range ⇒ metric exact.)
    if (mems.length >= fetchK && topSessions.length < MAX_SCORED_K) {
      underfetched.push(q.question_id);
    }

    perQuestion.push({
      question_id: q.question_id,
      question_type: q.question_type,
      expected: q.answer_session_ids,
      // Persist exactly the depth the metrics need — bounded regardless of fetchK.
      topSessions: topSessions.slice(0, MAX_SCORED_K),
      hitAt5: recallAnyAtK(rankedSessionIds, expected, 5),
      hitAt10: recallAnyAtK(rankedSessionIds, expected, 10),
      hitAt20: recallAnyAtK(rankedSessionIds, expected, 20),
      hitAt30: recallAnyAtK(rankedSessionIds, expected, 30),
    });
  }

  if (underfetched.length > 0) {
    throw new Error(
      `RECALL FETCH-K TOO SMALL — ${underfetched.length} question(s) saturated the ANN limit ` +
        `(fetchK=${fetchK}) but yielded fewer than ${MAX_SCORED_K} unique sessions after dedup, so ` +
        `recall_any@20/@30 would be falsely truncated (e.g. ${underfetched.slice(0, 5).join(', ')}` +
        `${underfetched.length > 5 ? ', …' : ''}). Raise --fetch-k (round granularity packs many ` +
        'mems per session — use a generous depth, e.g. 500).',
    );
  }

  const byCategory: RecallScoringResult['aggregate']['byCategory'] = {};
  for (const score of perQuestion) {
    const bucket = (byCategory[score.question_type] ??= {
      scored: 0,
      recallAnyAt5: 0,
      recallAnyAt10: 0,
      recallAnyAt20: 0,
      recallAnyAt30: 0,
    });
    bucket.scored += 1;
    bucket.recallAnyAt5 += score.hitAt5;
    bucket.recallAnyAt10 += score.hitAt10;
    bucket.recallAnyAt20 += score.hitAt20;
    bucket.recallAnyAt30 += score.hitAt30;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.recallAnyAt5 /= bucket.scored;
    bucket.recallAnyAt10 /= bucket.scored;
    bucket.recallAnyAt20 /= bucket.scored;
    bucket.recallAnyAt30 /= bucket.scored;
  }

  const scored = perQuestion.length;
  return {
    aggregate: {
      scored,
      abstentionExcluded: selected.length - scored,
      recallAnyAt5: scored === 0 ? 0 : perQuestion.reduce((s, x) => s + x.hitAt5, 0) / scored,
      recallAnyAt10: scored === 0 ? 0 : perQuestion.reduce((s, x) => s + x.hitAt10, 0) / scored,
      recallAnyAt20: scored === 0 ? 0 : perQuestion.reduce((s, x) => s + x.hitAt20, 0) / scored,
      recallAnyAt30: scored === 0 ? 0 : perQuestion.reduce((s, x) => s + x.hitAt30, 0) / scored,
      byCategory,
    },
    sanity: {
      storedSessions: stored.size,
      expectedSessions: expectedSessions.size,
      missingEvidenceSessions: [],
      pass: true,
    },
    perQuestion,
  };
}
