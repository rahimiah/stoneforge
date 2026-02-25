/**
 * Voyage AI Embedding Provider
 *
 * Uses the Voyage AI API for high-quality embeddings.
 * Requires VOYAGE_API_KEY environment variable.
 *
 * Default model: voyage-3 (1024 dimensions)
 */

import type { EmbeddingProvider } from './types.js';

/** Voyage AI API base URL */
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

/** Default model - voyage-3 is the recommended model */
const DEFAULT_MODEL = 'voyage-3';

/** Voyage-3 outputs 1024-dimensional embeddings */
const DEFAULT_DIMENSIONS = 1024;

/** Maximum texts per batch (Voyage AI limit is 128) */
const MAX_BATCH_SIZE = 128;

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Error thrown when Voyage AI API is unavailable or rate-limited
 */
export class VoyageAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly isRateLimited: boolean = false,
    public readonly isServerError: boolean = false
  ) {
    super(message);
    this.name = 'VoyageAPIError';
  }
}

export interface VoyageProviderConfig {
  /** Voyage AI API key. Defaults to VOYAGE_API_KEY env var. */
  apiKey?: string;
  /** Model name. Defaults to voyage-3. */
  model?: string;
  /** Embedding dimensions. Defaults to 1024 for voyage-3. */
  dimensions?: number;
  /** Request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
}

interface VoyageEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    total_tokens: number;
  };
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly isLocal = false;

  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(config: VoyageProviderConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.VOYAGE_API_KEY ?? '';
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
    this.name = `voyage-${this.model}`;
    this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.apiKey) {
      throw new VoyageAPIError('VOYAGE_API_KEY environment variable not set');
    }

    if (texts.length === 0) {
      return [];
    }

    // Process in chunks if batch exceeds Voyage limit
    if (texts.length > MAX_BATCH_SIZE) {
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
        const chunkResults = await this.embedBatchInternal(chunk);
        results.push(...chunkResults);
      }
      return results;
    }

    return this.embedBatchInternal(texts);
  }

  private async embedBatchInternal(texts: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(VOYAGE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          input_type: 'document',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const isRateLimited = response.status === 429;
        const isServerError = response.status >= 500;
        const errorBody = await response.text().catch(() => 'Unknown error');

        throw new VoyageAPIError(
          `Voyage API error (${response.status}): ${errorBody}`,
          response.status,
          isRateLimited,
          isServerError
        );
      }

      const data = (await response.json()) as VoyageEmbeddingResponse;

      // Sort by index to ensure correct order
      const sortedData = [...data.data].sort((a, b) => a.index - b.index);

      return sortedData.map((item) => {
        const embedding = new Float32Array(item.embedding);
        // Normalize to unit vector
        let norm = 0;
        for (let i = 0; i < embedding.length; i++) {
          norm += embedding[i] * embedding[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
          for (let i = 0; i < embedding.length; i++) {
            embedding[i] /= norm;
          }
        }
        return embedding;
      });
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof VoyageAPIError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new VoyageAPIError(
            `Voyage API request timed out after ${this.timeoutMs}ms`,
            undefined,
            false,
            true
          );
        }
        throw new VoyageAPIError(
          `Voyage API request failed: ${error.message}`,
          undefined,
          false,
          true
        );
      }

      throw new VoyageAPIError('Unknown Voyage API error', undefined, false, true);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }

    // Perform a minimal health check with a short text
    try {
      await this.embed('health check');
      return true;
    } catch {
      return false;
    }
  }
}
