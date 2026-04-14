import type { AgentRunResult } from '@/agents/engine';
import { describe, expect, it } from 'vitest';
import {
  buildDelegationResultPayload,
  deriveDelegationReviewState,
  parseDelegationResultPayload,
  resolveDelegationReviewFocus,
} from './agentDelegationResult';
import { buildDelegationContextPacket } from './agentDelegationContract';

function createRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    success: true,
    executionResults: [],
    iterations: 1,
    totalDuration: 800,
    aborted: false,
    finalState: {} as AgentRunResult['finalState'],
    summary: {
      sessionId: 'session-child',
      input: 'Review pacing',
      totalIterations: 1,
      executedSteps: 1,
      successfulSteps: 1,
      failedSteps: 0,
      duration: 800,
      finalState: 'Suggested a shorter intro section.',
    },
    ...overrides,
  };
}

describe('agentDelegationResult', () => {
  it('backfills verification metadata for legacy delegation payloads', () => {
    const payload = parseDelegationResultPayload(
      JSON.stringify({
        success: true,
        aborted: false,
        totalDuration: 1200,
        iterations: 2,
        finalState: 'Suggested a faster cold open.',
        executedSteps: 3,
        successfulSteps: 3,
        failedSteps: 0,
        preview: 'Suggested a faster cold open.',
        recentTools: ['query_timeline'],
        recentFiles: ['src/foo.ts'],
      }),
      {
        contextPacketJson: JSON.stringify(
          buildDelegationContextPacket({
            parentSessionId: 'session-1',
            parentAgentId: 'editor',
            parentAgentName: 'Editor Session',
            delegatedGoal: 'Review pacing',
            specialistId: 'planner',
            specialistName: 'Planner',
          }),
        ),
        specialistId: 'planner',
      },
    );

    expect(payload).toEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          verdict: 'unverified',
          verifiedAt: null,
        }),
      }),
    );
    expect(payload?.verification.evidence).toEqual(
      expect.arrayContaining([
        { kind: 'summary', value: 'Suggested a faster cold open.' },
        { kind: 'file', value: 'src/foo.ts' },
        { kind: 'tool', value: 'query_timeline' },
      ]),
    );
    expect(payload?.autoVerification).toEqual(
      expect.objectContaining({
        status: 'needs_follow_up',
        missingRequirements: expect.arrayContaining([
          'Return a final DELEGATION_HANDOFF JSON block.',
          'Declare open issues explicitly, even when none remain.',
        ]),
      }),
    );
  });

  it('does not force a fake summary focus when no artifacts were captured', () => {
    const payload = parseDelegationResultPayload(
      JSON.stringify({
        success: true,
        aborted: false,
        totalDuration: 500,
        iterations: 1,
        finalState: 'Review the intro pacing.',
        executedSteps: 1,
        successfulSteps: 1,
        failedSteps: 0,
        preview: 'Review the intro pacing.',
        recentTools: [],
        recentFiles: [],
      }),
    );

    expect(resolveDelegationReviewFocus(payload)).toBeNull();
  });

  it('classifies aborted delegation results as cancelled before failed', () => {
    const payload = parseDelegationResultPayload(
      JSON.stringify({
        success: false,
        aborted: true,
        totalDuration: 500,
        iterations: 1,
        finalState: null,
        executedSteps: 0,
        successfulSteps: 0,
        failedSteps: 0,
        preview: 'Stopped by user.',
        recentTools: [],
        recentFiles: [],
      }),
    );

    expect(
      deriveDelegationReviewState(
        {
          status: 'completed',
          mergeStatus: 'pending',
          errorMessage: 'Stopped by user.',
        },
        payload,
      ),
    ).toEqual(
      expect.objectContaining({
        phase: 'cancelled',
        label: 'Cancelled handoff',
        canApplyReview: false,
      }),
    );
  });

  it('does not auto-pass successful results when the delegation task contract is missing', () => {
    const payload = parseDelegationResultPayload(
      JSON.stringify({
        success: true,
        aborted: false,
        totalDuration: 500,
        iterations: 1,
        finalState: 'Suggested a shorter intro section.',
        executedSteps: 1,
        successfulSteps: 1,
        failedSteps: 0,
        preview: 'Suggested a shorter intro section.',
        recentTools: ['query_timeline'],
        recentFiles: [],
        autoVerification: {
          status: 'pass',
          summary: 'Legacy auto-verification pass.',
          missingRequirements: [],
          warnings: [],
          checkedAt: 10,
        },
      }),
      {
        contextPacketJson: '{}',
        specialistId: 'planner',
      },
    );

    expect(payload?.autoVerification).toEqual(
      expect.objectContaining({
        status: 'needs_follow_up',
        missingRequirements: ['Restore the delegation task contract before requesting merge.'],
      }),
    );
  });

  it('parses a structured handoff and passes automatic verification when contract requirements are met', () => {
    const resultPayload = buildDelegationResultPayload(
      createRunResult(),
      [
        {
          id: 'assistant-msg-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              content: `Suggested a shorter intro section.\n\nDELEGATION_HANDOFF\n${JSON.stringify(
                {
                  summary: 'Suggested a shorter intro section.',
                  openIssues: [],
                  evidence: [
                    { kind: 'summary', value: 'Suggested a shorter intro section.' },
                    { kind: 'tool', value: 'query_timeline' },
                  ],
                },
                null,
                2,
              )}`,
            },
          ],
          timestamp: 2,
        },
      ],
      {
        contextPacketJson: JSON.stringify(
          buildDelegationContextPacket({
            parentSessionId: 'session-1',
            parentAgentId: 'editor',
            parentAgentName: 'Editor Session',
            delegatedGoal: 'Review pacing',
            specialistId: 'planner',
            specialistName: 'Planner',
          }),
        ),
        specialistId: 'planner',
      },
    );

    expect(resultPayload.handoff).toEqual(
      expect.objectContaining({
        parseStatus: 'parsed',
        summary: 'Suggested a shorter intro section.',
        openIssuesDeclared: true,
      }),
    );
    expect(resultPayload.preview).toBe('Suggested a shorter intro section.');
    expect(resultPayload.autoVerification).toEqual(
      expect.objectContaining({
        status: 'pass',
        missingRequirements: [],
      }),
    );
  });

  it('fails automatic verification when the final handoff block is malformed', () => {
    const resultPayload = buildDelegationResultPayload(
      createRunResult(),
      [
        {
          id: 'assistant-msg-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              content:
                'Suggested a shorter intro section.\n\nDELEGATION_HANDOFF\n{"summary":"Broken JSON"',
            },
          ],
          timestamp: 2,
        },
      ],
      {
        contextPacketJson: JSON.stringify(
          buildDelegationContextPacket({
            parentSessionId: 'session-1',
            parentAgentId: 'editor',
            parentAgentName: 'Editor Session',
            delegatedGoal: 'Review pacing',
            specialistId: 'planner',
            specialistName: 'Planner',
          }),
        ),
        specialistId: 'planner',
      },
    );

    expect(resultPayload.handoff.parseStatus).toBe('invalid');
    expect(resultPayload.autoVerification).toEqual(
      expect.objectContaining({
        status: 'fail',
      }),
    );
  });

  it('requires a verifier recommendation before passing automatic verification', () => {
    const resultPayload = buildDelegationResultPayload(
      createRunResult(),
      [
        {
          id: 'assistant-msg-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              content: `Verifier review complete.\n\nDELEGATION_HANDOFF\n${JSON.stringify(
                {
                  summary: 'The reviewed delegation mostly matches the contract.',
                  openIssues: [],
                  evidence: [{ kind: 'summary', value: 'The reviewed delegation mostly matches.' }],
                },
                null,
                2,
              )}`,
            },
          ],
          timestamp: 2,
        },
      ],
      {
        contextPacketJson: JSON.stringify(
          buildDelegationContextPacket({
            parentSessionId: 'session-1',
            parentAgentId: 'editor',
            parentAgentName: 'Editor Session',
            delegatedGoal: 'Verify merge readiness',
            specialistId: 'verifier',
            specialistName: 'Verifier',
          }),
        ),
        specialistId: 'verifier',
      },
    );

    expect(resultPayload.autoVerification).toEqual(
      expect.objectContaining({
        status: 'needs_follow_up',
        missingRequirements: ['Return exactly one recommendation: merge, follow_up, discard.'],
      }),
    );
  });

  it('passes verifier automatic verification when a recommendation is included', () => {
    const resultPayload = buildDelegationResultPayload(
      createRunResult(),
      [
        {
          id: 'assistant-msg-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              content: `Verifier review complete.\n\nDELEGATION_HANDOFF\n${JSON.stringify(
                {
                  recommendation: 'merge',
                  summary: 'The reviewed delegation satisfies the stored contract.',
                  openIssues: [],
                  evidence: [
                    { kind: 'summary', value: 'The reviewed delegation satisfies the contract.' },
                  ],
                },
                null,
                2,
              )}`,
            },
          ],
          timestamp: 2,
        },
      ],
      {
        contextPacketJson: JSON.stringify(
          buildDelegationContextPacket({
            parentSessionId: 'session-1',
            parentAgentId: 'editor',
            parentAgentName: 'Editor Session',
            delegatedGoal: 'Verify merge readiness',
            specialistId: 'verifier',
            specialistName: 'Verifier',
          }),
        ),
        specialistId: 'verifier',
      },
    );

    expect(resultPayload.handoff).toEqual(
      expect.objectContaining({
        recommendation: 'merge',
        parseStatus: 'parsed',
      }),
    );
    expect(resultPayload.autoVerification).toEqual(
      expect.objectContaining({
        status: 'pass',
        missingRequirements: [],
      }),
    );
  });
});
