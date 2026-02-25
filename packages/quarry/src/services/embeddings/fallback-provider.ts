/**
 * Fallback Embedding Provider
 *
 * Wraps a primary provider (e.g., Voyage AI) with a fallback provider (e.g., local model).
 * Automatically falls back when the primary provider is unavailable, rate-limited, or errors.
 *
 * Use cases:
 * - Avoid hard dependency on external APIs
 * - Graceful degradation during outages
 * - Rate limit handling
 */

import type { EmbeddingProvider } from './types.js';
import { VoyageAPIError } from './voyage-provider.js';

export interface FallbackProviderConfig {
  /** Primary embedding provider (e.g., VoyageEmbeddingProvider) */
  primary: EmbeddingProvider;
  /** Fallback embedding provider (e.g., LocalEmbeddingProvider) */
  fallback: EmbeddingProvider;
  /**
   * Optional callback invoked when fallback is triggered.
   * Useful for logging/monitoring fallback events.
   */
  onFallback?: (reason: string, error: Error) => void;
}

/**
 * Embedding provider that wraps a primary provider with automatic fallback.
 *
 * When the primary provider fails (network error, rate limit, server error),
 * the fallback provider is used instead. Both providers must produce
 * embeddings of the same dimensionality for consistency.
 *
 * Note: For production use, ensure both providers have matching dimensions
 * or implement dimension alignment. This implementation assumes compatible providers.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly isLocal: boolean;

  private primary: EmbeddingProvider;
  private fallback: EmbeddingProvider;
  private onFallback?: (reason: string, error: Error) => void;
  private usingFallback = false;

  constructor(config: FallbackProviderConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.onFallback = config.onFallback;

    // Report the primary provider's characteristics
    this.name = `fallback(${config.primary.name}→${config.fallback.name})`;
    this.dimensions = config.primary.dimensions;
    this.isLocal = false; // Not purely local since primary may be remote

    // Warn if dimensions don't match (they should for consistent results)
    if (config.primary.dimensions !== config.fallback.dimensions) {
      console.warn(
        `FallbackEmbeddingProvider: dimension mismatch between primary (${config.primary.dimensions}) ` +
          `and fallback (${config.fallback.dimensions}). Results may be inconsistent.`
      );
    }
  }

  /**
   * Get whether currently using fallback provider.
   */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  async embed(text: string): Promise<Float32Array> {
    try {
      const result = await this.primary.embed(text);
      this.usingFallback = false;
      return result;
    } catch (error) {
      return this.handleFallback(error, () => this.fallback.embed(text));
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    try {
      const results = await this.primary.embedBatch(texts);
      this.usingFallback = false;
      return results;
    } catch (error) {
      return this.handleFallback(error, () => this.fallback.embedBatch(texts));
    }
  }

  async isAvailable(): Promise<boolean> {
    // Available if either provider is available
    const primaryAvailable = await this.primary.isAvailable();
    if (primaryAvailable) {
      return true;
    }
    return this.fallback.isAvailable();
  }

  /**
   * Handle fallback when primary fails.
   */
  private async handleFallback<T>(error: unknown, fallbackFn: () => Promise<T>): Promise<T> {
    const reason = this.classifyError(error);
    const err = error instanceof Error ? error : new Error(String(error));

    // Notify callback
    this.onFallback?.(reason, err);

    // Mark that we're using fallback
    this.usingFallback = true;

    // Attempt fallback
    try {
      return await fallbackFn();
    } catch (fallbackError) {
      // Both providers failed - throw the original error with context
      throw new Error(
        `Both primary and fallback embedding providers failed. ` +
          `Primary error: ${err.message}. ` +
          `Fallback error: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
      );
    }
  }

  /**
   * Classify error for fallback notification.
   */
  private classifyError(error: unknown): string {
    if (error instanceof VoyageAPIError) {
      if (error.isRateLimited) {
        return 'rate_limited';
      }
      if (error.isServerError) {
        return 'server_error';
      }
      return 'api_error';
    }

    if (error instanceof Error) {
      if (error.message.includes('timeout')) {
        return 'timeout';
      }
      if (error.message.includes('network') || error.message.includes('fetch')) {
        return 'network_error';
      }
    }

    return 'unknown_error';
  }
}
