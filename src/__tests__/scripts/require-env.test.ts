// Tests for scripts/lib/require-env.ts (bead llmems-a9r).
// The helper is the SINGLE fail-fast path for script env config: no hardcoded
// defaults, no fallbacks — a missing variable throws loudly.
import { describe, it, expect } from 'vitest';
import { requireEnv } from '../../../scripts/lib/require-env.js';

describe('requireEnv (llmems-a9r fail-fast)', () => {
  it('returns the value when the variable is set', () => {
    expect(requireEnv('A9R_TEST_VAR', { A9R_TEST_VAR: 'value-1' })).toBe('value-1');
  });

  it('throws loudly when the variable is unset, naming the variable', () => {
    expect(() => requireEnv('POSTGRES_URL', {})).toThrowError(/POSTGRES_URL/);
    expect(() => requireEnv('POSTGRES_URL', {})).toThrowError(/required/i);
  });

  it('throws when the variable is set but empty (empty string is not config)', () => {
    expect(() => requireEnv('POSTGRES_URL', { POSTGRES_URL: '' })).toThrowError(/POSTGRES_URL/);
  });

  it('defaults to process.env as the source', () => {
    process.env['A9R_TEST_VAR_PROC'] = 'from-process';
    try {
      expect(requireEnv('A9R_TEST_VAR_PROC')).toBe('from-process');
    } finally {
      delete process.env['A9R_TEST_VAR_PROC'];
    }
  });
});
