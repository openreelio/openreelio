/**
 * StreamingAgent Tests
 *
 * Tests for the streaming agent that processes AI responses in real-time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StreamingAgent,
  StreamingAgentConfig,
} from './StreamingAgent';
import type { AgentContext } from '../Agent';

// Mock agent for testing
class TestStreamingAgent extends StreamingAgent {
  private mockChunks: string[] = [];
  private mockError: Error | null = null;
  private mockDelay: number = 0;

  constructor(config?: Partial<StreamingAgentConfig>) {
    super({
      name: 'test-streaming-agent',
      description: 'Test streaming agent',
      ...config,
    });
  }

  setMockChunks(chunks: string[]): void {
    this.mockChunks = chunks;
  }

  setMockError(error: Error): void {
    this.mockError = error;
  }

  setMockDelay(delay: number): void {
    this.mockDelay = delay;
  }

  protected async *generateStream(
    _input: string,
    _context: AgentContext
  ): AsyncGenerator<string> {
    void _input;
    void _context;
    if (this.mockError) {
      throw this.mockError;
    }

    for (const chunk of this.mockChunks) {
      if (this.mockDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.mockDelay));
      }
      yield chunk;
    }
  }

  // Expose protected methods for testing
  public testGenerateStream(
    input: string,
    context: AgentContext
  ): AsyncGenerator<string> {
    return this.generateStream(input, context);
  }
}

describe('StreamingAgent', () => {
  let agent: TestStreamingAgent;

  beforeEach(() => {
    agent = new TestStreamingAgent();
  });

  describe('initialization', () => {
    it('should create agent with name and description', () => {
      expect(agent.name).toBe('test-streaming-agent');
      expect(agent.description).toBe('Test streaming agent');
    });

    it('should not be streaming initially', () => {
      expect(agent.isStreaming()).toBe(false);
    });

    it('should accept custom configuration', () => {
      const customAgent = new TestStreamingAgent({
        maxIterations: 5,
      });
      expect(customAgent).toBeDefined();
    });
  });

  describe('runWithStreaming', () => {
    it('should stream chunks to callback', async () => {
      agent.setMockChunks(['Hello', ' ', 'World']);

      const chunks: string[] = [];
      await agent.runWithStreaming('test input', {}, (chunk) => {
        chunks.push(chunk);
      });

      expect(chunks).toEqual(['Hello', ' ', 'World']);
    });

    it('should return final response', async () => {
      agent.setMockChunks(['Hello', ' ', 'World']);

      const response = await agent.runWithStreaming('test input', {}, vi.fn());

      expect(response.content).toBe('Hello World');
      expect(response.success).toBe(true);
    });

    it('should set streaming state during execution', async () => {
      agent.setMockChunks(['chunk']);
      agent.setMockDelay(10);

      const streamingPromise = agent.runWithStreaming(
        'test',
        {},
        () => {}
      );

      // Small delay to allow streaming to start
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(agent.isStreaming()).toBe(true);

      await streamingPromise;
      expect(agent.isStreaming()).toBe(false);
    });

    it('should handle empty response', async () => {
      agent.setMockChunks([]);

      const response = await agent.runWithStreaming('test', {}, vi.fn());

      expect(response.content).toBe('');
      expect(response.success).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      agent.setMockError(new Error('Stream error'));

      const response = await agent.runWithStreaming('test', {}, vi.fn());

      expect(response.success).toBe(false);
      expect(response.error).toBe('Stream error');
    });

    it('should emit streaming events', async () => {
      agent.setMockChunks(['chunk1', 'chunk2']);

      const startListener = vi.fn();
      const chunkListener = vi.fn();
      const endListener = vi.fn();

      agent.on('streamStart', startListener);
      agent.on('streamChunk', chunkListener);
      agent.on('streamEnd', endListener);

      await agent.runWithStreaming('test', {}, vi.fn());

      expect(startListener).toHaveBeenCalledTimes(1);
      expect(chunkListener).toHaveBeenCalledTimes(2);
      expect(endListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort', () => {
    it('should abort ongoing stream', async () => {
      agent.setMockChunks(['chunk1', 'chunk2', 'chunk3']);
      agent.setMockDelay(50);

      const chunks: string[] = [];
      const streamPromise = agent.runWithStreaming('test', {}, (chunk) => {
        chunks.push(chunk);
      });

      // Abort after first chunk
      await new Promise((resolve) => setTimeout(resolve, 60));
      agent.abort();

      const response = await streamPromise;

      expect(response.success).toBe(false);
      expect(response.aborted).toBe(true);
      expect(chunks.length).toBeLessThan(3);
    });

    it('should emit abort event', async () => {
      agent.setMockChunks(['chunk']);
      agent.setMockDelay(50);

      const abortListener = vi.fn();
      agent.on('streamAbort', abortListener);

      const streamPromise = agent.runWithStreaming('test', {}, vi.fn());

      await new Promise((resolve) => setTimeout(resolve, 10));
      agent.abort();

      await streamPromise;

      expect(abortListener).toHaveBeenCalled();
    });

    it('should do nothing if not streaming', () => {
      expect(() => agent.abort()).not.toThrow();
    });
  });

  describe('getStreamBuffer', () => {
    it('should return current buffer content', async () => {
      agent.setMockChunks(['Hello', ' World']);

      await agent.runWithStreaming('test', {}, vi.fn());

      expect(agent.getStreamBuffer()).toBe('Hello World');
    });

    it('should return empty string before streaming', () => {
      expect(agent.getStreamBuffer()).toBe('');
    });
  });

  describe('context handling', () => {
    it('should pass context to stream generator', async () => {
      const contextSpy = vi.fn();

      class ContextTestAgent extends StreamingAgent {
        protected async *generateStream(
          _input: string,
          context: AgentContext
        ): AsyncGenerator<string> {
          contextSpy(context);
          yield 'test';
        }
      }

      const contextAgent = new ContextTestAgent({
        name: 'context-test',
        description: 'Test context passing',
      });

      const testContext: AgentContext = {
        projectId: 'proj_001',
        sequenceId: 'seq_001',
        playheadPosition: 5.5,
      };

      await contextAgent.runWithStreaming('test', testContext, vi.fn());

      expect(contextSpy).toHaveBeenCalledWith(testContext);
    });
  });

  describe('concurrent streams', () => {
    it('should reject concurrent streaming attempts', async () => {
      agent.setMockChunks(['chunk']);
      agent.setMockDelay(100);

      const firstStream = agent.runWithStreaming('test1', {}, vi.fn());

      // Try to start second stream while first is running
      await new Promise((resolve) => setTimeout(resolve, 10));

      const secondStreamResult = await agent.runWithStreaming(
        'test2',
        {},
        vi.fn()
      );

      await firstStream;

      expect(secondStreamResult.success).toBe(false);
      expect(secondStreamResult.error).toContain('already streaming');
    });
  });

  describe('cleanup', () => {
    it('should clean up after successful stream', async () => {
      agent.setMockChunks(['chunk']);

      await agent.runWithStreaming('test', {}, vi.fn());

      expect(agent.isStreaming()).toBe(false);
    });

    it('should clean up after error', async () => {
      agent.setMockError(new Error('Test error'));

      await agent.runWithStreaming('test', {}, vi.fn());

      expect(agent.isStreaming()).toBe(false);
    });

    it('should clean up after abort', async () => {
      agent.setMockChunks(['chunk']);
      agent.setMockDelay(100);

      const streamPromise = agent.runWithStreaming('test', {}, vi.fn());

      await new Promise((resolve) => setTimeout(resolve, 10));
      agent.abort();

      await streamPromise;

      expect(agent.isStreaming()).toBe(false);
    });
  });
});
