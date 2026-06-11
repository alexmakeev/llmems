/**
 * Recall phase (plan v2, step 5; D12/D15).
 *
 * Runs in a FRESH process after seed: one probe turn (nonce-free) through the
 * same time-boxed pipeline; remember() re-runs ANN against Postgres and reloads
 * this run's mems (Discovery E4); the assert then matches THE run nonce —
 * deterministic, stale-mems-immune, no LLM judge.
 */
import type { HarnessLogger } from './logger.js';
import { runTurn, type FactoryLike } from './turn-pipeline.js';
import { RECALL_PROBE, countNonceMatches } from './fixture.js';
import type { RunState } from './seed.js';

export interface RecallConfig {
  criticalTimeoutMs: number;
  maxContextChars: number;
}

export interface RecallReport {
  pass: boolean;
  matches: number;
  contextChars: number;
  latencyMs: number;
  degraded: boolean;
  /** Full recalled context — attached to the .9 report for human review (D12). */
  context: string;
}

export interface RunRecallOptions {
  factory: FactoryLike;
  logger: HarnessLogger;
  state: RunState;
  config: RecallConfig;
  probe?: string;
  now?: () => number;
}

export async function runRecall(opts: RunRecallOptions): Promise<RecallReport> {
  const { factory, logger, state, config } = opts;

  const turn = await runTurn({
    factory, logger,
    sessionId: state.sessionId,
    contextId: state.contextId,
    fragment: opts.probe ?? RECALL_PROBE,
    turn: 1,
    timeoutMs: config.criticalTimeoutMs,
    maxContextChars: config.maxContextChars,
    ...(opts.now ? { now: opts.now } : {}),
  });

  const matches = countNonceMatches(turn.context, state.nonce);
  const pass = matches >= 1 && !turn.degraded;

  logger.event('harness.recall_result', {
    contextId: state.contextId,
    pass,
    matches,
    chars: turn.context.length,
    latencyMs: turn.latencyMs,
    degraded: turn.degraded,
  });

  return {
    pass,
    matches,
    contextChars: turn.context.length,
    latencyMs: turn.latencyMs,
    degraded: turn.degraded,
    context: turn.context,
  };
}
