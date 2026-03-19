/**
 * Shared Result Type
 *
 * Unified Result type for error handling across the codebase.
 * Implements the Result pattern from functional programming.
 */

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Helper to create a successful result
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Helper to create an error result
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
