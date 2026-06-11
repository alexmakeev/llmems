/**
 * Harness configuration: a tiny deterministic env-file parser + validated config
 * loader. Zero dependencies, fully offline-testable (plan v2, D11).
 *
 * Source of truth on the stand: ~/llmems-stand/.env (created by bead llmems-3io.7).
 */

export interface HarnessConfig {
  postgresUrl: string;
  litellmBaseUrl: string;
  litellmApiKey: string;
  summarizerModel: string;
  embeddingsModel: string;
  /** Critical-path budget per turn (D2). Default 1500. */
  criticalTimeoutMs: number;
  /** Hard cap on injected context size (D7). Default 12000. */
  maxContextChars: number;
  /** Russian marker prefixing the dynamic mems block (D5). */
  markerText: string;
  /** Optional override of ContextFactory indexThreshold (D16). */
  indexThreshold?: number;
  /** Bounded wait for mems rows after seeding (D16). Default 120000. */
  seedPollTimeoutMs: number;
  /** Poll interval for the mems wait (D16). Default 2000. */
  seedPollIntervalMs: number;
}

const REQUIRED_KEYS = [
  'POSTGRES_URL',
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'LLMEMS_SUMMARIZER_MODEL',
  'LLMEMS_EMBEDDINGS_MODEL',
] as const;

export const DEFAULT_MARKER_TEXT = 'Загружено из памяти:';

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

function intOf(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${key}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadHarnessConfig(env: Record<string, string | undefined>): HarnessConfig {
  const missing = REQUIRED_KEYS.filter((k) => env[k] === undefined || env[k] === '');
  if (missing.length > 0) {
    throw new Error(`Harness config invalid — missing required keys: ${missing.join(', ')}`);
  }
  const placeholders = REQUIRED_KEYS.filter((k) => /__PENDING_[A-Z_]+__/.test(env[k] ?? ''));
  if (placeholders.length > 0) {
    throw new Error(
      `Harness config invalid — placeholder values left from provisioning in: ${placeholders.join(', ')}`,
    );
  }

  const indexThresholdRaw = env['LLMEMS_INDEX_THRESHOLD'];

  return {
    postgresUrl: env['POSTGRES_URL'] as string,
    litellmBaseUrl: env['LITELLM_BASE_URL'] as string,
    litellmApiKey: env['LITELLM_API_KEY'] as string,
    summarizerModel: env['LLMEMS_SUMMARIZER_MODEL'] as string,
    embeddingsModel: env['LLMEMS_EMBEDDINGS_MODEL'] as string,
    criticalTimeoutMs: intOf(env, 'LLMEMS_CRITICAL_TIMEOUT_MS', 1500),
    maxContextChars: intOf(env, 'LLMEMS_MAX_CONTEXT_CHARS', 12000),
    markerText: env['LLMEMS_MARKER_TEXT'] ?? DEFAULT_MARKER_TEXT,
    ...(indexThresholdRaw !== undefined && indexThresholdRaw !== ''
      ? { indexThreshold: intOf(env, 'LLMEMS_INDEX_THRESHOLD', 16) }
      : {}),
    seedPollTimeoutMs: intOf(env, 'LLMEMS_SEED_POLL_TIMEOUT_MS', 120000),
    seedPollIntervalMs: intOf(env, 'LLMEMS_SEED_POLL_INTERVAL_MS', 2000),
  };
}
