import { describe, it, expect, vi } from 'vitest';
import { runRecall } from '../src/recall.js';
import { RECALL_PROBE } from '../src/fixture.js';
import { HarnessLogger, type LogEntry } from '../src/logger.js';

function captureLogger(): { logger: HarnessLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = new HarnessLogger({ write: (e) => entries.push(e) });
  return { logger, entries };
}

const STATE = {
  contextId: 'smoke-20260611120000-abc123',
  sessionId: 'smoke-20260611120000-abc123',
  nonce: 'шифр-равемило-1234',
  seededAt: '2026-06-11T12:00:00.000Z',
  memCount: 3,
  turns: 20,
  degradedTurns: 0,
};

const CFG = { criticalTimeoutMs: 1500, maxContextChars: 12000 };

describe('runRecall (planted-fact assertion, D12/D15)', () => {
  it('PASS when recalled context contains the run nonce', async () => {
    const { logger, entries } = captureLogger();
    const factory = {
      remember: vi.fn(async () => undefined),
      getLongTermContext: vi.fn(
        async () => `Загружено из памяти: код проекта ${STATE.nonce}.`,
      ),
    };

    const report = await runRecall({ factory, logger, state: STATE, config: CFG });

    expect(report.pass).toBe(true);
    expect(report.matches).toBe(1);
    expect(factory.remember).toHaveBeenCalledWith(
      STATE.sessionId, RECALL_PROBE, STATE.contextId,
    );
    const res = entries.find((e) => e.event === 'harness.recall_result');
    expect(res?.fields['pass']).toBe(true);
  });

  it('FAIL when context contains only a stale nonce from another run (D15)', async () => {
    const { logger } = captureLogger();
    const factory = {
      remember: vi.fn(async () => undefined),
      getLongTermContext: vi.fn(
        async () => 'Загружено из памяти: код проекта шифр-старойруны-9999.',
      ),
    };

    const report = await runRecall({ factory, logger, state: STATE, config: CFG });

    expect(report.pass).toBe(false);
    expect(report.matches).toBe(0);
  });

  it('FAIL when the recall turn degrades (timeout/error)', async () => {
    const { logger } = captureLogger();
    const factory = {
      remember: vi.fn(async () => {
        throw new Error('сбой');
      }),
      getLongTermContext: vi.fn(async () => `${STATE.nonce}`),
    };

    const report = await runRecall({ factory, logger, state: STATE, config: CFG });

    expect(report.pass).toBe(false);
    expect(report.degraded).toBe(true);
  });

  it('report carries context size and latency for the .9 report', async () => {
    const { logger } = captureLogger();
    const ctx = `что-то ${STATE.nonce} ещё`;
    const factory = {
      remember: vi.fn(async () => undefined),
      getLongTermContext: vi.fn(async () => ctx),
    };

    const report = await runRecall({ factory, logger, state: STATE, config: CFG });

    expect(report.contextChars).toBe(ctx.length);
    expect(typeof report.latencyMs).toBe('number');
    expect(report.context).toBe(ctx);
  });
});
