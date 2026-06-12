// scripts/lib/require-env.ts — single fail-fast path for script env config
// (bead llmems-a9r). No hardcoded defaults, no fallbacks: a missing or empty
// variable throws loudly with the variable name and a fix hint.
//
// Not part of the published package (root `files: ["dist"]`; tsconfig builds
// `src/**` only). Scripts run via tsx.

export function requireEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required but not set. ` +
        `Export it before running, e.g.: export ${name}=<value>. ` +
        'Hardcoded defaults were removed on purpose (llmems-a9r): scripts must never ' +
        'embed credentials.',
    );
  }
  return value;
}

/** Number variant (integer or fractional): same loud fail-fast (llmems-mdg budget). */
export function requireEnvNumber(
  name: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = requireEnv(name, env);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got "${raw}"`);
  }
  return value;
}

/** Integer variant: same loud fail-fast, plus strict integer validation. */
export function requireEnvInt(
  name: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = requireEnv(name, env);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return value;
}
