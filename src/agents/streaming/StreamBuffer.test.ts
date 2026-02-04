/**
 * StreamBuffer Tests
 *
 * Tests for the stream buffer that handles chunked AI responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StreamBuffer,
  StreamChunk,
  StreamBufferConfig,
} from './StreamBuffer';

describe('StreamBuffer', () => {
  let buffer: StreamBuffer;

  beforeEach(() => {
    buffer = new StreamBuffer();
  });

  describe('initialization', () => {
    it('should initialize with idle state', () => {
      expect(buffer.getState()).toBe('idle');
    });

    it('should initialize with empty content', () => {
      expect(buffer.getContent()).toBe('');
    });

    it('should initialize with zero chunk count', () => {
      expect(buffer.getChunkCount()).toBe(0);
    });

    it('should accept custom configuration', () => {
      const config: StreamBufferConfig = {
        maxBufferSize: 1000,
        flushThreshold: 100,
      };
      const customBuffer = new StreamBuffer(config);
      expect(customBuffer).toBeDefined();
    });
  });

  describe('start', () => {
    it('should transition to streaming state', () => {
      buffer.start();
      expect(buffer.getState()).toBe('streaming');
    });

    it('should emit start event', () => {
      const listener = vi.fn();
      buffer.on('start', listener);
      buffer.start();
      expect(listener).toHaveBeenCalled();
    });

    it('should reset content on start', () => {
      // First streaming session
      buffer.start();
      buffer.append({ content: 'test', index: 0 });
      buffer.complete();

      // Start new session - should reset content
      buffer.start();
      expect(buffer.getContent()).toBe('');
    });

    it('should throw if already streaming', () => {
      buffer.start();
      expect(() => buffer.start()).toThrow('Buffer already streaming');
    });
  });

  describe('append', () => {
    beforeEach(() => {
      buffer.start();
    });

    it('should append chunk content', () => {
      buffer.append({ content: 'Hello', index: 0 });
      expect(buffer.getContent()).toBe('Hello');
    });

    it('should accumulate multiple chunks', () => {
      buffer.append({ content: 'Hello', index: 0 });
      buffer.append({ content: ' ', index: 1 });
      buffer.append({ content: 'World', index: 2 });
      expect(buffer.getContent()).toBe('Hello World');
    });

    it('should increment chunk count', () => {
      buffer.append({ content: 'a', index: 0 });
      buffer.append({ content: 'b', index: 1 });
      expect(buffer.getChunkCount()).toBe(2);
    });

    it('should emit chunk event', () => {
      const listener = vi.fn();
      buffer.on('chunk', listener);
      const chunk: StreamChunk = { content: 'test', index: 0 };
      buffer.append(chunk);
      expect(listener).toHaveBeenCalledWith(chunk);
    });

    it('should throw if not streaming', () => {
      const notStartedBuffer = new StreamBuffer();
      expect(() =>
        notStartedBuffer.append({ content: 'test', index: 0 })
      ).toThrow('Buffer not in streaming state');
    });

    it('should handle empty chunks', () => {
      buffer.append({ content: '', index: 0 });
      expect(buffer.getContent()).toBe('');
      expect(buffer.getChunkCount()).toBe(1);
    });
  });

  describe('complete', () => {
    beforeEach(() => {
      buffer.start();
      buffer.append({ content: 'test content', index: 0 });
    });

    it('should transition to complete state', () => {
      buffer.complete();
      expect(buffer.getState()).toBe('complete');
    });

    it('should emit complete event with final content', () => {
      const listener = vi.fn();
      buffer.on('complete', listener);
      buffer.complete();
      expect(listener).toHaveBeenCalledWith('test content');
    });

    it('should preserve final content', () => {
      buffer.complete();
      expect(buffer.getContent()).toBe('test content');
    });

    it('should throw if not streaming', () => {
      const notStartedBuffer = new StreamBuffer();
      expect(() => notStartedBuffer.complete()).toThrow(
        'Buffer not in streaming state'
      );
    });
  });

  describe('abort', () => {
    beforeEach(() => {
      buffer.start();
      buffer.append({ content: 'partial', index: 0 });
    });

    it('should transition to aborted state', () => {
      buffer.abort();
      expect(buffer.getState()).toBe('aborted');
    });

    it('should emit abort event with reason', () => {
      const listener = vi.fn();
      buffer.on('abort', listener);
      buffer.abort('User cancelled');
      expect(listener).toHaveBeenCalledWith('User cancelled');
    });

    it('should preserve partial content on abort', () => {
      buffer.abort();
      expect(buffer.getContent()).toBe('partial');
    });

    it('should use default reason if none provided', () => {
      const listener = vi.fn();
      buffer.on('abort', listener);
      buffer.abort();
      expect(listener).toHaveBeenCalledWith('Aborted');
    });
  });

  describe('error', () => {
    beforeEach(() => {
      buffer.start();
    });

    it('should transition to error state', () => {
      buffer.setError(new Error('Test error'));
      expect(buffer.getState()).toBe('error');
    });

    it('should emit error event', () => {
      const listener = vi.fn();
      buffer.on('error', listener);
      const error = new Error('Test error');
      buffer.setError(error);
      expect(listener).toHaveBeenCalledWith(error);
    });

    it('should store error', () => {
      const error = new Error('Test error');
      buffer.setError(error);
      expect(buffer.getError()).toBe(error);
    });
  });

  describe('reset', () => {
    it('should reset to idle state', () => {
      buffer.start();
      buffer.append({ content: 'test', index: 0 });
      buffer.complete();
      buffer.reset();
      expect(buffer.getState()).toBe('idle');
    });

    it('should clear content', () => {
      buffer.start();
      buffer.append({ content: 'test', index: 0 });
      buffer.reset();
      expect(buffer.getContent()).toBe('');
    });

    it('should clear chunk count', () => {
      buffer.start();
      buffer.append({ content: 'test', index: 0 });
      buffer.reset();
      expect(buffer.getChunkCount()).toBe(0);
    });

    it('should clear error', () => {
      buffer.start();
      buffer.setError(new Error('Test error'));
      buffer.reset();
      expect(buffer.getError()).toBeNull();
    });
  });

  describe('buffer size limits', () => {
    it('should respect max buffer size', () => {
      const smallBuffer = new StreamBuffer({ maxBufferSize: 10 });
      smallBuffer.start();
      smallBuffer.append({ content: '12345', index: 0 });
      smallBuffer.append({ content: '67890', index: 1 });
      // Should emit flush event when threshold reached
      const listener = vi.fn();
      smallBuffer.on('flush', listener);
      smallBuffer.append({ content: 'X', index: 2 });
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('event handling', () => {
    it('should allow multiple listeners per event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      buffer.on('start', listener1);
      buffer.on('start', listener2);
      buffer.start();
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should allow removing listeners', () => {
      const listener = vi.fn();
      buffer.on('start', listener);
      buffer.off('start', listener);
      buffer.start();
      expect(listener).not.toHaveBeenCalled();
    });

    it('should return unsubscribe function from on()', () => {
      const listener = vi.fn();
      const unsubscribe = buffer.on('start', listener);
      unsubscribe();
      buffer.start();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getStatistics', () => {
    it('should return buffer statistics', () => {
      buffer.start();
      buffer.append({ content: 'Hello', index: 0 });
      buffer.append({ content: ' World', index: 1 });

      const stats = buffer.getStatistics();
      expect(stats.chunkCount).toBe(2);
      expect(stats.totalBytes).toBe(11);
      expect(stats.state).toBe('streaming');
    });
  });
});
