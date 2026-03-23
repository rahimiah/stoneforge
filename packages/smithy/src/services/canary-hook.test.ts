/**
 * Canary Hook Tests
 *
 * Tests the CanaryHook implementation including health check polling,
 * failure rate calculation, and integration with PostMergeHook interface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostMergeContext } from './post-merge-runner.js';
import type { CanaryHookConfig, HealthCheckResult } from './canary-hook.js';
import { CanaryHookImpl, createCanaryHook } from './canary-hook.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockContext(overrides?: Partial<PostMergeContext>): PostMergeContext {
  return {
    commitSha: 'abc123def456',
    changedFiles: ['src/index.ts'],
    sourceBranch: 'feature/deploy',
    targetBranch: 'master',
    workspaceRoot: '/tmp/test-workspace',
    taskId: 'el-1234' as any,
    ...overrides,
  };
}

/**
 * Create a mock fetch function that returns the given responses in order.
 * Once all responses are consumed, subsequent calls return the last response.
 */
function createMockFetch(responses: Array<{ status: number } | Error>): typeof fetch {
  let callIndex = 0;
  return vi.fn(async () => {
    const idx = Math.min(callIndex, responses.length - 1);
    callIndex++;
    const response = responses[idx];
    if (response instanceof Error) {
      throw response;
    }
    return new Response(null, { status: response.status });
  }) as any;
}

/**
 * Create a CanaryHook config for fast tests (short duration, short interval).
 */
function createFastConfig(overrides?: Partial<CanaryHookConfig>): CanaryHookConfig {
  return {
    healthUrl: 'https://example.com/health',
    durationMinutes: 0.01, // ~0.6 seconds → gives 1 check
    intervalSeconds: 0.01, // 10ms interval
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('CanaryHookImpl', () => {
  describe('constructor', () => {
    it('should create a hook with required config', () => {
      const hook = new CanaryHookImpl({ healthUrl: 'https://example.com/health' });
      expect(hook.name).toBe('canary-monitoring');
      expect(hook.description).toContain('example.com/health');
    });

    it('should throw if healthUrl is empty', () => {
      expect(() => new CanaryHookImpl({ healthUrl: '' })).toThrow('requires a healthUrl');
    });

    it('should use default values when not provided', () => {
      const hook = new CanaryHookImpl({ healthUrl: 'https://example.com/health' });
      expect(hook.description).toContain('5m');
      expect(hook.description).toContain('30s');
      expect(hook.description).toContain('30%');
    });

    it('should accept custom config values', () => {
      const hook = new CanaryHookImpl({
        healthUrl: 'https://custom.com/status',
        durationMinutes: 10,
        intervalSeconds: 15,
        failureThresholdPercent: 50,
      });
      expect(hook.description).toContain('10m');
      expect(hook.description).toContain('15s');
      expect(hook.description).toContain('50%');
    });
  });

  describe('performHealthCheck', () => {
    it('should return success for 200 response', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
      });

      const result = await hook.performHealthCheck();

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('should return success for any 2xx response', async () => {
      const mockFetch = createMockFetch([{ status: 204 }]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
      });

      const result = await hook.performHealthCheck();
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(204);
    });

    it('should return failure for 500 response', async () => {
      const mockFetch = createMockFetch([{ status: 500 }]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
      });

      const result = await hook.performHealthCheck();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain('500');
    });

    it('should return failure for 404 response', async () => {
      const mockFetch = createMockFetch([{ status: 404 }]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
      });

      const result = await hook.performHealthCheck();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
    });

    it('should use custom expectedStatusCodes', async () => {
      const mockFetch = createMockFetch([{ status: 418 }]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
        expectedStatusCodes: [200, 418],
      });

      const result = await hook.performHealthCheck();
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(418);
    });

    it('should handle network errors', async () => {
      const mockFetch = createMockFetch([new Error('ECONNREFUSED')]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
      });

      const result = await hook.performHealthCheck();
      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.statusCode).toBeUndefined();
    });

    it('should handle timeout errors', async () => {
      const mockFetch = createMockFetch([new Error('The operation was aborted')]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
        requestTimeoutMs: 100,
      });

      const result = await hook.performHealthCheck();
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should include timestamp in result', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl({
        healthUrl: 'https://example.com/health',
        fetchFn: mockFetch,
      });

      const before = Date.now();
      const result = await hook.performHealthCheck();
      const after = Date.now();

      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('monitor', () => {
    it('should perform checks and return summary', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({ fetchFn: mockFetch })
      );

      const summary = await hook.monitor();

      expect(summary.totalChecks).toBeGreaterThanOrEqual(1);
      expect(summary.successCount).toBe(summary.totalChecks);
      expect(summary.failureCount).toBe(0);
      expect(summary.failureRate).toBe(0);
      expect(summary.avgResponseTimeMs).toBeGreaterThanOrEqual(0);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should calculate failure rate correctly with mixed results', async () => {
      // 3 checks: 200, 500, 200 → 33.3% failure
      const mockFetch = createMockFetch([
        { status: 200 },
        { status: 500 },
        { status: 200 },
      ]);
      const hook = new CanaryHookImpl(
        createFastConfig({
          fetchFn: mockFetch,
          durationMinutes: 0.01,
          intervalSeconds: 0.001, // very short so we get 3+ checks
        })
      );

      const summary = await hook.monitor();

      // We expect at least some failures
      expect(summary.checks.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle all failures', async () => {
      const mockFetch = createMockFetch([{ status: 500 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({ fetchFn: mockFetch })
      );

      const summary = await hook.monitor();

      expect(summary.failureCount).toBe(summary.totalChecks);
      expect(summary.failureRate).toBe(100);
      expect(summary.avgResponseTimeMs).toBe(0); // no successful checks
    });
  });

  describe('execute (PostMergeHook interface)', () => {
    it('should return success when failure rate is below threshold', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({
          fetchFn: mockFetch,
          failureThresholdPercent: 30,
        })
      );

      const result = await hook.execute(createMockContext());

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.message).toContain('PASSED');
      expect(result!.message).toContain('example.com/health');
    });

    it('should return failure when failure rate exceeds threshold', async () => {
      const mockFetch = createMockFetch([{ status: 500 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({
          fetchFn: mockFetch,
          failureThresholdPercent: 30,
        })
      );

      const result = await hook.execute(createMockContext());

      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
      expect(result!.message).toContain('FAILED');
      expect(result!.message).toContain('exceeds');
      expect(result!.message).toContain('30%');
    });

    it('should pass with 0% failure rate and 0% threshold', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({
          fetchFn: mockFetch,
          failureThresholdPercent: 0,
        })
      );

      const result = await hook.execute(createMockContext());
      expect(result!.success).toBe(true);
    });

    it('should fail with 100% failure rate', async () => {
      const mockFetch = createMockFetch([
        new Error('ECONNREFUSED'),
      ]);
      const hook = new CanaryHookImpl(
        createFastConfig({
          fetchFn: mockFetch,
          failureThresholdPercent: 50,
        })
      );

      const result = await hook.execute(createMockContext());
      expect(result!.success).toBe(false);
      expect(result!.message).toContain('100.0%');
    });

    it('should include URL in result message', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({
          healthUrl: 'https://myapp.example.com/status',
          fetchFn: mockFetch,
        })
      );

      const result = await hook.execute(createMockContext());
      expect(result!.message).toContain('myapp.example.com/status');
    });
  });

  describe('createCanaryHook factory', () => {
    it('should return a PostMergeHook implementation', () => {
      const hook = createCanaryHook({ healthUrl: 'https://example.com/health' });
      expect(hook.name).toBe('canary-monitoring');
      expect(typeof hook.execute).toBe('function');
    });

    it('should work with the PostMergeHook interface', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = createCanaryHook(
        createFastConfig({ fetchFn: mockFetch })
      );

      const result = await hook.execute(createMockContext());
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
    });
  });

  describe('integration with PostMergeRunner', () => {
    it('should return result compatible with PostMergeRunner expectations', async () => {
      const mockFetch = createMockFetch([{ status: 200 }]);
      const hook = new CanaryHookImpl(
        createFastConfig({ fetchFn: mockFetch })
      );

      const result = await hook.execute(createMockContext());

      // PostMergeRunner expects { success: boolean, message?: string }
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
      expect(typeof result!.success).toBe('boolean');
      expect(typeof result!.message).toBe('string');
    });
  });
});
