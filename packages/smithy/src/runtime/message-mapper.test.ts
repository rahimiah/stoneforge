/**
 * Message Mapper Tests
 *
 * Tests for the SDK message to SpawnedSessionEvent mapper.
 * The message mapper is critical for transforming SDK messages into
 * the internal event format used by the orchestrator.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  mapSDKMessageToEvent,
  mapToolResultToEvent,
  mapSDKMessagesToEvents,
  type SDKAssistantMessage,
  type SDKUserMessage,
  type SDKSystemMessage,
  type SDKResultMessage,
  type SDKErrorMessage,
  type SDKContentBlock,
  type AnySDKMessage,
} from './message-mapper.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createAssistantMessage(content: string | SDKContentBlock[]): SDKAssistantMessage {
  return { type: 'assistant', content };
}

function createUserMessage(content: string): SDKUserMessage {
  return { type: 'user', content };
}

function createSystemMessage(
  subtype?: string,
  sessionId?: string,
  message?: string
): SDKSystemMessage {
  return { type: 'system', subtype, session_id: sessionId, message };
}

function createResultMessage(result?: string, status?: string): SDKResultMessage {
  return { type: 'result', result, status };
}

function createErrorMessage(error: string, message?: string): SDKErrorMessage {
  return { type: 'error', error, message };
}

function createTextBlock(text: string): SDKContentBlock {
  return { type: 'text', text };
}

function createToolUseBlock(name?: string, id?: string, input?: unknown): SDKContentBlock {
  return { type: 'tool_use', name, id, input };
}

function createToolResultBlock(
  toolUseId: string,
  content: string,
  isError?: boolean
): SDKContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

// ============================================================================
// Tests
// ============================================================================

describe('Message Mapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ----------------------------------------
  // Assistant Messages
  // ----------------------------------------

  describe('mapSDKMessageToEvent - assistant messages', () => {
    it('should map simple string content assistant message', () => {
      const message = createAssistantMessage('Hello, I am Claude.');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('assistant');
      expect(event.message).toBe('Hello, I am Claude.');
      expect(event.raw).toEqual({
        type: 'assistant',
        message: 'Hello, I am Claude.',
      });
      expect(event.receivedAt).toBeDefined();
    });

    it('should map assistant message with text content blocks', () => {
      const message = createAssistantMessage([
        createTextBlock('First paragraph.'),
        createTextBlock('Second paragraph.'),
      ]);
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('assistant');
      expect(event.message).toBe('First paragraph.\nSecond paragraph.');
    });

    it('should map assistant message with tool_use content blocks', () => {
      const message = createAssistantMessage([
        createTextBlock('Let me help you with that.'),
        createToolUseBlock('read_file', 'tool-123', { path: '/test.txt' }),
      ]);
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('tool_use');
      expect(event.tool).toEqual({
        name: 'read_file',
        id: 'tool-123',
        input: { path: '/test.txt' },
      });
      expect(event.message).toBe('Let me help you with that.');
    });

    it('should prioritize first tool_use block when multiple exist', () => {
      const message = createAssistantMessage([
        createToolUseBlock('tool_a', 'id-a', { arg: 'a' }),
        createToolUseBlock('tool_b', 'id-b', { arg: 'b' }),
      ]);
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('tool_use');
      expect(event.tool?.name).toBe('tool_a');
      expect(event.tool?.id).toBe('id-a');
    });

    it('should handle empty content array', () => {
      const message = createAssistantMessage([]);
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('assistant');
      expect(event.message).toBe('');
    });

    it('should handle tool_use without text blocks', () => {
      const message = createAssistantMessage([
        createToolUseBlock('bash', 'cmd-1', { command: 'ls' }),
      ]);
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('tool_use');
      expect(event.message).toBeUndefined();
      expect(event.tool?.name).toBe('bash');
    });

    it('should handle content blocks with empty text', () => {
      const message = createAssistantMessage([
        createTextBlock(''),
        createTextBlock('   '),
      ]);
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('assistant');
      expect(event.message).toBe('\n   ');
    });
  });

  // ----------------------------------------
  // User Messages
  // ----------------------------------------

  describe('mapSDKMessageToEvent - user messages', () => {
    it('should map user message correctly', () => {
      const message = createUserMessage('What is 2+2?');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('user');
      expect(event.message).toBe('What is 2+2?');
      expect(event.raw).toEqual({
        type: 'user',
        message: 'What is 2+2?',
      });
    });

    it('should handle empty user message', () => {
      const message = createUserMessage('');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('user');
      expect(event.message).toBe('');
    });

    it('should preserve special characters in user message', () => {
      const message = createUserMessage('Code: `console.log("test")` with <html> tags');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('user');
      expect(event.message).toBe('Code: `console.log("test")` with <html> tags');
    });
  });

  // ----------------------------------------
  // System Messages
  // ----------------------------------------

  describe('mapSDKMessageToEvent - system messages', () => {
    it('should map system message with all fields', () => {
      const message = createSystemMessage('init', 'session-abc', 'Session started');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('system');
      expect(event.subtype).toBe('init');
      expect(event.message).toBe('Session started');
      expect(event.raw).toEqual({
        type: 'system',
        subtype: 'init',
        session_id: 'session-abc',
        message: 'Session started',
      });
    });

    it('should handle system message without optional fields', () => {
      const message = createSystemMessage();
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('system');
      expect(event.subtype).toBeUndefined();
      expect(event.message).toBeUndefined();
    });

    it('should map system message with only subtype', () => {
      const message = createSystemMessage('shutdown');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('system');
      expect(event.subtype).toBe('shutdown');
    });
  });

  // ----------------------------------------
  // Result Messages
  // ----------------------------------------

  describe('mapSDKMessageToEvent - result messages', () => {
    it('should map result message with result text', () => {
      const message = createResultMessage('Task completed successfully', 'success');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('result');
      expect(event.message).toBe('Task completed successfully');
      expect(event.raw).toEqual({
        type: 'result',
        result: 'Task completed successfully',
      });
    });

    it('should handle result message without result text', () => {
      const message = createResultMessage();
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('result');
      expect(event.message).toBeUndefined();
    });
  });

  // ----------------------------------------
  // Error Messages
  // ----------------------------------------

  describe('mapSDKMessageToEvent - error messages', () => {
    it('should map error message with message field', () => {
      const message = createErrorMessage('API_ERROR', 'Rate limit exceeded');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('error');
      expect(event.message).toBe('Rate limit exceeded');
      expect(event.raw).toEqual({
        type: 'error',
        error: 'API_ERROR',
        message: 'Rate limit exceeded',
      });
    });

    it('should use error field as message when message not provided', () => {
      const message = createErrorMessage('CONNECTION_FAILED');
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('error');
      expect(event.message).toBe('CONNECTION_FAILED');
    });
  });

  // ----------------------------------------
  // Unknown Message Types
  // ----------------------------------------

  describe('mapSDKMessageToEvent - unknown message types', () => {
    it('should pass through unknown message types as system', () => {
      const message = { type: 'custom_type', data: 'test' } as unknown as AnySDKMessage;
      const event = mapSDKMessageToEvent(message);

      expect(event.type).toBe('custom_type');
      expect(event.raw).toEqual(message);
    });

    it('should handle message with missing type', () => {
      const message = { data: 'test' } as unknown as AnySDKMessage;
      const event = mapSDKMessageToEvent(message);

      // Should default to 'system' when type is undefined
      expect(event.type).toBe('system');
    });
  });

  // ----------------------------------------
  // Tool Result Mapping
  // ----------------------------------------

  describe('mapToolResultToEvent', () => {
    it('should create tool_result event', () => {
      const event = mapToolResultToEvent('tool-456', 'File contents here');

      expect(event.type).toBe('tool_result');
      expect(event.message).toBe('File contents here');
      expect(event.tool).toEqual({ id: 'tool-456' });
      expect(event.raw).toEqual({
        type: 'tool_result',
        tool_use_id: 'tool-456',
        content: 'File contents here',
        is_error: false,
      });
    });

    it('should mark error tool results', () => {
      const event = mapToolResultToEvent('tool-789', 'File not found', true);

      expect(event.type).toBe('tool_result');
      expect(event.raw?.is_error).toBe(true);
    });

    it('should use provided timestamp', () => {
      const timestamp = '2024-01-01T00:00:00.000Z' as any;
      const event = mapToolResultToEvent('tool-1', 'content', false, timestamp);

      expect(event.receivedAt).toBe(timestamp);
    });
  });

  // ----------------------------------------
  // Batch Processing
  // ----------------------------------------

  describe('mapSDKMessagesToEvents', () => {
    it('should map array of messages', () => {
      const messages: AnySDKMessage[] = [
        createUserMessage('Hello'),
        createAssistantMessage('Hi there!'),
        createResultMessage('Done'),
      ];

      const events = mapSDKMessagesToEvents(messages);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('user');
      expect(events[1].type).toBe('assistant');
      expect(events[2].type).toBe('result');
    });

    it('should handle empty array', () => {
      const events = mapSDKMessagesToEvents([]);
      expect(events).toHaveLength(0);
    });

    it('should preserve message order', () => {
      const messages: AnySDKMessage[] = [
        createUserMessage('1'),
        createUserMessage('2'),
        createUserMessage('3'),
      ];

      const events = mapSDKMessagesToEvents(messages);

      expect(events[0].message).toBe('1');
      expect(events[1].message).toBe('2');
      expect(events[2].message).toBe('3');
    });
  });

  // ----------------------------------------
  // Edge Cases
  // ----------------------------------------

  describe('edge cases', () => {
    it('should handle unicode content', () => {
      const message = createAssistantMessage('こんにちは 🎉 مرحبا');
      const event = mapSDKMessageToEvent(message);

      expect(event.message).toBe('こんにちは 🎉 مرحبا');
    });

    it('should handle very long content', () => {
      const longContent = 'a'.repeat(100000);
      const message = createAssistantMessage(longContent);
      const event = mapSDKMessageToEvent(message);

      expect(event.message).toBe(longContent);
      expect(event.message?.length).toBe(100000);
    });

    it('should handle newlines in content', () => {
      const message = createAssistantMessage('Line 1\nLine 2\r\nLine 3');
      const event = mapSDKMessageToEvent(message);

      expect(event.message).toBe('Line 1\nLine 2\r\nLine 3');
    });

    it('should handle tool_use with complex input', () => {
      const complexInput = {
        nested: { array: [1, 2, 3], object: { key: 'value' } },
        nullValue: null,
        boolValue: true,
      };
      const message = createAssistantMessage([
        createToolUseBlock('complex_tool', 'id-complex', complexInput),
      ]);
      const event = mapSDKMessageToEvent(message);

      expect(event.tool?.input).toEqual(complexInput);
    });

    it('should preserve receivedAt timestamp on all events', () => {
      const messages: AnySDKMessage[] = [
        createUserMessage('test'),
        createAssistantMessage('response'),
        createSystemMessage('init'),
        createResultMessage('done'),
        createErrorMessage('err'),
      ];

      const events = mapSDKMessagesToEvents(messages);

      events.forEach((event) => {
        expect(event.receivedAt).toBeDefined();
        expect(typeof event.receivedAt).toBe('string');
      });
    });
  });
});
