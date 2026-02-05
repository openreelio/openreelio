/**
 * Agent Hooks Tests
 *
 * Tests for hook registration and execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HookManager,
  createHookManager,
  type PreToolUseHook,
} from './AgentHooks';

describe('HookManager', () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = createHookManager();
  });

  describe('registration', () => {
    it('should return unsubscribe function that removes hook', () => {
      const hook: PreToolUseHook = () => ({ shouldProceed: true });
      const unsubscribe = manager.onPreToolUse(hook);

      expect(manager.getHookCounts().preToolUse).toBe(1);

      unsubscribe();

      expect(manager.getHookCounts().preToolUse).toBe(0);
    });

    it('should allow multiple hooks of the same type', () => {
      manager.onPreToolUse(() => ({ shouldProceed: true }));
      manager.onPreToolUse(() => ({ shouldProceed: true }));
      manager.onPreToolUse(() => ({ shouldProceed: true }));

      expect(manager.getHookCounts().preToolUse).toBe(3);
    });

    it('should register hooks of different types independently', () => {
      manager.onPreToolUse(() => ({ shouldProceed: true }));
      manager.onPostToolUse(() => ({}));
      manager.onPreMessage(() => ({ shouldProceed: true }));
      manager.onPostMessage(() => ({}));

      const counts = manager.getHookCounts();
      expect(counts.preToolUse).toBe(1);
      expect(counts.postToolUse).toBe(1);
      expect(counts.preMessage).toBe(1);
      expect(counts.postMessage).toBe(1);
    });

    it('should clear all hooks', () => {
      manager.onPreToolUse(() => ({ shouldProceed: true }));
      manager.onPostToolUse(() => ({}));
      manager.onPreMessage(() => ({ shouldProceed: true }));
      manager.onPostMessage(() => ({}));

      manager.clearAll();

      const counts = manager.getHookCounts();
      expect(counts.preToolUse).toBe(0);
      expect(counts.postToolUse).toBe(0);
      expect(counts.preMessage).toBe(0);
      expect(counts.postMessage).toBe(0);
    });
  });

  describe('preToolUse hooks', () => {
    it('should execute hooks in priority order (high -> normal -> low)', async () => {
      const executionOrder: string[] = [];

      manager.onPreToolUse(
        () => {
          executionOrder.push('normal');
          return { shouldProceed: true };
        },
        { priority: 'normal' }
      );

      manager.onPreToolUse(
        () => {
          executionOrder.push('low');
          return { shouldProceed: true };
        },
        { priority: 'low' }
      );

      manager.onPreToolUse(
        () => {
          executionOrder.push('high');
          return { shouldProceed: true };
        },
        { priority: 'high' }
      );

      await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: {},
        callId: 'call_001',
      });

      expect(executionOrder).toEqual(['high', 'normal', 'low']);
    });

    it('should allow hook to modify arguments', async () => {
      manager.onPreToolUse((ctx) => ({
        shouldProceed: true,
        modifiedArgs: { ...ctx.args, added: 'value' },
      }));

      const result = await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: { original: 'arg' },
        callId: 'call_001',
      });

      expect(result.shouldProceed).toBe(true);
      expect(result.modifiedArgs).toEqual({
        original: 'arg',
        added: 'value',
      });
    });

    it('should chain argument modifications across hooks', async () => {
      manager.onPreToolUse(() => ({
        shouldProceed: true,
        modifiedArgs: { step1: true },
      }));

      manager.onPreToolUse((ctx) => ({
        shouldProceed: true,
        modifiedArgs: { ...ctx.args, step2: true },
      }));

      const result = await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: { initial: true },
        callId: 'call_001',
      });

      expect(result.modifiedArgs).toEqual({
        initial: true,
        step1: true,
        step2: true,
      });
    });

    it('should stop execution when hook returns shouldProceed: false', async () => {
      const secondHook = vi.fn(() => ({ shouldProceed: true }));

      manager.onPreToolUse(() => ({
        shouldProceed: false,
        reason: 'Blocked by first hook',
      }));

      manager.onPreToolUse(secondHook);

      const result = await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: {},
        callId: 'call_001',
      });

      expect(result.shouldProceed).toBe(false);
      expect(result.reason).toBe('Blocked by first hook');
      expect(secondHook).not.toHaveBeenCalled();
    });

    it('should continue execution when one hook throws error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onPreToolUse(() => {
        throw new Error('Hook error');
      });

      manager.onPreToolUse(() => ({
        shouldProceed: true,
        modifiedArgs: { fromSecondHook: true },
      }));

      const result = await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: {},
        callId: 'call_001',
      });

      expect(result.shouldProceed).toBe(true);
      expect(result.modifiedArgs).toEqual({ fromSecondHook: true });
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should support async hooks', async () => {
      manager.onPreToolUse(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { shouldProceed: true, modifiedArgs: { async: true } };
      });

      const result = await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: {},
        callId: 'call_001',
      });

      expect(result.shouldProceed).toBe(true);
      expect(result.modifiedArgs?.async).toBe(true);
    });
  });

  describe('postToolUse hooks', () => {
    it('should execute hooks and pass result context', async () => {
      const hookFn = vi.fn(() => ({}));
      manager.onPostToolUse(hookFn);

      await manager.executePostToolUseHooks({
        toolName: 'test_tool',
        args: { foo: 'bar' },
        result: { success: true, result: { data: 'test' } },
        callId: 'call_001',
        durationMs: 100,
      });

      expect(hookFn).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'test_tool',
          args: { foo: 'bar' },
          result: { success: true, result: { data: 'test' } },
          durationMs: 100,
        })
      );
    });

    it('should allow hook to modify result', async () => {
      manager.onPostToolUse(() => ({
        modifiedResult: { success: true, result: { modified: true } },
      }));

      const result = await manager.executePostToolUseHooks({
        toolName: 'test_tool',
        args: {},
        result: { success: true, result: { original: true } },
        callId: 'call_001',
        durationMs: 50,
      });

      expect(result.modifiedResult).toEqual({
        success: true,
        result: { modified: true },
      });
    });

    it('should chain result modifications across hooks', async () => {
      manager.onPostToolUse((ctx) => ({
        modifiedResult: {
          ...ctx.result,
          result: { ...(ctx.result.result as object), hook1: true },
        },
      }));

      manager.onPostToolUse((ctx) => ({
        modifiedResult: {
          ...ctx.result,
          result: { ...(ctx.result.result as object), hook2: true },
        },
      }));

      const result = await manager.executePostToolUseHooks({
        toolName: 'test_tool',
        args: {},
        result: { success: true, result: { original: true } },
        callId: 'call_001',
        durationMs: 50,
      });

      expect(result.modifiedResult?.result).toEqual({
        original: true,
        hook1: true,
        hook2: true,
      });
    });
  });

  describe('preMessage hooks', () => {
    it('should execute hooks with message context', async () => {
      const hookFn = vi.fn(() => ({ shouldProceed: true }));
      manager.onPreMessage(hookFn);

      await manager.executePreMessageHooks({
        content: 'Hello agent',
        turnNumber: 1,
      });

      expect(hookFn).toHaveBeenCalledWith({
        content: 'Hello agent',
        turnNumber: 1,
      });
    });

    it('should allow hook to modify content', async () => {
      manager.onPreMessage(() => ({
        shouldProceed: true,
        modifiedContent: 'Modified content',
      }));

      const result = await manager.executePreMessageHooks({
        content: 'Original content',
        turnNumber: 1,
      });

      expect(result.shouldProceed).toBe(true);
      expect(result.modifiedContent).toBe('Modified content');
    });

    it('should block message processing when shouldProceed is false', async () => {
      manager.onPreMessage(() => ({
        shouldProceed: false,
        reason: 'Content policy violation',
      }));

      const result = await manager.executePreMessageHooks({
        content: 'Blocked content',
        turnNumber: 1,
      });

      expect(result.shouldProceed).toBe(false);
      expect(result.reason).toBe('Content policy violation');
    });
  });

  describe('postMessage hooks', () => {
    it('should execute hooks with response context', async () => {
      const hookFn = vi.fn(() => ({}));
      manager.onPostMessage(hookFn);

      await manager.executePostMessageHooks({
        userContent: 'User message',
        assistantContent: 'Assistant response',
        turnNumber: 1,
      });

      expect(hookFn).toHaveBeenCalledWith({
        userContent: 'User message',
        assistantContent: 'Assistant response',
        turnNumber: 1,
      });
    });

    it('should allow hook to modify response content', async () => {
      manager.onPostMessage(() => ({
        modifiedContent: 'Modified response',
      }));

      const result = await manager.executePostMessageHooks({
        userContent: 'User message',
        assistantContent: 'Original response',
        turnNumber: 1,
      });

      expect(result.modifiedContent).toBe('Modified response');
    });
  });

  describe('named hooks', () => {
    it('should include hook name in block reason', async () => {
      manager.onPreToolUse(
        () => ({ shouldProceed: false }),
        { name: 'validation-hook' }
      );

      const result = await manager.executePreToolUseHooks({
        toolName: 'test_tool',
        args: {},
        callId: 'call_001',
      });

      expect(result.reason).toContain('validation-hook');
    });
  });
});

describe('createHookManager', () => {
  it('should create a new HookManager instance', () => {
    const manager = createHookManager();
    expect(manager).toBeInstanceOf(HookManager);
    expect(manager.getHookCounts().preToolUse).toBe(0);
  });
});
