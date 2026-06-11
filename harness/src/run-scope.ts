/**
 * Run-scoped identifiers (plan v2, D1/D15 — Codex C1 stale-mems immunity).
 *
 * Every smoke run gets a FRESH contextId (= sessionId, D1) shared only by that
 * run's seed→recall pair, plus a unique Russian nonce planted into the fixture.
 * The recall assert matches the nonce — mems left in the long-lived stand DB by
 * prior runs cannot satisfy it.
 */

export interface RunScope {
  contextId: string;
  sessionId: string;
  nonce: string;
}

const SYLLABLES = [
  'ра', 'ве', 'ми', 'ло', 'ту', 'за', 'ки', 'но',
  'со', 'ле', 'ды', 'пу', 'же', 'ня', 'го', 'ши',
];

const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function makeRunScope(
  rand: () => number = Math.random,
  clock: () => number = Date.now,
): RunScope {
  const pick = (alphabet: readonly string[], n: number): string =>
    Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');

  // 4 syllables = 8 Cyrillic letters; 4 digits — matches /^шифр-[а-яё]{8}-\d{4}$/u
  const nonce = `шифр-${pick(SYLLABLES, 4)}-${pick([...'0123456789'], 4)}`;

  const stamp = new Date(clock())
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14); // yyyymmddhhmmss

  const contextId = `smoke-${stamp}-${pick([...BASE36], 6)}`;

  return { contextId, sessionId: contextId, nonce };
}
