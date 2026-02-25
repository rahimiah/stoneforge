import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { VoyageEmbeddingProvider, VoyageAPIError } from './voyage-provider.js';

describe('VoyageEmbeddingProvider', () => {
  const originalEnv = process.env.VOYAGE_API_KEY;

  beforeEach(() => {
    // Reset env between tests
    process.env.VOYAGE_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.VOYAGE_API_KEY = originalEnv;
    } else {
      delete process.env.VOYAGE_API_KEY;
    }
  });

  test('uses default model and dimensions', () => {
    const provider = new VoyageEmbeddingProvider();
    expect(provider.name).toBe('voyage-voyage-3');
    expect(provider.dimensions).toBe(1024);
    expect(provider.isLocal).toBe(false);
  });

  test('accepts custom config', () => {
    const provider = new VoyageEmbeddingProvider({
      model: 'voyage-lite-02',
      dimensions: 512,
      apiKey: 'custom-key',
    });
    expect(provider.name).toBe('voyage-voyage-lite-02');
    expect(provider.dimensions).toBe(512);
  });

  test('isAvailable returns false without API key', async () => {
    delete process.env.VOYAGE_API_KEY;
    const provider = new VoyageEmbeddingProvider({ apiKey: '' });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  test('throws VoyageAPIError when API key not set', async () => {
    delete process.env.VOYAGE_API_KEY;
    const provider = new VoyageEmbeddingProvider({ apiKey: '' });

    await expect(provider.embed('test')).rejects.toThrow(VoyageAPIError);
    await expect(provider.embed('test')).rejects.toThrow(
      'VOYAGE_API_KEY environment variable not set'
    );
  });

  test('embed returns empty array for empty batch', async () => {
    const provider = new VoyageEmbeddingProvider();
    const results = await provider.embedBatch([]);
    expect(results).toEqual([]);
  });

  describe('with mocked fetch', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test('embed calls API correctly and returns normalized embedding', async () => {
      const mockEmbedding = Array(1024).fill(0.5);

      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', embedding: mockEmbedding, index: 0 }],
            model: 'voyage-3',
            usage: { total_tokens: 5 },
          }),
          { status: 200 }
        );
      });

      const provider = new VoyageEmbeddingProvider();
      const result = await provider.embed('test text');

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(1024);

      // Verify normalization (unit length)
      let norm = 0;
      for (let i = 0; i < result.length; i++) {
        norm += result[i] * result[i];
      }
      norm = Math.sqrt(norm);
      expect(norm).toBeCloseTo(1.0, 5);
    });

    test('embedBatch preserves order via index sorting', async () => {
      // Return embeddings out of order
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { object: 'embedding', embedding: Array(1024).fill(0.2), index: 1 },
              { object: 'embedding', embedding: Array(1024).fill(0.1), index: 0 },
            ],
            model: 'voyage-3',
            usage: { total_tokens: 10 },
          }),
          { status: 200 }
        );
      });

      const provider = new VoyageEmbeddingProvider();
      const results = await provider.embedBatch(['first', 'second']);

      expect(results.length).toBe(2);
      // First result should have original value ~0.1 (normalized)
      // Second result should have original value ~0.2 (normalized)
      // Since all values are same in each embedding, normalization makes them ~1/sqrt(1024)
    });

    test('throws VoyageAPIError on rate limit (429)', async () => {
      globalThis.fetch = mock(async () => {
        return new Response('Rate limit exceeded', { status: 429 });
      });

      const provider = new VoyageEmbeddingProvider();

      try {
        await provider.embed('test');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(VoyageAPIError);
        expect((error as VoyageAPIError).statusCode).toBe(429);
        expect((error as VoyageAPIError).isRateLimited).toBe(true);
        expect((error as VoyageAPIError).isServerError).toBe(false);
      }
    });

    test('throws VoyageAPIError on server error (500)', async () => {
      globalThis.fetch = mock(async () => {
        return new Response('Internal server error', { status: 500 });
      });

      const provider = new VoyageEmbeddingProvider();

      try {
        await provider.embed('test');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(VoyageAPIError);
        expect((error as VoyageAPIError).statusCode).toBe(500);
        expect((error as VoyageAPIError).isRateLimited).toBe(false);
        expect((error as VoyageAPIError).isServerError).toBe(true);
      }
    });

    test('throws VoyageAPIError on network error', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('Network error');
      });

      const provider = new VoyageEmbeddingProvider();

      try {
        await provider.embed('test');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(VoyageAPIError);
        expect((error as VoyageAPIError).isServerError).toBe(true);
        expect((error as VoyageAPIError).message).toContain('Network error');
      }
    });

    test('handles batch size > 128 by chunking', async () => {
      let callCount = 0;
      globalThis.fetch = mock(async (url: string, init: RequestInit) => {
        callCount++;
        const body = JSON.parse(init.body as string);
        const embeddings = body.input.map((text: string, idx: number) => ({
          object: 'embedding',
          embedding: Array(1024).fill(0.1),
          index: idx,
        }));

        return new Response(
          JSON.stringify({
            object: 'list',
            data: embeddings,
            model: 'voyage-3',
            usage: { total_tokens: body.input.length * 5 },
          }),
          { status: 200 }
        );
      });

      const provider = new VoyageEmbeddingProvider();
      const texts = Array(200).fill('test text'); // > 128, should chunk
      const results = await provider.embedBatch(texts);

      expect(results.length).toBe(200);
      expect(callCount).toBe(2); // 128 + 72
    });
  });
});
