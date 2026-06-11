import { describe, it, expect } from 'vitest';
import {
  buildFixture,
  buildFixtureBlocks,
  RECALL_PROBE,
  countNonceMatches,
  assertPlantedFacts,
} from '../src/fixture.js';

const NONCE = 'шифр-равемило-1234';

describe('Russian planted-fact fixture (D12-rev: coherent thematic blocks)', () => {
  it('has at least 16 turns to meet the default indexThreshold (D16)', () => {
    expect(buildFixture(NONCE).length).toBeGreaterThanOrEqual(16);
  });

  it('is Russian text (every turn contains Cyrillic)', () => {
    for (const turn of buildFixture(NONCE)) {
      expect(turn).toMatch(/[а-яА-ЯёЁ]/u);
    }
  });

  it('consists of 4 coherent blocks of 5-6 turns each (D12-rev §1)', () => {
    const blocks = buildFixtureBlocks(NONCE);
    expect(blocks).toHaveLength(4);
    for (const block of blocks) {
      expect(block.length).toBeGreaterThanOrEqual(5);
      expect(block.length).toBeLessThanOrEqual(6);
    }
    expect(buildFixture(NONCE)).toEqual(blocks.flat());
  });

  it('plants the nonce in >=2 turns of block 1 and ONLY in block 1 (D12-rev §2)', () => {
    const blocks = buildFixtureBlocks(NONCE);
    const inBlock1 = blocks[0]!.filter((t) => t.includes(NONCE));
    expect(inBlock1.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks.slice(1)) {
      for (const turn of block) {
        expect(turn.includes(NONCE)).toBe(false);
      }
    }
  });

  it('blocks 2-4 open with an explicit topic transition (D12-rev §3)', () => {
    const blocks = buildFixtureBlocks(NONCE);
    for (const block of blocks.slice(1)) {
      // explicit "moving on" marker: «давай теперь / теперь давай / перейдём / сменим тему»
      expect(block[0]).toMatch(/давай теперь|теперь давай|перейд[ёе]м|смен[ии]м тему/iu);
    }
  });

  it('indexThreshold trigger point (turn 16) lands after >=2 topic switches (D12-rev §4)', () => {
    const blocks = buildFixtureBlocks(NONCE);
    const block1End = blocks[0]!.length;
    const block2End = block1End + blocks[1]!.length;
    // by turn 16 blocks 1 AND 2 are fully complete and block 3 is underway:
    // the first indexing run sees two topic switches, block 1 fully stale
    expect(block2End).toBeLessThan(16);
  });

  it('recall probe asks about the block-1 topic WITHOUT the nonce (D12-rev §6)', () => {
    expect(RECALL_PROBE.includes(NONCE)).toBe(false);
    expect(RECALL_PROBE).toMatch(/[а-яА-ЯёЁ]/u);
    // probe references the block-1 topic (test-stand codename) so ANN recall lands on it
    expect(RECALL_PROBE).toMatch(/кодов|стенд/iu);
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
