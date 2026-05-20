// src/shared/env.ts
// Utilities for reading required env vars with fail-fast behaviour.

/**
 * Read an env var that must be present and parse it as an integer.
 * Throws if the var is absent, empty, or not a valid integer.
 */
export function requireEnvInt(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    throw new Error(`Required env var ${name} is not set`);
  }
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw.trim()) {
    throw new Error(`Env var ${name} must be a valid integer, got: "${raw}"`);
  }
  return value;
}
