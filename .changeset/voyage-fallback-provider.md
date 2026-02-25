---
"@stoneforge/quarry": minor
---

Add Voyage AI embedding provider with automatic local fallback

- VoyageEmbeddingProvider: Voyage AI API integration (voyage-3 model) with rate limiting and error handling
- FallbackEmbeddingProvider: Wraps remote providers with automatic local fallback when unavailable or rate-limited
- VoyageAPIError: Custom error class with status classification (rate_limited, server_error, api_error)
- Full test coverage for both providers
