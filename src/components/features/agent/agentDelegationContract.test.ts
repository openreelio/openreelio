import { describe, expect, it } from 'vitest';
import {
  buildDelegationContextPacket,
  buildDelegationContractSystemMessage,
  parseDelegationContextPacket,
} from './agentDelegationContract';

describe('agentDelegationContract', () => {
  it('builds a structured delegation context packet with a task contract', () => {
    const packet = buildDelegationContextPacket({
      parentSessionId: 'session-1',
      parentAgentId: 'editor',
      parentAgentName: 'Editor Session',
      delegatedGoal: 'Review pacing',
      specialistId: 'planner',
      specialistName: 'Planner',
      createdAt: 100,
    });

    expect(packet).toEqual(
      expect.objectContaining({
        source: 'agent-workspace',
        parentSessionId: 'session-1',
        parentAgentId: 'editor',
        delegatedGoal: 'Review pacing',
        createdAt: 100,
        taskContract: expect.objectContaining({
          objective: 'Review pacing',
          specialistId: 'planner',
          specialistName: 'Planner',
          verificationSpec: expect.objectContaining({
            requireStructuredHandoff: true,
            requireSummary: true,
            requireEvidence: true,
            requireOpenIssuesStatement: true,
            minimumEvidenceCount: 1,
          }),
          expectedDeliverables: expect.arrayContaining([
            'Break down the goal into an execution-ready plan: Review pacing',
          ]),
          acceptanceChecklist: expect.arrayContaining([
            'Provide a parent-reviewable summary before declaring the task done.',
          ]),
        }),
      }),
    );
  });

  it('parses a stored context packet and renders a child bootstrap system message', () => {
    const stored = JSON.stringify(
      buildDelegationContextPacket({
        parentSessionId: 'session-1',
        parentAgentId: 'editor',
        parentAgentName: 'Editor Session',
        delegatedGoal: 'Review pacing',
        specialistId: 'planner',
        specialistName: 'Planner',
        createdAt: 100,
      }),
    );

    const packet = parseDelegationContextPacket(stored);

    expect(packet).not.toBeNull();
    expect(buildDelegationContractSystemMessage(packet!)).toContain('Expected handoff:');
    expect(buildDelegationContractSystemMessage(packet!)).toContain('Acceptance checklist:');
    expect(buildDelegationContractSystemMessage(packet!)).toContain('DELEGATION_HANDOFF');
    expect(buildDelegationContractSystemMessage(packet!)).toContain(
      'Parent verification is required before this delegated result can be merged.',
    );
  });

  it('backfills a task contract for legacy stored delegation context', () => {
    const packet = parseDelegationContextPacket(
      JSON.stringify({
        source: 'agent-workspace',
        parentSessionId: 'session-1',
        parentAgentId: 'editor',
        parentAgentName: 'Editor Session',
        delegatedGoal: 'Review pacing',
        createdAt: 100,
      }),
      {
        specialistId: 'planner',
        specialistName: 'Planner',
      },
    );

    expect(packet).toEqual(
      expect.objectContaining({
        delegatedGoal: 'Review pacing',
        taskContract: expect.objectContaining({
          objective: 'Review pacing',
          specialistId: 'planner',
          specialistName: 'Planner',
          verificationSpec: expect.objectContaining({
            requireStructuredHandoff: true,
          }),
        }),
      }),
    );
  });

  it('builds verifier-specific contract requirements', () => {
    const packet = buildDelegationContextPacket({
      parentSessionId: 'session-1',
      parentAgentId: 'editor',
      parentAgentName: 'Editor Session',
      delegatedGoal: 'Verify merge readiness',
      specialistId: 'verifier',
      specialistName: 'Verifier',
      createdAt: 100,
    });

    expect(packet.taskContract.expectedDeliverables).toEqual(
      expect.arrayContaining(['Return exactly one recommendation: merge, follow_up, or discard.']),
    );
    expect(packet.taskContract.verificationSpec.requiredRecommendationOptions).toEqual([
      'merge',
      'follow_up',
      'discard',
    ]);
    expect(packet.taskContract.acceptanceChecklist).toEqual(
      expect.arrayContaining(['Conclude with one recommendation: merge, follow_up, or discard.']),
    );
    expect(buildDelegationContractSystemMessage(packet)).toContain('"recommendation": "merge"');
  });
});
