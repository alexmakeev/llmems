/**
 * Time-boxed, size-capped, error-isolated turn pipeline (plan v2, D2/D7/D4).
 *
 * This wrapper IS the consumer pattern being prototyped: any future llmems
 * consumer protects its critical path the same way —
 *   remember + getLongTermContext raced against LLMEMS_CRITICAL_TIMEOUT_MS,
 *   degrade-to-empty on timeout/error (never break the caller),
 *   hard char cap on the injected context (keep prefix = backbone first),
 *   every swallowed failure surfaces as a structured llmems.* log event.
 */
import type { HarnessLogger } from './logger.js';

/** Structural subset of ContextFactory the pipeline needs (eases offline mocking). */
export interface FactoryLike {
  remember(sessionId: string, fragment: string, contextId: string): Promise<void>;
  getLongTermContext(sessionId: string): Promise<string>;
}

export interface TurnResult {
  /** Long-term context to inject ('' when degraded). */
  context: string;
  /** True when the turn fell back to empty context (timeout or error). */
  degraded: boolean;
  /** Present when degradation was caused by a thrown error. */
  error?: string;
  /** Wall-clock duration of the turn's llmems critical path. */
  latencyMs: number;
  /** True when the context was cut to maxContextChars. */
  truncated: boolean;
}

export interface RunTurnOptions {
  factory: FactoryLike;
  logger: HarnessLogger;
  sessionId: string;
  contextId: string;
  fragment: string;
  /** 1-based turn number for log correlation. */
  turn: number;
  timeoutMs: number;
  maxContextChars: number;
  /** Injectable clock for deterministic latency in tests. */
  now?: () => number;
}

type WorkOutcome = { ok: string } | { err: string };

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const now = opts.now ?? Date.now;
  const { factory, logger, sessionId, contextId, fragment, turn } = opts;
  const start = now();

  // Both arms map to a value: `work` never rejects, so a post-timeout settle
  // can always be observed without unhandled-rejection noise.
  const work: Promise<WorkOutcome> = (async () => {
    await factory.remember(sessionId, fragment, contextId);
    return { ok: await factory.getLongTermContext(sessionId) };
  })().then(
    (v) => v,
    (e: unknown) => ({ err: e instanceof Error ? e.message : String(e) }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
  });

  const raced = await Promise.race([work, timeout]);

  if (raced === 'timeout') {
    const latencyMs = now() - start;
    logger.event('llmems.timeout_degraded', {
      contextId, turn, timeoutMs: opts.timeoutMs, latencyMs,
    });
    void work.then((outcome) => {
      logger.event('llmems.late_settle', {
        contextId, turn, latencyMs: now() - start,
        outcome: 'ok' in outcome ? 'resolved' : 'rejected',
        ...('err' in outcome ? { error: outcome.err } : {}),
      });
    });
    return { context: '', degraded: true, latencyMs, truncated: false };
  }

  clearTimeout(timer);
  const latencyMs = now() - start;

  if ('err' in raced) {
    logger.event('llmems.error', { contextId, turn, error: raced.err, latencyMs });
    return { context: '', degraded: true, error: raced.err, latencyMs, truncated: false };
  }

  let context = raced.ok;
  let truncated = false;
  if (context.length > opts.maxContextChars) {
    logger.event('llmems.context_truncated', {
      contextId, turn,
      originalChars: context.length,
      maxContextChars: opts.maxContextChars,
    });
    // Keep the prefix: getLongTermContext serializes backbone before dynamic,
    // so prefix-keep drops from the dynamic tail (D7).
    context = context.slice(0, opts.maxContextChars);
    truncated = true;
  }

  logger.event('llmems.context_injected', {
    contextId, turn, chars: context.length, latencyMs, truncated,
  });
  return { context, degraded: false, latencyMs, truncated };
}
