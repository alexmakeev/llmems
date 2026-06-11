/**
 * Harness-local structured logger.
 *
 * Carries the `llmems.*` event taxonomy that is the observability CONTRACT for
 * future consumers (plan v2, D4):
 *   llmems.error, llmems.context_injected, llmems.timeout_degraded,
 *   llmems.late_settle, llmems.context_truncated
 * plus harness-internal events under the `harness.*` namespace
 * (seed_poll, seed_done, recall_result) that are NOT part of the contract.
 */

export type HarnessEventName =
  | 'llmems.error'
  | 'llmems.context_injected'
  | 'llmems.timeout_degraded'
  | 'llmems.late_settle'
  | 'llmems.context_truncated'
  | 'harness.seed_poll'
  | 'harness.seed_done'
  | 'harness.recall_result';

export interface LogEntry {
  event: HarnessEventName;
  fields: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

const stdoutSink: LogSink = {
  write(entry: LogEntry): void {
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), event: entry.event, ...entry.fields })}\n`,
    );
  },
};

export class HarnessLogger {
  private readonly sink: LogSink;

  constructor(sink: LogSink = stdoutSink) {
    this.sink = sink;
  }

  event(event: HarnessEventName, fields: Record<string, unknown>): void {
    this.sink.write({ event, fields });
  }
}
