import { describe, expect, test } from 'bun:test';
import { TaskStatus } from '@stoneforge/core';
import {
  accumulateMetricTokenUsage,
  deriveMetricOutcome,
  extractCodexSessionMetrics,
} from './services.js';

describe('server metrics helpers', () => {
  test('accumulates token usage across multiple payloads', () => {
    const afterFirst = accumulateMetricTokenUsage(
      { inputTokens: 0, outputTokens: 0 },
      { usage: { input_tokens: 12, output_tokens: 4 } }
    );
    const afterSecond = accumulateMetricTokenUsage(
      afterFirst,
      { usage: { input_tokens: 8, output_tokens: 6 } }
    );

    expect(afterSecond).toEqual({
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  test('extracts model and tokens from Codex session JSONL content', () => {
    const metrics = extractCodexSessionMetrics([
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: '019fe8c6-2307-7081-9370-a8171bced1b8',
          model_provider: 'openai',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.6-sol',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 17079,
              output_tokens: 5,
            },
          },
        },
      }),
    ].join('\n'));

    expect(metrics).toEqual({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      inputTokens: 17079,
      outputTokens: 5,
    });
  });

  test('marks reopened tasks as handoff outcomes', () => {
    expect(deriveMetricOutcome(TaskStatus.OPEN, 'completed')).toBe('handoff');
    expect(deriveMetricOutcome(TaskStatus.DEFERRED, 'failed')).toBe('handoff');
  });

  test('preserves rate_limited outcomes when task is not handed off', () => {
    expect(deriveMetricOutcome(TaskStatus.IN_PROGRESS, 'rate_limited')).toBe('rate_limited');
    expect(deriveMetricOutcome(undefined, 'rate_limited')).toBe('rate_limited');
  });
});
