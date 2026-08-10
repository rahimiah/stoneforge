import { describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStatus } from '@stoneforge/core';
import {
  accumulateMetricTokenUsage,
  CODEX_SESSION_TAIL_BYTES,
  deriveMetricOutcome,
  extractCodexSessionMetrics,
  extractMessageTokenUsage,
  extractMetricModel,
  findCodexSessionFile,
  totalMessageTokenUsage,
  readCodexSessionMetrics,
} from './services.js';

function dateDirectory(root: string, date: Date): string {
  return join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  );
}

function sessionFileName(providerSessionId: string): string {
  return `rollout-2026-08-09T12-00-00-${providerSessionId}.jsonl`;
}

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

  test('searches only today and yesterday date directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stoneforge-codex-metrics-'));
    const now = new Date(2026, 7, 9, 12);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    try {
      const yesterdaySessionId = 'session-yesterday';
      const yesterdayDirectory = dateDirectory(root, yesterday);
      await mkdir(yesterdayDirectory, { recursive: true });
      const yesterdayFile = join(yesterdayDirectory, sessionFileName(yesterdaySessionId));
      await writeFile(yesterdayFile, '{}\n');

      const oldSessionId = 'session-too-old';
      const oldDirectory = dateDirectory(root, twoDaysAgo);
      await mkdir(oldDirectory, { recursive: true });
      await writeFile(join(oldDirectory, sessionFileName(oldSessionId)), '{}\n');

      expect(await findCodexSessionFile(yesterdaySessionId, root, now)).toBe(yesterdayFile);
      expect(await findCodexSessionFile(oldSessionId, root, now)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reads only a bounded tail from Codex session files larger than 1 MB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stoneforge-codex-metrics-'));
    const now = new Date(2026, 7, 9, 12);
    const providerSessionId = 'session-large';
    const directory = dateDirectory(root, now);

    try {
      await mkdir(directory, { recursive: true });
      const sessionFile = join(directory, sessionFileName(providerSessionId));
      const tokenEntry = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 42,
              output_tokens: 7,
            },
          },
        },
      });
      await writeFile(
        sessionFile,
        `${'x'.repeat(1024 * 1024 + CODEX_SESSION_TAIL_BYTES)}\n${tokenEntry}\n`
      );

      await expect(
        readCodexSessionMetrics('codex', providerSessionId, { sessionsRoot: root, now })
      ).resolves.toEqual({
        model: undefined,
        modelProvider: undefined,
        inputTokens: 42,
        outputTokens: 7,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('skips Codex filesystem metrics for non-Codex providers', async () => {
    let filesystemOptionsAccessed = false;
    const options = {
      get sessionsRoot(): string {
        filesystemOptionsAccessed = true;
        throw new Error('non-Codex metrics must not access the sessions root');
      },
      get now(): Date {
        filesystemOptionsAccessed = true;
        throw new Error('non-Codex metrics must not resolve date directories');
      },
    };

    await expect(
      readCodexSessionMetrics('claude', 'session-non-codex', options)
    ).resolves.toBeUndefined();
    expect(filesystemOptionsAccessed).toBeFalse();
  });

  test('warns with the file name when a found Codex session file is unusable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stoneforge-codex-metrics-'));
    const now = new Date(2026, 7, 9, 12);
    const providerSessionId = 'session-unusable';
    const directory = dateDirectory(root, now);
    const sessionFile = join(directory, sessionFileName(providerSessionId));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(sessionFile, 'not-json\n{"type":"unrecognized"}\n');

      await expect(
        readCodexSessionMetrics('codex', providerSessionId, { sessionsRoot: root, now })
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[orchestrator]',
        expect.stringContaining(sessionFile)
      );
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
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

describe('OpenCode per-message token usage', () => {
  // OpenCode reports usage as properties.info.tokens = { input, output, ... } on an
  // assistant message. extractTokenUsage does not recognise that shape, which is why
  // OpenCode sessions recorded a correct model but zero tokens.
  const messageUpdated = (id: string, input: number, output: number) => ({
    type: 'message.updated',
    properties: {
      info: {
        id,
        sessionID: 'ses_1',
        role: 'assistant',
        cost: 0.01,
        tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  });

  test('extracts usage and the owning message id', () => {
    expect(extractMessageTokenUsage(messageUpdated('msg_1', 120, 45))).toEqual({
      messageId: 'msg_1',
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  test('ignores user messages, which carry no tokens', () => {
    expect(extractMessageTokenUsage({
      type: 'message.updated',
      properties: { info: { id: 'msg_u', sessionID: 'ses_1', role: 'user' } },
    })).toBeUndefined();
  });

  test('ignores unrelated events', () => {
    expect(extractMessageTokenUsage({ type: 'session.status' })).toBeUndefined();
    expect(extractMessageTokenUsage(null)).toBeUndefined();
    expect(extractMessageTokenUsage({ properties: {} })).toBeUndefined();
  });

  test('does NOT overcount when a message streams cumulative updates', () => {
    // The defect this design exists to prevent: message.updated fires repeatedly
    // for one message with a RUNNING TOTAL. Summing every event would report
    // 60+180+300 = 540 input tokens for a message that actually used 300.
    const perMessage = new Map<string, { inputTokens: number; outputTokens: number }>();
    for (const ev of [
      messageUpdated('msg_1', 60, 10),
      messageUpdated('msg_1', 180, 40),
      messageUpdated('msg_1', 300, 90),
    ]) {
      const u = extractMessageTokenUsage(ev)!;
      perMessage.set(u.messageId, { inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    }

    expect(totalMessageTokenUsage(perMessage)).toEqual({ inputTokens: 300, outputTokens: 90 });
  });

  test('sums across distinct messages in a session', () => {
    const perMessage = new Map<string, { inputTokens: number; outputTokens: number }>();
    for (const ev of [
      messageUpdated('msg_1', 100, 20),
      messageUpdated('msg_1', 150, 30),
      messageUpdated('msg_2', 200, 70),
    ]) {
      const u = extractMessageTokenUsage(ev)!;
      perMessage.set(u.messageId, { inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    }

    expect(totalMessageTokenUsage(perMessage)).toEqual({ inputTokens: 350, outputTokens: 100 });
  });

  test('totals an empty map to zero', () => {
    expect(totalMessageTokenUsage(new Map())).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test('the additive path still ignores the OpenCode shape, so they cannot double count', () => {
    // accumulateMetricTokenUsage must not also match message.updated, or a session
    // would be counted twice.
    expect(accumulateMetricTokenUsage(
      { inputTokens: 0, outputTokens: 0 },
      messageUpdated('msg_1', 120, 45)
    )).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
