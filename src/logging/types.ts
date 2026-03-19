/**
 * Logging System Types
 * Defines types for structured logging with Pino.
 */

import type pino from 'pino';

/** Pino log levels */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Logger interface wrapping Pino logger.
 * Uses Pino's native signature (context object first, message second).
 */
export interface ILogger extends pino.Logger {
  // Pino methods already have correct signatures:
  // trace(obj: object, msg: string): void
  // debug(obj: object, msg: string): void
  // info(obj: object, msg: string): void
  // warn(obj: object, msg: string): void
  // error(obj: object, msg: string): void
  // fatal(obj: object, msg: string): void
}

/**
 * Log entry format for test assertions.
 * Represents a captured log entry.
 */
export interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: number;
  sectionPath?: string;
  depth?: number;
  component?: string;
  [key: string]: unknown;
}

/**
 * Context that propagates automatically via AsyncLocalStorage.
 * Fields are merged into every log call within the context.
 */
export interface LogContext {
  /** Component name: "CEO", "ProjectOrch", etc. */
  component?: string;
  /** Current section path: "handleMessage.createTask.validate" */
  sectionPath?: string;
  /** Depth of nested sections (starts at 0) */
  depth?: number;
  /** Context ID for correlating related operations */
  contextId?: string;
  /** Additional fields added via withLogContext */
  [key: string]: unknown;
}
