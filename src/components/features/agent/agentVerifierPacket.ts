import type { DelegationRecord } from '@/agents/engine/core/agentSession';
import type { AgentArtifactReviewSource } from '@/stores/agentArtifactReviewStore';
import type { DelegationContextPacket } from './agentDelegationContract';
import type { DelegationResultPayload, DelegationReviewState } from './agentDelegationResult';

export interface VerifierPacketInput {
  record: Pick<
    DelegationRecord,
    'id' | 'agentProfileId' | 'delegatedGoal' | 'status' | 'mergeStatus' | 'errorMessage'
  >;
  reviewSession: Pick<AgentArtifactReviewSource, 'title' | 'agentProfileId'> | null;
  contextPacket: DelegationContextPacket | null;
  result: DelegationResultPayload;
  reviewState: DelegationReviewState | null;
}

export interface VerifierPacket {
  relativePath: string;
  launchGoal: string;
  content: string;
}

function renderLines(values: string[], emptyLabel: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${emptyLabel}`];
}

function normalizeDelegationId(id: string): string {
  return id.startsWith('delegation-') ? id.slice('delegation-'.length) : id;
}

export function buildVerifierPacket(input: VerifierPacketInput): VerifierPacket {
  const relativePath = `.openreelio/reviews/delegation-${normalizeDelegationId(input.record.id)}-verifier.md`;
  const originalAgentLabel =
    input.contextPacket?.taskContract.specialistName ?? input.record.agentProfileId;
  const launchGoal = `Verify whether the completed delegated result for "${input.record.delegatedGoal}" is ready to merge. Read the review packet at ${relativePath}, validate the child handoff against its stored contract, inspect referenced files if needed, and return one recommendation: merge, follow_up, or discard.`;

  const content = [
    '# Delegation Verification Packet',
    '',
    `- Delegation ID: ${input.record.id}`,
    `- Reviewed Session: ${input.reviewSession?.title ?? 'Delegated Session'}`,
    `- Original Specialist: ${originalAgentLabel} (${input.record.agentProfileId})`,
    `- Delegated Goal: ${input.record.delegatedGoal}`,
    `- Current Delegation Status: ${input.record.status}`,
    `- Current Merge Status: ${input.record.mergeStatus}`,
    `- Review State: ${input.reviewState?.label ?? 'Unknown'}`,
    '',
    '## Stored Contract',
    '',
    ...(input.contextPacket
      ? [
          `- Objective: ${input.contextPacket.taskContract.objective}`,
          '- Expected handoff:',
          ...renderLines(
            input.contextPacket.taskContract.expectedDeliverables,
            'No expected deliverables were stored.',
          ),
          '- Acceptance checklist:',
          ...renderLines(
            input.contextPacket.taskContract.acceptanceChecklist,
            'No acceptance checklist was stored.',
          ),
          `- Handoff requirement: ${input.contextPacket.taskContract.handoffRequirement}`,
        ]
      : ['- The original delegation task contract is missing or unreadable.']),
    '',
    '## Automatic Verification',
    '',
    `- Status: ${input.result.autoVerification.status}`,
    `- Summary: ${input.result.autoVerification.summary}`,
    '- Missing requirements:',
    ...renderLines(
      input.result.autoVerification.missingRequirements,
      'No missing requirements were recorded.',
    ),
    '- Warnings:',
    ...renderLines(input.result.autoVerification.warnings, 'No warnings were recorded.'),
    '',
    '## Structured Handoff',
    '',
    `- Parse status: ${input.result.handoff.parseStatus}`,
    `- Summary: ${input.result.handoff.summary ?? 'None'}`,
    '- Open issues:',
    ...renderLines(input.result.handoff.openIssues, 'No open issues were declared.'),
    '- Evidence:',
    ...renderLines(
      input.result.handoff.evidence.map((entry) => `${entry.kind}: ${entry.value}`),
      'No structured evidence was returned.',
    ),
    '',
    '## Captured Session Artifacts',
    '',
    `- Preview: ${input.result.preview ?? 'None'}`,
    `- Final state: ${input.result.finalState ?? 'None'}`,
    '- Recent tools:',
    ...renderLines(input.result.recentTools, 'No tools were captured.'),
    '- Recent files:',
    ...renderLines(input.result.recentFiles, 'No files were captured.'),
    '',
    '## Verification Task',
    '',
    '- Decide whether the reviewed delegation should be merged, needs follow-up, or should be discarded.',
    '- Validate the recommendation against the stored contract, structured handoff, and captured evidence.',
    '- If the contract is missing or the handoff is incomplete, explain what blocks merge readiness.',
  ].join('\n');

  return {
    relativePath,
    launchGoal,
    content,
  };
}
