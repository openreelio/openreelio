/**
 * useAIAgent Hook
 *
 * Provides AI-powered video editing capabilities through natural language commands.
 * Handles intent analysis, EditScript generation, validation, and execution.
 */

import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// =============================================================================
// Types
// =============================================================================

/** Context passed to AI for better understanding */
export interface AIContext {
  playheadPosition: number;
  selectedClips: string[];
  selectedTracks: string[];
  transcriptContext: string | null;
}

/** Single edit command in the script */
export interface EditCommand {
  commandType: string;
  params: Record<string, unknown>;
  description?: string;
}

/** Risk assessment for the edit script */
export interface RiskAssessment {
  copyright: 'none' | 'low' | 'medium' | 'high';
  nsfw: 'none' | 'possible' | 'likely';
}

/** Requirement for external resources */
export interface Requirement {
  kind: string;
  query?: string;
  provider?: string;
}

/** AI-generated editing script */
export interface EditScript {
  intent: string;
  commands: EditCommand[];
  requires: Requirement[];
  qcRules: string[];
  risk: RiskAssessment;
  explanation: string;
}

/** Result of applying an EditScript */
export interface ApplyResult {
  success: boolean;
  appliedOpIds: string[];
  errors: string[];
}

/** Result of validating an EditScript */
export interface ValidationResult {
  isValid: boolean;
  issues: string[];
  warnings: string[];
}

/** Hook return type */
export interface UseAIAgentReturn {
  /** Whether an AI operation is in progress */
  isLoading: boolean;
  /** Current error message, if any */
  error: string | null;
  /** Current proposal awaiting user approval */
  currentProposal: EditScript | null;
  /** Analyze user intent and generate an EditScript */
  analyzeIntent: (intent: string, context: AIContext) => Promise<EditScript>;
  /** Apply an EditScript by executing its commands */
  applyEditScript: (editScript: EditScript) => Promise<ApplyResult>;
  /** Validate an EditScript without executing */
  validateEditScript: (editScript: EditScript) => Promise<ValidationResult>;
  /** Reject and clear the current proposal */
  rejectProposal: () => void;
  /** Clear the current error */
  clearError: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for AI-powered video editing through natural language commands.
 *
 * @example
 * ```tsx
 * const { analyzeIntent, applyEditScript, currentProposal, isLoading } = useAIAgent();
 *
 * const handlePrompt = async (text: string) => {
 *   const script = await analyzeIntent(text, context);
 *   // Show proposal to user for approval
 *   if (userApproves) {
 *     await applyEditScript(script);
 *   }
 * };
 * ```
 */
export function useAIAgent(): UseAIAgentReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentProposal, setCurrentProposal] = useState<EditScript | null>(null);

  /**
   * Analyze user intent and generate an EditScript.
   * The generated script is stored as currentProposal for user review.
   */
  const analyzeIntent = useCallback(
    async (intent: string, context: AIContext): Promise<EditScript> => {
      setIsLoading(true);
      setError(null);

      try {
        const editScript = await invoke<EditScript>('analyze_intent', {
          intent,
          context,
        });

        setCurrentProposal(editScript);
        return editScript;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  /**
   * Apply an EditScript by executing its commands.
   * Clears currentProposal on success.
   */
  const applyEditScript = useCallback(
    async (editScript: EditScript): Promise<ApplyResult> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await invoke<ApplyResult>('apply_edit_script', {
          editScript,
        });

        if (result.success) {
          setCurrentProposal(null);
        } else if (result.errors.length > 0) {
          setError(result.errors.join('; '));
        }

        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  /**
   * Validate an EditScript without executing.
   */
  const validateEditScript = useCallback(
    async (editScript: EditScript): Promise<ValidationResult> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await invoke<ValidationResult>('validate_edit_script', {
          editScript,
        });

        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  /**
   * Reject and clear the current proposal.
   */
  const rejectProposal = useCallback(() => {
    setCurrentProposal(null);
  }, []);

  /**
   * Clear the current error.
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isLoading,
    error,
    currentProposal,
    analyzeIntent,
    applyEditScript,
    validateEditScript,
    rejectProposal,
    clearError,
  };
}

export default useAIAgent;
