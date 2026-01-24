/**
 * useAIAgent Hook Tests
 *
 * TDD tests for AI agent hook that analyzes intent and executes EditScripts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useAIAgent } from './useAIAgent';
import type { AIContext, EditScript } from './useAIAgent';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

// =============================================================================
// Test Fixtures
// =============================================================================

const mockEditScript: EditScript = {
  intent: 'Cut the first 5 seconds',
  commands: [
    {
      commandType: 'SplitClip',
      params: { clipId: 'clip_001', atTimelineSec: 5.0 },
      description: 'Split clip at 5 seconds',
    },
  ],
  requires: [],
  qcRules: [],
  risk: { copyright: 'none', nsfw: 'none' },
  explanation: 'This will split the clip at 5 seconds.',
};

const mockContext: AIContext = {
  playheadPosition: 0,
  selectedClips: ['clip_001'],
  selectedTracks: ['track_001'],
  transcriptContext: null,
};

// =============================================================================
// Tests
// =============================================================================

describe('useAIAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // analyzeIntent Tests
  // ===========================================================================

  describe('analyzeIntent', () => {
    it('should call analyze_intent IPC command with intent and context', async () => {
      mockedInvoke.mockResolvedValueOnce(mockEditScript);

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        await result.current.analyzeIntent('Cut the first 5 seconds', mockContext);
      });

      expect(mockedInvoke).toHaveBeenCalledWith('analyze_intent', {
        intent: 'Cut the first 5 seconds',
        context: mockContext,
      });
    });

    it('should return EditScript from successful analysis', async () => {
      mockedInvoke.mockResolvedValueOnce(mockEditScript);

      const { result } = renderHook(() => useAIAgent());

      let editScript;
      await act(async () => {
        editScript = await result.current.analyzeIntent('Cut the first 5 seconds', mockContext);
      });

      expect(editScript).toEqual(mockEditScript);
    });

    it('should set isLoading to true while analyzing', async () => {
      mockedInvoke.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockEditScript), 100)),
      );

      const { result } = renderHook(() => useAIAgent());

      expect(result.current.isLoading).toBe(false);

      act(() => {
        result.current.analyzeIntent('Cut the first 5 seconds', mockContext);
      });

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should set error on failure', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Analysis failed'));

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        try {
          await result.current.analyzeIntent('Invalid intent', mockContext);
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toBe('Analysis failed');
    });

    it('should fail fast on invalid IPC response shape', async () => {
      mockedInvoke.mockResolvedValueOnce({ not: 'an edit script' });

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        try {
          await result.current.analyzeIntent('Cut', mockContext);
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toContain('EditScript');
    });

    it('should set currentProposal after successful analysis', async () => {
      mockedInvoke.mockResolvedValueOnce(mockEditScript);

      const { result } = renderHook(() => useAIAgent());

      expect(result.current.currentProposal).toBeNull();

      await act(async () => {
        await result.current.analyzeIntent('Cut the first 5 seconds', mockContext);
      });

      expect(result.current.currentProposal).toEqual(mockEditScript);
    });
  });

  // ===========================================================================
  // applyEditScript Tests
  // ===========================================================================

  describe('applyEditScript', () => {
    it('should call apply_edit_script IPC command', async () => {
      mockedInvoke.mockResolvedValueOnce({
        success: true,
        appliedOpIds: ['op_001'],
        errors: [],
      });

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        await result.current.applyEditScript(mockEditScript);
      });

      expect(mockedInvoke).toHaveBeenCalledWith('apply_edit_script', {
        editScript: mockEditScript,
      });
    });

    it('should return success result with applied op IDs', async () => {
      const mockResult = {
        success: true,
        appliedOpIds: ['op_001', 'op_002'],
        errors: [],
      };
      mockedInvoke.mockResolvedValueOnce(mockResult);

      const { result } = renderHook(() => useAIAgent());

      let applyResult;
      await act(async () => {
        applyResult = await result.current.applyEditScript(mockEditScript);
      });

      expect(applyResult).toEqual(mockResult);
    });

    it('should clear currentProposal after successful application', async () => {
      // First set a proposal
      mockedInvoke.mockResolvedValueOnce(mockEditScript);

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        await result.current.analyzeIntent('Test', mockContext);
      });

      expect(result.current.currentProposal).not.toBeNull();

      // Now apply it
      mockedInvoke.mockResolvedValueOnce({
        success: true,
        appliedOpIds: ['op_001'],
        errors: [],
      });

      await act(async () => {
        await result.current.applyEditScript(mockEditScript);
      });

      expect(result.current.currentProposal).toBeNull();
    });

    it('should not clear proposal if application fails', async () => {
      // First set a proposal
      mockedInvoke.mockResolvedValueOnce(mockEditScript);

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        await result.current.analyzeIntent('Test', mockContext);
      });

      // Now try to apply and fail
      mockedInvoke.mockResolvedValueOnce({
        success: false,
        appliedOpIds: [],
        errors: ['Command execution failed'],
      });

      await act(async () => {
        await result.current.applyEditScript(mockEditScript);
      });

      // Proposal should still be there
      expect(result.current.currentProposal).not.toBeNull();
    });

    it('should reject invalid apply result payloads', async () => {
      mockedInvoke.mockResolvedValueOnce({ success: true, appliedOpIds: 'nope', errors: [] });

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        try {
          await result.current.applyEditScript(mockEditScript);
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toContain('ApplyResult');
    });
  });

  // ===========================================================================
  // validateEditScript Tests
  // ===========================================================================

  describe('validateEditScript', () => {
    it('should call validate_edit_script IPC command', async () => {
      mockedInvoke.mockResolvedValueOnce({
        isValid: true,
        issues: [],
        warnings: [],
      });

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        await result.current.validateEditScript(mockEditScript);
      });

      expect(mockedInvoke).toHaveBeenCalledWith('validate_edit_script', {
        editScript: mockEditScript,
      });
    });

    it('should return validation result', async () => {
      const validationResult = {
        isValid: false,
        issues: ['Missing clipId'],
        warnings: ['Unknown command type'],
      };
      mockedInvoke.mockResolvedValueOnce(validationResult);

      const { result } = renderHook(() => useAIAgent());

      let validation;
      await act(async () => {
        validation = await result.current.validateEditScript(mockEditScript);
      });

      expect(validation).toEqual(validationResult);
    });
  });

  // ===========================================================================
  // rejectProposal Tests
  // ===========================================================================

  describe('rejectProposal', () => {
    it('should clear currentProposal when rejected', async () => {
      // First set a proposal
      mockedInvoke.mockResolvedValueOnce(mockEditScript);

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        await result.current.analyzeIntent('Test', mockContext);
      });

      expect(result.current.currentProposal).not.toBeNull();

      // Reject it
      act(() => {
        result.current.rejectProposal();
      });

      expect(result.current.currentProposal).toBeNull();
    });
  });

  // ===========================================================================
  // clearError Tests
  // ===========================================================================

  describe('clearError', () => {
    it('should clear error state', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Test error'));

      const { result } = renderHook(() => useAIAgent());

      await act(async () => {
        try {
          await result.current.analyzeIntent('Test', mockContext);
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toBe('Test error');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });
});
