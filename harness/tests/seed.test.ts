import { describe, it, expect, vi } from 'vitest';
import { waitForMems, runSeed, type RunState } from '../src/seed.js';
import { HarnessLogger, type LogEntry } from '../src/logger.js';
import { buildFixture } from '../src/fixture.js';

function captureLogger(): { logger: HarnessLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = new HarnessLogger({ write: (e) => entries.push(e) });
  return { logger, entries };
}

const SCOPE = {
  contextId: 'smoke-20260611120000-abc123',
  sessionId: 'smoke-20260611120000-abc123',
  nonce: 'шифр-равемило-1234',
};

const memWithNonce = { summary: `Кодовое имя стенда — «сирень-${SCOPE.nonce}», главный факт темы.` };
const memWithoutNonce = { summary: 'Обсуждение отпуска на Алтае: Чемал и Телецкое озеро.' };

describe('waitForMems (D16 + D12-rev §5: nonce-bearing mem predicate)', () => {
  it('resolves once a mem whose summary CONTAINS the nonce appears', async () => {
    const { logger } = captureLogger();
    let polls = 0;
    const store = {
      getClosedMems: vi.fn(async () =>
        ++polls >= 3 ? [memWithoutNonce, memWithNonce] : [],
      ),
    };
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => void (clock += ms));

    const count = await waitForMems(store, SCOPE.contextId, SCOPE.nonce, {
      timeoutMs: 60000, intervalMs: 1000, sleep, now: () => clock, logger,
    });

    expect(count).toBe(2);
    expect(store.getClosedMems).toHaveBeenCalledTimes(3);
  });

  it('keeps polling when mems exist but NONE carries the nonce (stale/foreign mems)', async () => {
    const { logger, entries } = captureLogger();
    const store = { getClosedMems: vi.fn(async () => [memWithoutNonce]) };
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => void (clock += ms));

    await expect(
      waitForMems(store, SCOPE.contextId, SCOPE.nonce, {
        timeoutMs: 5000, intervalMs: 1000, sleep, now: () => clock, logger,
      }),
    ).rejects.toThrowError(new RegExp(SCOPE.contextId));

    expect(store.getClosedMems.mock.calls.length).toBeGreaterThan(1);
    const poll = entries.filter((e) => e.event === 'harness.seed_poll');
    expect(poll.at(-1)?.fields['status']).toBe('timeout');
    // diagnostics distinguish "no mems at all" from "mems without nonce"
    expect(poll.at(-1)?.fields['mems']).toBe(1);
    expect(poll.at(-1)?.fields['nonceMems']).toBe(0);
  });

  it('times out LOUDLY with contextId in message when no mems appear at all', async () => {
    const { logger, entries } = captureLogger();
    const store = { getClosedMems: vi.fn(async () => []) };
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => void (clock += ms));

    await expect(
      waitForMems(store, SCOPE.contextId, SCOPE.nonce, {
        timeoutMs: 5000, intervalMs: 1000, sleep, now: () => clock, logger,
      }),
    ).rejects.toThrowError(new RegExp(SCOPE.contextId));

    const poll = entries.filter((e) => e.event === 'harness.seed_poll');
    expect(poll.at(-1)?.fields['status']).toBe('timeout');
  });
});

describe('runSeed', () => {
  function deps() {
    const { logger, entries } = captureLogger();
    const factory = {
      remember: vi.fn(async () => undefined),
      getLongTermContext: vi.fn(async () => 'контекст'),
    };
    const store = { getClosedMems: vi.fn(async () => [memWithNonce]) };
    const written: RunState[] = [];
    return {
      logger, entries, factory, store, written,
      config: {
        criticalTimeoutMs: 1500, maxContextChars: 12000,
        seedPollTimeoutMs: 60000, seedPollIntervalMs: 1000,
      },
      sleep: vi.fn(async () => undefined),
      writeState: vi.fn(async (s: RunState) => void written.push(s)),
    };
  }

  it('runs one turn per fixture line, polls nonce-bearing mems, then writes run state', async () => {
    const d = deps();
    const fixture = buildFixture(SCOPE.nonce);

    const state = await runSeed({
      factory: d.factory, store: d.store, logger: d.logger, scope: SCOPE,
      fixture, config: d.config, sleep: d.sleep, writeState: d.writeState,
    });

    expect(d.factory.remember).toHaveBeenCalledTimes(fixture.length);
    expect(d.store.getClosedMems).toHaveBeenCalled();
    expect(d.written).toHaveLength(1);
    expect(state.contextId).toBe(SCOPE.contextId);
    expect(state.nonce).toBe(SCOPE.nonce);
    expect(state.memCount).toBe(1);
    expect(state.turns).toBe(fixture.length);
    expect(d.entries.some((e) => e.event === 'harness.seed_done')).toBe(true);
  });

  it('does NOT write run state when the poll never sees a nonce-bearing mem', async () => {
    const d = deps();
    d.store.getClosedMems = vi.fn(async () => [memWithoutNonce]);
    const fixture = buildFixture(SCOPE.nonce);

    await expect(
      runSeed({
        factory: d.factory, store: d.store, logger: d.logger, scope: SCOPE,
        fixture, config: { ...d.config, seedPollTimeoutMs: 3000 },
        sleep: d.sleep, writeState: d.writeState,
      }),
    ).rejects.toThrowError();

    expect(d.written).toHaveLength(0);
  });

  it('counts degraded turns but continues seeding', async () => {
    const d = deps();
    let call = 0;
    d.factory.remember = vi.fn(async () => {
      if (++call === 2) throw new Error('временный сбой');
    });
    const fixture = buildFixture(SCOPE.nonce);

    const state = await runSeed({
      factory: d.factory, store: d.store, logger: d.logger, scope: SCOPE,
      fixture, config: d.config, sleep: d.sleep, writeState: d.writeState,
    });

    expect(state.degradedTurns).toBe(1);
    expect(d.factory.remember).toHaveBeenCalledTimes(fixture.length);
  });
});
