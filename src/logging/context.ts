/**
 * Logging Context Management
 * Uses AsyncLocalStorage to propagate context automatically.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogContext } from './types.js';

/** Global async local storage for log context */
export const logStore = new AsyncLocalStorage<LogContext>();

/**
 * Run a function with additional log context fields.
 * Fields are merged with parent context (child overrides parent).
 *
 * @param fields - Additional context fields to merge
 * @param fn - Function to run with the context
 * @returns The result of the function
 *
 * @example
 * withLogContext({ taskId: '123', userId: 'abc' }, () => {
 *   log.info('task started'); // Log includes taskId and userId
 * });
 */
export function withLogContext<T>(
  fields: Record<string, unknown>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const current = logStore.getStore() ?? {};
  const merged: LogContext = { ...current, ...fields };
  return logStore.run(merged, fn);
}

/**
 * Run a function within a named section (builds hierarchical path).
 * Sections nest automatically: "a" -> "a.b" -> "a.b.c"
 *
 * @param name - Section name
 * @param fn - Function to run within the section
 * @returns The result of the function
 *
 * @example
 * withSection('processTask', () => {
 *   withSection('validate', () => {
 *     log.info('validating'); // sectionPath: "processTask.validate"
 *   });
 * });
 */
export function withSection<T>(
  name: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const current = logStore.getStore() ?? {};
  const currentPath = current.sectionPath ?? '';
  const currentDepth = current.depth ?? -1;

  const newPath = currentPath ? `${currentPath}.${name}` : name;
  const newDepth = currentDepth + 1;

  const sectionContext: LogContext = {
    ...current,
    sectionPath: newPath,
    depth: newDepth,
  };

  return logStore.run(sectionContext, fn);
}

/**
 * Get the current log context (or empty object if none).
 * Useful for debugging or manual context access.
 */
export function getLogContext(): LogContext {
  return logStore.getStore() ?? {};
}
