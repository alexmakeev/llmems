// src/__tests__/semaphore.test.ts
// Tests for Semaphore utility

import { describe, it, expect } from 'vitest';
import { Semaphore, LLM_CONCURRENCY, EMBEDDING_CONCURRENCY } from '../utils/semaphore.ts';

// ── Constructor ───────────────────────────────────────────────────────────────

describe('Semaphore — constructor', () => {
  it('throws for maxConcurrent < 1', () => {
    expect(() => new Semaphore(0)).toThrow('maxConcurrent must be >= 1, got 0');
    expect(() => new Semaphore(-5)).toThrow('maxConcurrent must be >= 1, got -5');
  });

  it('creates successfully with maxConcurrent = 1', () => {
    expect(() => new Semaphore(1)).not.toThrow();
  });

  it('starts with zero active and pending counts', () => {
    const sem = new Semaphore(5);
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);
  });
});

// ── acquire / release ─────────────────────────────────────────────────────────

describe('Semaphore — acquire / release', () => {
  it('increments activeCount on acquire', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    await sem.acquire();
    expect(sem.activeCount).toBe(2);
  });

  it('decrements activeCount on release', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    sem.release();
    expect(sem.activeCount).toBe(1);
    sem.release();
    expect(sem.activeCount).toBe(0);
  });

  it('queues when at capacity and resolves after release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // slot taken

    let resolved = false;
    const pending = sem.acquire().then(() => {
      resolved = true;
    });

    expect(sem.pendingCount).toBe(1);
    expect(resolved).toBe(false);

    sem.release(); // should dequeue
    await pending;

    expect(resolved).toBe(true);
    expect(sem.pendingCount).toBe(0);
  });
});

// ── Concurrency limit ─────────────────────────────────────────────────────────

describe('Semaphore — concurrency limit respected', () => {
  it('never exceeds maxConcurrent concurrent operations', async () => {
    const maxConcurrent = 2;
    const sem = new Semaphore(maxConcurrent);
    let peak = 0;
    let current = 0;
    const results: number[] = [];

    const task = async (id: number): Promise<number> => {
      return sem.run(async () => {
        current++;
        if (current > peak) peak = current;
        // Yield to allow other microtasks to run
        await Promise.resolve();
        results.push(id);
        current--;
        return id;
      });
    };

    // Launch 5 tasks concurrently
    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);

    expect(peak).toBeLessThanOrEqual(maxConcurrent);
    expect(results).toHaveLength(5);
  });
});

// ── FIFO queue ordering ───────────────────────────────────────────────────────

describe('Semaphore — FIFO queue ordering', () => {
  it('processes queued operations in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    // Occupy the slot
    await sem.acquire();

    // Queue 3 waiters
    const p1 = sem.acquire().then(() => { order.push(1); sem.release(); });
    const p2 = sem.acquire().then(() => { order.push(2); sem.release(); });
    const p3 = sem.acquire().then(() => { order.push(3); sem.release(); });

    // Release the initial slot to start the chain
    sem.release();

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ── run() helper ──────────────────────────────────────────────────────────────

describe('Semaphore — run()', () => {
  it('returns the value from fn', async () => {
    const sem = new Semaphore(2);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });

  it('releases the slot even if fn throws', async () => {
    const sem = new Semaphore(1);

    await expect(
      sem.run(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    // Slot must be released — next acquire should resolve immediately
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);

    // Verify slot is usable again
    const result = await sem.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('acquires slot before fn runs and releases after', async () => {
    const sem = new Semaphore(2);
    const snapshots: number[] = [];

    await sem.run(async () => {
      snapshots.push(sem.activeCount);
    });

    expect(snapshots).toEqual([1]);
    expect(sem.activeCount).toBe(0);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('Concurrency constants', () => {
  it('LLM_CONCURRENCY is a positive integer', () => {
    expect(LLM_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(LLM_CONCURRENCY)).toBe(true);
  });

  it('EMBEDDING_CONCURRENCY is a positive integer', () => {
    expect(EMBEDDING_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(EMBEDDING_CONCURRENCY)).toBe(true);
  });

  it('has expected values', () => {
    expect(LLM_CONCURRENCY).toBe(20);
    expect(EMBEDDING_CONCURRENCY).toBe(100);
  });
});
