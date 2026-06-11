/**
 * EmbeddingAdapter — harness-local IEmbeddingService implementation (plan v2, D10).
 *
 * Calls an OpenAI-compatible /v1/embeddings endpoint (LiteLLM on the AM32 stand)
 * and returns a Result-typed 1536-dim vector. Never throws: every failure mode
 * (HTTP error, network error, malformed body, dimension mismatch) maps to err().
 */
import { ok, err, type IEmbeddingService, type EmbeddingValue, type Result } from '@alexmakeev/llmems';

export const EXPECTED_DIMENSIONS = 1536;

export interface EmbeddingAdapterConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. http://127.0.0.1:14999 */
  baseUrl: string;
  /** Bearer key (the scoped llmems-teststand key on the stand). */
  apiKey: string;
  /** Model name as exposed by LiteLLM, e.g. openai-embedding-small. */
  model: string;
  /** Injectable fetch for offline tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class EmbeddingAdapter implements IEmbeddingService {
  private readonly cfg: EmbeddingAdapterConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: EmbeddingAdapterConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async embed(text: string): Promise<Result<EmbeddingValue, { message: string }>> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/v1/embeddings`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({ model: this.cfg.model, input: text }),
      });
    } catch (e) {
      return err({ message: `embeddings request failed: ${e instanceof Error ? e.message : String(e)}` });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return err({ message: `embeddings HTTP ${response.status}: ${body.slice(0, 200)}` });
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (e) {
      return err({ message: `embeddings response is not JSON: ${e instanceof Error ? e.message : String(e)}` });
    }

    const vector = (parsed as { data?: { embedding?: unknown }[] })?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.every((v) => typeof v === 'number')) {
      return err({ message: 'embeddings response malformed: data[0].embedding is not a number array' });
    }
    if (vector.length !== EXPECTED_DIMENSIONS) {
      return err({
        message: `embeddings dimension mismatch: got ${vector.length}, expected ${EXPECTED_DIMENSIONS}`,
      });
    }

    return ok({ compact: vector as number[] });
  }
}
