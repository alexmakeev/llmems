import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTurn } from '../src/turn-pipeline.js';
import { HarnessLogger, type LogEntry } from '../src/logger.js';

function captureLogger(): { logger: HarnessLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = new HarnessLogger({ write: (e) => entries.push(e) });
  return { logger, entries };
}

function makeFactory(opts: {
  rememberMs?: number;
  context?: string;
  rememberError?: Error;
  contextError?: Error;
}) {
  return {
    remember: vi.fn(async () => {
      if (opts.rememberMs) await new Promise((r) => setTimeout(r, opts.rememberMs));
      if (opts.rememberError) throw opts.rememberError;
    }),
    getLongTermContext: vi.fn(async () => {
      if (opts.contextError) throw opts.contextError;
      return opts.context ?? '';
    }),
  };
}

const BASE = { sessionId: 's1', contextId: 's1', fragment: 'фрагмент', turn: 1 };

describe('runTurn', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('happy path: returns context, logs llmems.context_injected with latencyMs', async () => {
    const { logger, entries } = captureLogger();
    const factory = makeFactory({ context: 'воспоминания' });

    const result = await runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000,
    });

    expect(result.context).toBe('воспоминания');
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
    const injected = entries.find((e) => e.event === 'llmems.context_injected');
    expect(injected).toBeDefined();
    expect(typeof injected?.fields['latencyMs']).toBe('number');
    expect(injected?.fields['chars']).toBe('воспоминания'.length);
  });

  it('timeout: degrades to empty context and logs llmems.timeout_degraded', async () => {
    const { logger, entries } = captureLogger();
    const factory = makeFactory({ rememberMs: 5000, context: 'слишком поздно' });

    const promise = runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000,
    });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result.context).toBe('');
    expect(result.degraded).toBe(true);
    expect(entries.some((e) => e.event === 'llmems.timeout_degraded')).toBe(true);
    expect(entries.some((e) => e.event === 'llmems.context_injected')).toBe(false);
  });

  it('late settle after timeout (resolve) logs llmems.late_settle', async () => {
    const { logger, entries } = captureLogger();
    const factory = makeFactory({ rememberMs: 5000, context: 'поздний результат' });

    const promise = runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    expect(entries.some((e) => e.event === 'llmems.late_settle')).toBe(false);

    await vi.advanceTimersByTimeAsync(3500);
    const settle = entries.find((e) => e.event === 'llmems.late_settle');
    expect(settle).toBeDefined();
    expect(settle?.fields['outcome']).toBe('resolved');
  });

  it('late settle after timeout (reject) logs llmems.late_settle with error', async () => {
    const { logger, entries } = captureLogger();
    const factory = {
      remember: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error('поздний сбой')), 5000),
          ),
      ),
      getLongTermContext: vi.fn(async () => ''),
    };

    const promise = runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    await vi.advanceTimersByTimeAsync(3500);

    const settle = entries.find((e) => e.event === 'llmems.late_settle');
    expect(settle).toBeDefined();
    expect(settle?.fields['outcome']).toBe('rejected');
    expect(String(settle?.fields['error'])).toContain('поздний сбой');
  });

  it('remember throws before timeout: degrades and logs llmems.error', async () => {
    const { logger, entries } = captureLogger();
    const factory = makeFactory({ rememberError: new Error('сбой эмбеддинга') });

    const result = await runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000,
    });

    expect(result.context).toBe('');
    expect(result.degraded).toBe(true);
    const err = entries.find((e) => e.event === 'llmems.error');
    expect(err).toBeDefined();
    expect(String(err?.fields['error'])).toContain('сбой эмбеддинга');
  });

  it('getLongTermContext throws: degrades and logs llmems.error', async () => {
    const { logger, entries } = captureLogger();
    const factory = makeFactory({ contextError: new Error('сбой проекции') });

    const result = await runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000,
    });

    expect(result.context).toBe('');
    expect(result.degraded).toBe(true);
    expect(entries.some((e) => e.event === 'llmems.error')).toBe(true);
  });

  it('over-cap context: truncates keeping prefix and logs llmems.context_truncated', async () => {
    const { logger, entries } = captureLogger();
    const long = 'П'.repeat(50) + 'Х'.repeat(100);
    const factory = makeFactory({ context: long });

    const result = await runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 50,
    });

    expect(result.truncated).toBe(true);
    expect(result.context).toBe('П'.repeat(50));
    const trunc = entries.find((e) => e.event === 'llmems.context_truncated');
    expect(trunc).toBeDefined();
    expect(trunc?.fields['originalChars']).toBe(150);
  });

  it('records per-turn latency from injected clock', async () => {
    const { logger } = captureLogger();
    const factory = makeFactory({ context: 'ctx' });
    let t = 1000;
    const now = () => (t += 250);

    const result = await runTurn({
      ...BASE, factory, logger, timeoutMs: 1500, maxContextChars: 12000, now,
    });

    expect(result.latencyMs).toBeGreaterThan(0);
  });
});
