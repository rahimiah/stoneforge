/**
 * Metrics Service Unit Tests
 *
 * Tests for the MetricsService backed by SQLite provider_metrics table.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import {
  createMetricsService,
  type MetricsService,
  type RecordMetricInput,
} from './metrics-service.js';

describe('MetricsService', () => {
  let service: MetricsService;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = `/tmp/metrics-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const storage = createStorage({ path: testDbPath });
    initializeSchema(storage);
    service = createMetricsService(storage);
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  // ========================================================================
  // record()
  // ========================================================================

  describe('record', () => {
    test('records a metric entry without errors', () => {
      expect(() => {
        service.record({
          provider: 'claude-code',
          model: 'claude-sonnet-4',
          sessionId: 'session-1',
          taskId: 'el-abc1',
          inputTokens: 1000,
          outputTokens: 500,
          durationMs: 5000,
          outcome: 'completed',
        });
      }).not.toThrow();
    });

    test('records a metric entry with optional fields omitted', () => {
      expect(() => {
        service.record({
          provider: 'claude-code',
          sessionId: 'session-2',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 1000,
          outcome: 'failed',
        });
      }).not.toThrow();
    });

    test('records multiple metric entries', () => {
      for (let i = 0; i < 5; i++) {
        service.record({
          provider: 'claude-code',
          model: 'claude-sonnet-4',
          sessionId: `session-${i}`,
          inputTokens: 100 * (i + 1),
          outputTokens: 50 * (i + 1),
          durationMs: 1000 * (i + 1),
          outcome: 'completed',
        });
      }

      const result = service.aggregateByProvider({ days: 7 });
      expect(result).toHaveLength(1);
      expect(result[0].sessionCount).toBe(5);
    });
  });

  // ========================================================================
  // aggregateByProvider()
  // ========================================================================

  describe('aggregateByProvider', () => {
    test('returns empty array when no metrics exist', () => {
      const result = service.aggregateByProvider({ days: 7 });
      expect(result).toEqual([]);
    });

    test('aggregates metrics by provider', () => {
      service.record({
        provider: 'claude-code',
        model: 'claude-sonnet-4',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });
      service.record({
        provider: 'claude-code',
        model: 'claude-opus-4',
        sessionId: 'session-2',
        inputTokens: 2000,
        outputTokens: 1000,
        durationMs: 10000,
        outcome: 'completed',
      });
      service.record({
        provider: 'opencode',
        sessionId: 'session-3',
        inputTokens: 500,
        outputTokens: 200,
        durationMs: 3000,
        outcome: 'completed',
      });

      const result = service.aggregateByProvider({ days: 7 });
      expect(result).toHaveLength(2);

      const claudeMetric = result.find(m => m.group === 'claude-code');
      expect(claudeMetric).toBeDefined();
      expect(claudeMetric!.totalInputTokens).toBe(3000);
      expect(claudeMetric!.totalOutputTokens).toBe(1500);
      expect(claudeMetric!.totalTokens).toBe(4500);
      expect(claudeMetric!.sessionCount).toBe(2);
      expect(claudeMetric!.avgDurationMs).toBe(7500);
      expect(claudeMetric!.errorRate).toBe(0);

      const opencodeMetric = result.find(m => m.group === 'opencode');
      expect(opencodeMetric).toBeDefined();
      expect(opencodeMetric!.totalInputTokens).toBe(500);
      expect(opencodeMetric!.sessionCount).toBe(1);
    });

    test('calculates error rate correctly', () => {
      service.record({
        provider: 'claude-code',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });
      service.record({
        provider: 'claude-code',
        sessionId: 'session-2',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'failed',
      });
      service.record({
        provider: 'claude-code',
        sessionId: 'session-3',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'rate_limited',
      });
      service.record({
        provider: 'claude-code',
        sessionId: 'session-4',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });

      const result = service.aggregateByProvider({ days: 7 });
      expect(result).toHaveLength(1);
      expect(result[0].errorRate).toBe(0.25); // 1 failed / 4 total
      expect(result[0].failedCount).toBe(1);
      expect(result[0].rateLimitedCount).toBe(1);
    });

    test('respects time range filter', () => {
      // Record one metric now
      service.record({
        provider: 'claude-code',
        sessionId: 'session-recent',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });

      // Query for last 7 days — should find it
      const result7d = service.aggregateByProvider({ days: 7 });
      expect(result7d).toHaveLength(1);
      expect(result7d[0].sessionCount).toBe(1);
    });

    test('orders by total tokens descending', () => {
      service.record({
        provider: 'small-provider',
        sessionId: 'session-1',
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
        outcome: 'completed',
      });
      service.record({
        provider: 'big-provider',
        sessionId: 'session-2',
        inputTokens: 10000,
        outputTokens: 5000,
        durationMs: 30000,
        outcome: 'completed',
      });

      const result = service.aggregateByProvider({ days: 7 });
      expect(result[0].group).toBe('big-provider');
      expect(result[1].group).toBe('small-provider');
    });
  });

  // ========================================================================
  // aggregateByModel()
  // ========================================================================

  describe('aggregateByModel', () => {
    test('returns empty array when no metrics exist', () => {
      const result = service.aggregateByModel({ days: 7 });
      expect(result).toEqual([]);
    });

    test('aggregates metrics by model', () => {
      service.record({
        provider: 'claude-code',
        model: 'claude-sonnet-4',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });
      service.record({
        provider: 'claude-code',
        model: 'claude-opus-4',
        sessionId: 'session-2',
        inputTokens: 2000,
        outputTokens: 1000,
        durationMs: 10000,
        outcome: 'completed',
      });
      service.record({
        provider: 'claude-code',
        model: 'claude-sonnet-4',
        sessionId: 'session-3',
        inputTokens: 1500,
        outputTokens: 700,
        durationMs: 6000,
        outcome: 'completed',
      });

      const result = service.aggregateByModel({ days: 7 });
      expect(result).toHaveLength(2);

      const sonnetMetric = result.find(m => m.group === 'claude-sonnet-4');
      expect(sonnetMetric).toBeDefined();
      expect(sonnetMetric!.sessionCount).toBe(2);
      expect(sonnetMetric!.totalInputTokens).toBe(2500);
    });

    test('groups null model as "unknown"', () => {
      service.record({
        provider: 'claude-code',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });

      const result = service.aggregateByModel({ days: 7 });
      expect(result).toHaveLength(1);
      expect(result[0].group).toBe('unknown');
    });
  });

  // ========================================================================
  // getTimeSeries()
  // ========================================================================

  describe('getTimeSeries', () => {
    test('returns empty array when no metrics exist', () => {
      const result = service.getTimeSeries({ days: 7 }, 'provider');
      expect(result).toEqual([]);
    });

    test('returns time-bucketed data grouped by provider', () => {
      service.record({
        provider: 'claude-code',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });

      const result = service.getTimeSeries({ days: 7 }, 'provider');
      expect(result).toHaveLength(1);
      expect(result[0].group).toBe('claude-code');
      expect(result[0].totalInputTokens).toBe(1000);
      expect(result[0].totalOutputTokens).toBe(500);
      expect(result[0].sessionCount).toBe(1);
      expect(result[0].bucket).toBeDefined();
    });

    test('returns time-bucketed data grouped by model', () => {
      service.record({
        provider: 'claude-code',
        model: 'claude-sonnet-4',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });

      const result = service.getTimeSeries({ days: 7 }, 'model');
      expect(result).toHaveLength(1);
      expect(result[0].group).toBe('claude-sonnet-4');
    });

    test('produces separate buckets for different groups', () => {
      service.record({
        provider: 'claude-code',
        sessionId: 'session-1',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
        outcome: 'completed',
      });
      service.record({
        provider: 'opencode',
        sessionId: 'session-2',
        inputTokens: 500,
        outputTokens: 200,
        durationMs: 3000,
        outcome: 'completed',
      });

      const result = service.getTimeSeries({ days: 7 }, 'provider');
      // Both recorded on the same day, so we get 2 entries (one per provider, same bucket)
      expect(result).toHaveLength(2);
      const providers = result.map(r => r.group).sort();
      expect(providers).toEqual(['claude-code', 'opencode']);
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe('edge cases', () => {
    test('handles zero tokens correctly', () => {
      service.record({
        provider: 'claude-code',
        sessionId: 'session-1',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        outcome: 'completed',
      });

      const result = service.aggregateByProvider({ days: 7 });
      expect(result).toHaveLength(1);
      expect(result[0].totalTokens).toBe(0);
      expect(result[0].avgDurationMs).toBe(0);
    });

    test('handles very large token counts', () => {
      service.record({
        provider: 'claude-code',
        sessionId: 'session-1',
        inputTokens: 10_000_000,
        outputTokens: 5_000_000,
        durationMs: 300_000,
        outcome: 'completed',
      });

      const result = service.aggregateByProvider({ days: 7 });
      expect(result[0].totalTokens).toBe(15_000_000);
    });

    test('handles all outcome types', () => {
      const outcomes: Array<'completed' | 'failed' | 'rate_limited' | 'handoff'> = [
        'completed', 'failed', 'rate_limited', 'handoff'
      ];

      for (const outcome of outcomes) {
        service.record({
          provider: 'claude-code',
          sessionId: `session-${outcome}`,
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 1000,
          outcome,
        });
      }

      const result = service.aggregateByProvider({ days: 7 });
      expect(result[0].sessionCount).toBe(4);
      expect(result[0].failedCount).toBe(1);
      expect(result[0].rateLimitedCount).toBe(1);
    });
  });
});
