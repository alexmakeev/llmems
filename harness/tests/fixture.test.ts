import { describe, it, expect } from 'vitest';
import {
  buildFixture,
  RECALL_PROBE,
  countNonceMatches,
  assertPlantedFacts,
} from '../src/fixture.js';

const NONCE = 'шифр-равемило-1234';

describe('Russian planted-fact fixture (D12/D15/D16)', () => {
  it('has at least 16 turns to meet the default indexThreshold (D16)', () => {
    expect(buildFixture(NONCE).length).toBeGreaterThanOrEqual(16);
  });

  it('is Russian text (every turn contains Cyrillic)', () => {
    for (const turn of buildFixture(NONCE)) {
      expect(turn).toMatch(/[а-яА-ЯёЁ]/u);
    }
  });

  it('plants the nonce in at least two distinct turns (D15)', () => {
    const turns = buildFixture(NONCE).filter((t) => t.includes(NONCE));
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it('recall probe does NOT contain the nonce (recall must come from memory)', () => {
    expect(RECALL_PROBE.includes(NONCE)).toBe(false);
    expect(RECALL_PROBE).toMatch(/[а-яА-ЯёЁ]/u);
  });

  it('countNonceMatches counts exact nonce occurrences', () => {
    expect(countNonceMatches(`код ${NONCE} и ещё раз ${NONCE}`, NONCE)).toBe(2);
    expect(countNonceMatches('никакого кода здесь нет', NONCE)).toBe(0);
  });

  it('assertPlantedFacts: hit when nonce present', () => {
    expect(assertPlantedFacts(`Загружено из памяти: проект ${NONCE}`, NONCE)).toBe(true);
  });

  it('assertPlantedFacts: miss when nonce absent (stale-mems immunity, D15)', () => {
    const staleNonce = 'шифр-стармемов-9999';
    expect(assertPlantedFacts(`Загружено из памяти: проект ${staleNonce}`, NONCE)).toBe(false);
  });
});
