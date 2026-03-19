/**
 * Test Logger Utilities
 * Captures log entries for test assertions.
 */

import pino from 'pino';
import type { LogEntry, LogLevel } from './types.ts';

/**
 * Test helper that captures log entries for assertions.
 * Creates a Pino logger that writes to an in-memory buffer.
 *
 * @example
 * const capture = new TestLogCapture();
 * setBasePino(capture.getPinoLogger());
 *
 * const log = createLogger('Test');
 * log.info('test message');
 *
 * capture.assertContains({ msg: 'test message' });
 * capture.assertPath('section.subsection');
 */
export class TestLogCapture {
  private logs: LogEntry[] = [];
  private logger: pino.Logger;

  constructor() {
    // Create a Pino logger that writes to our in-memory buffer
    this.logger = pino(
      {
        level: 'trace', // Capture everything in tests
      },
      {
        write: (chunk: string) => {
          try {
            const parsed = JSON.parse(chunk);
            // Convert Pino's output format to our LogEntry format
            const entry: LogEntry = {
              ...parsed,
              level: this.pinoLevelToLogLevel(parsed.level),
              msg: parsed.msg,
              timestamp: parsed.time,
            };
            this.logs.push(entry);
          } catch {
            // Non-JSON output -- ignore
          }
        },
      }
    );
  }

  /**
   * Convert Pino's numeric level to LogLevel string.
   */
  private pinoLevelToLogLevel(level: number): LogLevel {
    // Pino levels: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
    if (level <= 10) return 'trace';
    if (level <= 20) return 'debug';
    if (level <= 30) return 'info';
    if (level <= 40) return 'warn';
    if (level <= 50) return 'error';
    return 'fatal';
  }

  /**
   * Get the underlying Pino logger for createLogger to use in tests.
   */
  getPinoLogger(): pino.Logger {
    return this.logger;
  }

  /**
   * Clear all captured logs.
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Get all captured logs.
   */
  getLogs(): LogEntry[] {
    return this.logs;
  }

  /**
   * Assert that a log entry matching the criteria exists.
   * Throws if no match is found.
   *
   * @param criteria - Partial log entry to match
   * @returns The matching log entry
   *
   * @example
   * capture.assertContains({ level: 'info', msg: 'task started' });
   */
  assertContains(criteria: Partial<LogEntry>): LogEntry {
    const match = this.logs.find(entry => {
      return Object.entries(criteria).every(([key, value]) => {
        return entry[key as keyof LogEntry] === value;
      });
    });

    if (!match) {
      throw new Error(
        `No log entry found matching criteria: ${JSON.stringify(criteria)}. ` +
        `Available logs: ${JSON.stringify(this.logs, null, 2)}`
      );
    }

    return match;
  }

  /**
   * Assert that a log entry with the specified section path exists.
   * Throws if no match is found.
   *
   * @param path - Section path to match (e.g., "CEO.processTask.decide")
   * @returns The matching log entry
   *
   * @example
   * capture.assertPath('handleMessage.validate');
   */
  assertPath(path: string): LogEntry {
    const match = this.logs.find(entry => entry.sectionPath === path);

    if (!match) {
      throw new Error(
        `No log entry found with path: ${path}. ` +
        `Available paths: ${this.logs.map(l => l.sectionPath || '(none)').join(', ')}`
      );
    }

    return match;
  }
}
