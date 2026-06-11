import { describe, it, expect } from 'vitest';
import { makeRunScope } from '../src/run-scope.js';

describe('makeRunScope (D15 run isolation)', () => {
  it('nonce is a Russian token with digits, matching the documented shape', () => {
    const scope = makeRunScope();
    expect(scope.nonce).toMatch(/^шифр-[а-яё]{8}-\d{4}$/u);
  });

  it('contextId is run-scoped: smoke- prefix + timestamp + random suffix', () => {
    const scope = makeRunScope();
    expect(scope.contextId).toMatch(/^smoke-\d{14}-[a-z0-9]{6}$/);
  });

  it('sessionId equals contextId (D1)', () => {
    const scope = makeRunScope();
    expect(scope.sessionId).toBe(scope.contextId);
  });

  it('two consecutive runs get distinct contextId and nonce', () => {
    const a = makeRunScope();
    const b = makeRunScope();
    expect(a.contextId).not.toBe(b.contextId);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('is deterministic under injected rand/clock', () => {
    const rand = () => 0.5;
    const clock = () => Date.UTC(2026, 5, 11, 12, 0, 0);
    const a = makeRunScope(rand, clock);
    const b = makeRunScope(rand, clock);
    expect(a).toEqual(b);
  });
});
