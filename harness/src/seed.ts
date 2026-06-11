/**
 * Seed phase (plan v2, step 5; D15/D16).
 *
 * Feeds the Russian fixture through the time-boxed turn pipeline, then BLOCKS
 * until the BackgroundIndexer has digested chunks→mems for THIS run's contextId
 * (poll via the library's own getClosedMems — no raw SQL). Bounded timeout
 * fails loudly; run state is written ONLY after the poll succeeds, so the
 * process-restart boundary is always post-indexing (Codex C2).
 */
import type { HarnessLogger } from './logger.js';
import { runTurn, type FactoryLike } from './turn-pipeline.js';
import type { RunScope } from './run-scope.js';

export interface MemStoreLike {
  getClosedMems(contextId: string, limit?: number): Promise<unknown[]>;
}

export interface RunState {
  contextId: string;
  sessionId: string;
  nonce: string;
  seededAt: string;
  memCount: number;
  turns: number;
  degradedTurns: number;
}

export interface SeedConfig {
  criticalTimeoutMs: number;
  maxContextChars: number;
  seedPollTimeoutMs: number;
  seedPollIntervalMs: number;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  logger: HarnessLogger;
}

export async function waitForMems(
  store: MemStoreLike,
  contextId: string,
  opts: WaitOptions,
): Promise<number> {
  const now = opts.now ?? Date.now;
  const start = now();
  for (;;) {
    const mems = await store.getClosedMems(contextId);
    const waitedMs = now() - start;
    if (mems.length > 0) {
      opts.logger.event('harness.seed_poll', {
        contextId, mems: mems.length, waitedMs, status: 'ok',
      });
      return mems.length;
    }
    if (waitedMs >= opts.timeoutMs) {
      opts.logger.event('harness.seed_poll', {
        contextId, mems: 0, waitedMs, status: 'timeout',
      });
      throw new Error(
        `SEED FAILED: no mem rows for contextId=${contextId} after ${opts.timeoutMs}ms — ` +
          'BackgroundIndexer did not digest chunks into mems. ' +
          'Check llmems.* logs, LiteLLM availability and the scoped key budget. ' +
          'Run state was NOT written; recall must not be attempted for this run.',
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}

export interface RunSeedOptions {
  factory: FactoryLike;
  store: MemStoreLike;
  logger: HarnessLogger;
  scope: RunScope;
  fixture: string[];
  config: SeedConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  writeState: (state: RunState) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSeed(opts: RunSeedOptions): Promise<RunState> {
  const { factory, store, logger, scope, fixture, config } = opts;
  let degradedTurns = 0;

  for (const [index, fragment] of fixture.entries()) {
    const result = await runTurn({
      factory, logger,
      sessionId: scope.sessionId,
      contextId: scope.contextId,
      fragment,
      turn: index + 1,
      timeoutMs: config.criticalTimeoutMs,
      maxContextChars: config.maxContextChars,
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (result.degraded) degradedTurns += 1;
  }

  const memCount = await waitForMems(store, scope.contextId, {
    timeoutMs: config.seedPollTimeoutMs,
    intervalMs: config.seedPollIntervalMs,
    sleep: opts.sleep ?? defaultSleep,
    ...(opts.now ? { now: opts.now } : {}),
    logger,
  });

  const state: RunState = {
    contextId: scope.contextId,
    sessionId: scope.sessionId,
    nonce: scope.nonce,
    seededAt: new Date().toISOString(),
    memCount,
    turns: fixture.length,
    degradedTurns,
  };
  await opts.writeState(state);

  logger.event('harness.seed_done', {
    contextId: scope.contextId,
    turns: fixture.length,
    memCount,
    degradedTurns,
  });
  return state;
}
