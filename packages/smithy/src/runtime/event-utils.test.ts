/**
 * Event Utils Tests
 *
 * Tests for the event utility functions used to manage EventEmitter listeners.
 * These utilities are critical for preventing memory leaks from unremoved listeners
 * and MaxListenersExceededWarning issues.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { trackListeners } from './event-utils.js';

// ============================================================================
// Tests
// ============================================================================

describe('Event Utils', () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    emitter = new EventEmitter();
    // Start with a reasonable default
    emitter.setMaxListeners(10);
  });

  afterEach(() => {
    vi.resetAllMocks();
    emitter.removeAllListeners();
  });

  // ----------------------------------------
  // trackListeners
  // ----------------------------------------

  describe('trackListeners', () => {
    it('should add event listeners', () => {
      const handler = vi.fn();

      trackListeners(emitter, {
        data: handler,
      });

      emitter.emit('data', 'test');
      expect(handler).toHaveBeenCalledWith('test');
    });

    it('should increase maxListeners by listener count', () => {
      const initialMax = emitter.getMaxListeners();

      trackListeners(emitter, {
        event1: vi.fn(),
        event2: vi.fn(),
        event3: vi.fn(),
      });

      expect(emitter.getMaxListeners()).toBe(initialMax + 3);
    });

    it('should return cleanup function', () => {
      const cleanup = trackListeners(emitter, {
        data: vi.fn(),
      });

      expect(typeof cleanup).toBe('function');
    });

    it('should remove listeners on cleanup', () => {
      const handler = vi.fn();
      const cleanup = trackListeners(emitter, {
        data: handler,
      });

      cleanup();

      emitter.emit('data', 'test');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should decrease maxListeners on cleanup', () => {
      const initialMax = emitter.getMaxListeners();

      const cleanup = trackListeners(emitter, {
        event1: vi.fn(),
        event2: vi.fn(),
      });

      expect(emitter.getMaxListeners()).toBe(initialMax + 2);

      cleanup();

      expect(emitter.getMaxListeners()).toBe(initialMax);
    });

    it('should handle multiple event types', () => {
      const dataHandler = vi.fn();
      const errorHandler = vi.fn();
      const closeHandler = vi.fn();

      trackListeners(emitter, {
        data: dataHandler,
        error: errorHandler,
        close: closeHandler,
      });

      emitter.emit('data', 'data-value');
      emitter.emit('error', new Error('test error'));
      emitter.emit('close');

      expect(dataHandler).toHaveBeenCalledWith('data-value');
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
      expect(closeHandler).toHaveBeenCalled();
    });

    it('should be idempotent for cleanup', () => {
      const initialMax = emitter.getMaxListeners();
      const handler = vi.fn();

      const cleanup = trackListeners(emitter, {
        data: handler,
      });

      cleanup();
      cleanup(); // Second cleanup should be no-op
      cleanup(); // Third cleanup should also be no-op

      expect(emitter.getMaxListeners()).toBe(initialMax);
      expect(emitter.listenerCount('data')).toBe(0);
    });

    it('should not go below zero maxListeners', () => {
      emitter.setMaxListeners(1);

      const cleanup = trackListeners(emitter, {
        event1: vi.fn(),
        event2: vi.fn(),
        event3: vi.fn(),
      });

      expect(emitter.getMaxListeners()).toBe(4);

      cleanup();

      // Should be back to 1, not negative
      expect(emitter.getMaxListeners()).toBe(1);
    });

    it('should handle zero initial maxListeners', () => {
      emitter.setMaxListeners(0); // 0 means unlimited

      const cleanup = trackListeners(emitter, {
        data: vi.fn(),
      });

      // 0 + 1 = 1
      expect(emitter.getMaxListeners()).toBe(1);

      cleanup();

      // max(0, 1 - 1) = 0
      expect(emitter.getMaxListeners()).toBe(0);
    });

    it('should handle empty listeners object', () => {
      const initialMax = emitter.getMaxListeners();

      const cleanup = trackListeners(emitter, {});

      expect(emitter.getMaxListeners()).toBe(initialMax);

      cleanup();

      expect(emitter.getMaxListeners()).toBe(initialMax);
    });

    it('should work with async handlers', async () => {
      const asyncHandler = vi.fn().mockResolvedValue('done');

      trackListeners(emitter, {
        async: asyncHandler,
      });

      emitter.emit('async', 'arg1', 'arg2');

      expect(asyncHandler).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should pass all arguments to handlers', () => {
      const handler = vi.fn();

      trackListeners(emitter, {
        multi: handler,
      });

      emitter.emit('multi', 'a', 'b', 'c', 123);

      expect(handler).toHaveBeenCalledWith('a', 'b', 'c', 123);
    });

    it('should support multiple independent tracking sessions', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const cleanup1 = trackListeners(emitter, { data: handler1 });
      const cleanup2 = trackListeners(emitter, { data: handler2 });

      emitter.emit('data', 'test');

      expect(handler1).toHaveBeenCalledWith('test');
      expect(handler2).toHaveBeenCalledWith('test');

      cleanup1();

      emitter.emit('data', 'test2');

      expect(handler1).toHaveBeenCalledTimes(1); // Not called again
      expect(handler2).toHaveBeenCalledTimes(2); // Called again

      cleanup2();

      emitter.emit('data', 'test3');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(2);
    });

    it('should track correctly with high initial maxListeners', () => {
      emitter.setMaxListeners(100);

      const cleanup = trackListeners(emitter, {
        a: vi.fn(),
        b: vi.fn(),
      });

      expect(emitter.getMaxListeners()).toBe(102);

      cleanup();

      expect(emitter.getMaxListeners()).toBe(100);
    });

    it('should handle listener that throws', () => {
      const throwingHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const otherHandler = vi.fn();

      trackListeners(emitter, {
        event: throwingHandler,
        other: otherHandler,
      });

      expect(() => {
        emitter.emit('event');
      }).toThrow('Handler error');

      // Other events should still work
      emitter.emit('other');
      expect(otherHandler).toHaveBeenCalled();
    });
  });
});
