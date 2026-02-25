import { describe, test, expect, mock } from 'bun:test';
import { FallbackEmbeddingProvider } from './fallback-provider.js';
import { VoyageAPIError } from './voyage-provider.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Create a mock embedding provider for testing
 */
function createMockProvider(
  name: string,
  options: {
    dimensions?: number;
    isLocal?: boolean;
    embedError?: Error;
    isAvailable?: boolean;
  } = {}
): EmbeddingProvider {
  const {
    dimensions = 768,
    isLocal = false,
    embedError,
    isAvailable = true,
  } = options;

  return {
    name,
    dimensions,
    isLocal,
    async embed(text: string): Promise<Float32Array> {
      if (embedError) {
        throw embedError;
      }
      // Return deterministic embedding based on text length
      const embedding = new Float32Array(dimensions);
      for (let i = 0; i < dimensions; i++) {
        embedding[i] = (text.length + i) / dimensions;
      }
      // Normalize
      let norm = 0;
      for (let i = 0; i < dimensions; i++) {
        norm += embedding[i] * embedding[i];
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < dimensions; i++) {
        embedding[i] /= norm;
      }
      return embedding;
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      return Promise.all(texts.map((t) => this.embed(t)));
    },
    async isAvailable(): Promise<boolean> {
      return isAvailable;
    },
  };
}

describe('FallbackEmbeddingProvider', () => {
  test('uses primary provider name in combined name', () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');
    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    expect(provider.name).toBe('fallback(primary→fallback)');
    expect(provider.dimensions).toBe(768);
    expect(provider.isLocal).toBe(false);
  });

  test('uses primary provider when available', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');
    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    const result = await provider.embed('test');
    expect(result).toBeInstanceOf(Float32Array);
    expect(provider.isUsingFallback()).toBe(false);
  });

  test('falls back when primary throws error', async () => {
    const primary = createMockProvider('primary', {
      embedError: new Error('Primary failed'),
    });
    const fallback = createMockProvider('fallback');
    const onFallback = mock(() => {});

    const provider = new FallbackEmbeddingProvider({
      primary,
      fallback,
      onFallback,
    });

    const result = await provider.embed('test');

    expect(result).toBeInstanceOf(Float32Array);
    expect(provider.isUsingFallback()).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  test('classifies VoyageAPIError rate limit correctly', async () => {
    const primary = createMockProvider('primary', {
      embedError: new VoyageAPIError('Rate limited', 429, true, false),
    });
    const fallback = createMockProvider('fallback');
    let fallbackReason = '';
    const onFallback = mock((reason: string) => {
      fallbackReason = reason;
    });

    const provider = new FallbackEmbeddingProvider({
      primary,
      fallback,
      onFallback,
    });

    await provider.embed('test');

    expect(fallbackReason).toBe('rate_limited');
  });

  test('classifies VoyageAPIError server error correctly', async () => {
    const primary = createMockProvider('primary', {
      embedError: new VoyageAPIError('Server error', 500, false, true),
    });
    const fallback = createMockProvider('fallback');
    let fallbackReason = '';
    const onFallback = mock((reason: string) => {
      fallbackReason = reason;
    });

    const provider = new FallbackEmbeddingProvider({
      primary,
      fallback,
      onFallback,
    });

    await provider.embed('test');

    expect(fallbackReason).toBe('server_error');
  });

  test('classifies timeout error correctly', async () => {
    const primary = createMockProvider('primary', {
      embedError: new Error('Request timeout'),
    });
    const fallback = createMockProvider('fallback');
    let fallbackReason = '';
    const onFallback = mock((reason: string) => {
      fallbackReason = reason;
    });

    const provider = new FallbackEmbeddingProvider({
      primary,
      fallback,
      onFallback,
    });

    await provider.embed('test');

    expect(fallbackReason).toBe('timeout');
  });

  test('throws when both providers fail', async () => {
    const primary = createMockProvider('primary', {
      embedError: new Error('Primary failed'),
    });
    const fallback = createMockProvider('fallback', {
      embedError: new Error('Fallback also failed'),
    });

    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    await expect(provider.embed('test')).rejects.toThrow(
      'Both primary and fallback embedding providers failed'
    );
  });

  test('embedBatch falls back correctly', async () => {
    const primary = createMockProvider('primary', {
      embedError: new VoyageAPIError('API error', 503, false, true),
    });
    const fallback = createMockProvider('fallback');
    const onFallback = mock(() => {});

    const provider = new FallbackEmbeddingProvider({
      primary,
      fallback,
      onFallback,
    });

    const results = await provider.embedBatch(['one', 'two', 'three']);

    expect(results.length).toBe(3);
    expect(provider.isUsingFallback()).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  test('isAvailable returns true if primary is available', async () => {
    const primary = createMockProvider('primary', { isAvailable: true });
    const fallback = createMockProvider('fallback', { isAvailable: false });

    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  test('isAvailable returns true if only fallback is available', async () => {
    const primary = createMockProvider('primary', { isAvailable: false });
    const fallback = createMockProvider('fallback', { isAvailable: true });

    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  test('isAvailable returns false if neither is available', async () => {
    const primary = createMockProvider('primary', { isAvailable: false });
    const fallback = createMockProvider('fallback', { isAvailable: false });

    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  test('resets fallback state when primary succeeds again', async () => {
    let primaryShouldFail = true;
    const primary: EmbeddingProvider = {
      name: 'toggling-primary',
      dimensions: 768,
      isLocal: false,
      async embed(text: string): Promise<Float32Array> {
        if (primaryShouldFail) {
          throw new Error('Primary temporarily down');
        }
        return new Float32Array(768).fill(0.5);
      },
      async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map((t) => this.embed(t)));
      },
      async isAvailable(): Promise<boolean> {
        return !primaryShouldFail;
      },
    };
    const fallback = createMockProvider('fallback');

    const provider = new FallbackEmbeddingProvider({ primary, fallback });

    // First call - primary fails, uses fallback
    await provider.embed('test');
    expect(provider.isUsingFallback()).toBe(true);

    // Primary recovers
    primaryShouldFail = false;

    // Second call - primary succeeds
    await provider.embed('test');
    expect(provider.isUsingFallback()).toBe(false);
  });

  test('warns on dimension mismatch (via console)', async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const primary = createMockProvider('primary', { dimensions: 1024 });
      const fallback = createMockProvider('fallback', { dimensions: 768 });

      new FallbackEmbeddingProvider({ primary, fallback });

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('dimension mismatch');
    } finally {
      console.warn = originalWarn;
    }
  });
});
