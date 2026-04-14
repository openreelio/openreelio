import { describe, expect, it } from 'vitest';
import { buildDelegationContextPacket } from './agentDelegationContract';
import { buildVerifierPacket } from './agentVerifierPacket';

describe('agentVerifierPacket', () => {
  it('builds a verifier review packet with contract and verification details', () => {
    const packet = buildVerifierPacket({
      record: {
        id: 'delegation-1',
        agentProfileId: 'planner',
        delegatedGoal: 'Review pacing',
        status: 'completed',
        mergeStatus: 'pending',
        errorMessage: null,
      },
      reviewSession: {
        title: 'Planner Session',
        agentProfileId: 'planner',
      },
      contextPacket: buildDelegationContextPacket({
        parentSessionId: 'session-1',
        parentAgentId: 'editor',
        parentAgentName: 'Editor Session',
        delegatedGoal: 'Review pacing',
        specialistId: 'planner',
        specialistName: 'Planner',
      }),
      result: {
        success: true,
        aborted: false,
        totalDuration: 800,
        iterations: 1,
        finalState: 'Suggested a shorter intro section.',
        executedSteps: 1,
        successfulSteps: 1,
        failedSteps: 0,
        preview: 'Suggested a shorter intro section.',
        recentTools: ['query_timeline'],
        recentFiles: ['src/foo.ts'],
        handoff: {
          parseStatus: 'parsed',
          recommendation: null,
          summary: 'Suggested a shorter intro section.',
          summaryProvided: true,
          openIssues: [],
          openIssuesDeclared: true,
          evidence: [{ kind: 'tool', value: 'query_timeline' }],
        },
        autoVerification: {
          status: 'pass',
          summary:
            'Automatic verification passed the delegated handoff against the stored task contract.',
          missingRequirements: [],
          warnings: [],
          checkedAt: 2,
        },
        verification: {
          verdict: 'unverified',
          summary: 'Completed child work remains pending until parent verification.',
          verifiedAt: null,
          evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
        },
      },
      reviewState: {
        phase: 'awaiting_review',
        label: 'Needs verification',
        summary: 'Completed child work remains pending until parent verification.',
        canApplyReview: true,
      },
    });

    expect(packet.relativePath).toBe('.openreelio/reviews/delegation-1-verifier.md');
    expect(packet.launchGoal).toContain('return one recommendation: merge, follow_up, or discard');
    expect(packet.content).toContain('# Delegation Verification Packet');
    expect(packet.content).toContain('## Stored Contract');
    expect(packet.content).toContain('## Automatic Verification');
    expect(packet.content).toContain('## Structured Handoff');
    expect(packet.content).toContain('query_timeline');
    expect(packet.content).toContain('src/foo.ts');
  });
});
