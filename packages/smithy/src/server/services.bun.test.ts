import { describe, expect, test } from 'bun:test';
import { TaskStatus } from '@stoneforge/core';
import {
  accumulateMetricTokenUsage,
  deriveMetricOutcome,
  extractClaudeSessionMetrics,
  extractCodexSessionMetrics,
  extractMetricModel,
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

  test('extracts cumulative model and token totals from Codex session JSONL content', () => {
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
            total_token_usage: {
              input_tokens: 8796316,
              output_tokens: 53817,
            },
            last_token_usage: {
              input_tokens: 98821,
              output_tokens: 1546,
            },
          },
        },
      }),
    ].join('\n'));

    expect(metrics).toEqual({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      inputTokens: 8796316,
      outputTokens: 53817,
    });
  });

  test('extracts the actual model and accumulated usage from a Claude session log', () => {
    const metrics = extractClaudeSessionMetrics([
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 2, output_tokens: 41 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 3, output_tokens: 59 },
        },
      }),
    ].join('\n'));

    expect(metrics).toEqual({
      model: 'claude-opus-5',
      inputTokens: 5,
      outputTokens: 100,
    });
  });

  test('extracts models from provider init and result payloads', () => {
    expect(extractMetricModel({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    })).toBe('claude-sonnet-4-6');
    expect(extractMetricModel({
      type: 'result',
      modelUsage: {
        'claude-opus-5': { inputTokens: 10, outputTokens: 2 },
      },
    })).toBe('claude-opus-5');
  });

  test('marks reopened tasks as handoff outcomes', () => {
    expect(deriveMetricOutcome(TaskStatus.OPEN, 'completed')).toBe('handoff');
    expect(deriveMetricOutcome(TaskStatus.DEFERRED, 'completed')).toBe('handoff');
  });

  test('preserves rate_limited and failed outcomes before handoff state', () => {
    expect(deriveMetricOutcome(TaskStatus.IN_PROGRESS, 'rate_limited')).toBe('rate_limited');
    expect(deriveMetricOutcome(TaskStatus.OPEN, 'rate_limited')).toBe('rate_limited');
    expect(deriveMetricOutcome(TaskStatus.DEFERRED, 'failed')).toBe('failed');
  });
});
