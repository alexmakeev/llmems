/** Delay helper for retry backoff. Separate module for easy test mocking. */
export function retrySleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
