// src/utils/semaphore.ts
// Semaphore for limiting concurrent async operations.

/**
 * Concurrency limit for LLM API calls (extraction, summarization, etc.)
 */
export const LLM_CONCURRENCY = 20;

/**
 * Concurrency limit for embedding API calls.
 */
export const EMBEDDING_CONCURRENCY = 100;

/**
 * Semaphore for limiting concurrent async operations.
 * Used to control parallelism for LLM and embedding API calls.
 */
export class Semaphore {
  private readonly maxConcurrent: number;
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    if (maxConcurrent < 1) {
      throw new Error(`Semaphore maxConcurrent must be >= 1, got ${maxConcurrent}`);
    }
  }

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Current number of running operations */
  get activeCount(): number {
    return this.running;
  }

  /** Number of operations waiting in queue */
  get pendingCount(): number {
    return this.queue.length;
  }
}
