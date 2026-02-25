/**
 * Embeddings Module
 *
 * Public API for document embedding services: semantic search,
 * hybrid search (RRF fusion), and embedding providers.
 *
 * Providers:
 * - LocalEmbeddingProvider: Local ONNX-based model (bge-base-en-v1.5)
 * - VoyageEmbeddingProvider: Voyage AI API (voyage-3)
 * - FallbackEmbeddingProvider: Wraps primary with fallback for resilience
 */

export { EmbeddingService } from './service.js';
export { LocalEmbeddingProvider } from './local-provider.js';
export { VoyageEmbeddingProvider, VoyageAPIError } from './voyage-provider.js';
export type { VoyageProviderConfig } from './voyage-provider.js';
export { FallbackEmbeddingProvider } from './fallback-provider.js';
export type { FallbackProviderConfig } from './fallback-provider.js';
export { reciprocalRankFusion } from './fusion.js';
export type { RankedResult, FusedResult } from './fusion.js';
export type {
  EmbeddingProvider,
  StoredEmbedding,
  SemanticSearchResult,
  EmbeddingServiceConfig,
} from './types.js';
