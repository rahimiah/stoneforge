/**
 * Canary Monitoring Post-Merge Hook
 *
 * Monitors a configurable health URL for a configurable duration after
 * a merge/deploy. Polls the URL at a regular interval (default 30s) and
 * tracks success/failure of each check. If the failure rate exceeds a
 * configurable threshold (default 30%), the hook reports failure so the
 * PostMergeRunner can create a remediation task.
 *
 * @module
 */

import type { PostMergeHook, PostMergeContext, PostMergeHookResult } from './post-merge-runner.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('canary-hook');

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a single health check poll.
 */
export interface HealthCheckResult {
  /** Whether the check succeeded (2xx status and within timeout) */
  readonly success: boolean;
  /** HTTP status code, or undefined if the request failed entirely */
  readonly statusCode?: number;
  /** Response time in ms */
  readonly responseTimeMs: number;
  /** Error message if the check failed */
  readonly error?: string;
  /** Timestamp of the check */
  readonly timestamp: number;
}

/**
 * Summary of all health checks performed during the canary monitoring period.
 */
export interface CanaryMonitoringSummary {
  /** Total number of checks performed */
  readonly totalChecks: number;
  /** Number of successful checks */
  readonly successCount: number;
  /** Number of failed checks */
  readonly failureCount: number;
  /** Failure rate as a percentage (0-100) */
  readonly failureRate: number;
  /** Average response time in ms across successful checks */
  readonly avgResponseTimeMs: number;
  /** Individual check results */
  readonly checks: readonly HealthCheckResult[];
  /** Total monitoring duration in ms */
  readonly durationMs: number;
}

/**
 * Configuration for the CanaryHook.
 */
export interface CanaryHookConfig {
  /** The health check URL to monitor */
  readonly healthUrl: string;
  /** Duration to monitor in minutes (default: 5) */
  readonly durationMinutes?: number;
  /** Interval between checks in seconds (default: 30) */
  readonly intervalSeconds?: number;
  /** Failure rate threshold as a percentage — above this = hook failure (default: 30) */
  readonly failureThresholdPercent?: number;
  /** Timeout per health check request in ms (default: 10000) */
  readonly requestTimeoutMs?: number;
  /** Expected HTTP status codes that count as success (default: [200-299]) */
  readonly expectedStatusCodes?: readonly number[];
  /**
   * Custom fetch function for testing or custom HTTP behavior.
   * Must conform to the standard fetch API signature.
   */
  readonly fetchFn?: typeof fetch;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_DURATION_MINUTES = 5;
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_FAILURE_THRESHOLD_PERCENT = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a CanaryHook that monitors a health URL after deploy.
 *
 * @example
 * ```ts
 * const canary = createCanaryHook({
 *   healthUrl: 'https://myapp.example.com/health',
 *   durationMinutes: 5,
 *   intervalSeconds: 30,
 *   failureThresholdPercent: 30,
 * });
 *
 * runner.registerHook(canary);
 * ```
 */
export function createCanaryHook(config: CanaryHookConfig): PostMergeHook {
  return new CanaryHookImpl(config);
}

export class CanaryHookImpl implements PostMergeHook {
  readonly name = 'canary-monitoring';
  readonly description: string;

  private readonly config: Required<
    Pick<CanaryHookConfig, 'healthUrl' | 'durationMinutes' | 'intervalSeconds' | 'failureThresholdPercent' | 'requestTimeoutMs'>
  > & Pick<CanaryHookConfig, 'expectedStatusCodes' | 'fetchFn'>;

  constructor(config: CanaryHookConfig) {
    if (!config.healthUrl) {
      throw new Error('CanaryHook requires a healthUrl');
    }

    this.config = {
      healthUrl: config.healthUrl,
      durationMinutes: config.durationMinutes ?? DEFAULT_DURATION_MINUTES,
      intervalSeconds: config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
      failureThresholdPercent: config.failureThresholdPercent ?? DEFAULT_FAILURE_THRESHOLD_PERCENT,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      expectedStatusCodes: config.expectedStatusCodes,
      fetchFn: config.fetchFn,
    };

    this.description =
      `Monitors ${this.config.healthUrl} for ${this.config.durationMinutes}m ` +
      `every ${this.config.intervalSeconds}s (fail threshold: ${this.config.failureThresholdPercent}%)`;
  }

  async execute(context: PostMergeContext): Promise<PostMergeHookResult> {
    const { healthUrl, durationMinutes, intervalSeconds, failureThresholdPercent } = this.config;

    logger.info(
      `Starting canary monitoring for ${durationMinutes}m ` +
      `(commit ${context.commitSha.slice(0, 8)}, URL: ${healthUrl})`
    );

    const summary = await this.monitor();

    logger.info(
      `Canary monitoring complete: ${summary.successCount}/${summary.totalChecks} passed ` +
      `(${summary.failureRate.toFixed(1)}% failure rate, avg ${summary.avgResponseTimeMs.toFixed(0)}ms)`
    );

    if (summary.failureRate > failureThresholdPercent) {
      return {
        success: false,
        message:
          `Canary monitoring FAILED: ${summary.failureRate.toFixed(1)}% failure rate ` +
          `exceeds ${failureThresholdPercent}% threshold ` +
          `(${summary.failureCount}/${summary.totalChecks} checks failed over ${durationMinutes}m). ` +
          `URL: ${healthUrl}`,
      };
    }

    return {
      success: true,
      message:
        `Canary monitoring PASSED: ${summary.failureRate.toFixed(1)}% failure rate ` +
        `(${summary.successCount}/${summary.totalChecks} checks passed over ${durationMinutes}m). ` +
        `URL: ${healthUrl}`,
    };
  }

  /**
   * Run the monitoring loop for the configured duration.
   */
  async monitor(): Promise<CanaryMonitoringSummary> {
    const { durationMinutes, intervalSeconds } = this.config;
    const durationMs = durationMinutes * 60 * 1000;
    const intervalMs = intervalSeconds * 1000;
    const startTime = Date.now();
    const checks: HealthCheckResult[] = [];

    // Calculate expected number of checks (at least 1)
    const expectedChecks = Math.max(1, Math.floor(durationMs / intervalMs) + 1);
    let checksPerformed = 0;

    while (checksPerformed < expectedChecks) {
      // Wait for interval before subsequent checks (not before the first)
      if (checksPerformed > 0) {
        await sleep(intervalMs);
      }

      const result = await this.performHealthCheck();
      checks.push(result);
      checksPerformed++;

      const status = result.success ? 'OK' : 'FAIL';
      logger.debug(
        `Health check #${checksPerformed}/${expectedChecks}: ${status} ` +
        `(${result.statusCode ?? 'N/A'}, ${result.responseTimeMs}ms)` +
        (result.error ? ` — ${result.error}` : '')
      );
    }

    const successCount = checks.filter((c) => c.success).length;
    const failureCount = checks.filter((c) => !c.success).length;
    const successfulChecks = checks.filter((c) => c.success);
    const avgResponseTimeMs =
      successfulChecks.length > 0
        ? successfulChecks.reduce((sum, c) => sum + c.responseTimeMs, 0) / successfulChecks.length
        : 0;

    return {
      totalChecks: checks.length,
      successCount,
      failureCount,
      failureRate: checks.length > 0 ? (failureCount / checks.length) * 100 : 0,
      avgResponseTimeMs,
      checks,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Perform a single health check against the configured URL.
   */
  async performHealthCheck(): Promise<HealthCheckResult> {
    const { healthUrl, requestTimeoutMs, expectedStatusCodes, fetchFn } = this.config;
    const startTime = Date.now();
    const doFetch = fetchFn ?? globalThis.fetch;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const response = await doFetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
          // Prevent caching
          headers: {
            'Cache-Control': 'no-cache',
          },
        });

        clearTimeout(timeoutId);
        const responseTimeMs = Date.now() - startTime;
        const statusCode = response.status;

        // Check if status is acceptable
        const isSuccessStatus = expectedStatusCodes
          ? expectedStatusCodes.includes(statusCode)
          : statusCode >= 200 && statusCode < 300;

        if (isSuccessStatus) {
          return {
            success: true,
            statusCode,
            responseTimeMs,
            timestamp: startTime,
          };
        }

        return {
          success: false,
          statusCode,
          responseTimeMs,
          error: `Unexpected status code: ${statusCode}`,
          timestamp: startTime,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Distinguish timeout from other errors
      const isTimeout = errorMessage.includes('abort') || errorMessage.includes('timeout');

      return {
        success: false,
        responseTimeMs,
        error: isTimeout ? `Request timed out after ${requestTimeoutMs}ms` : errorMessage,
        timestamp: startTime,
      };
    }
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
