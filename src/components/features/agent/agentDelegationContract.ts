export type DelegationRecommendation = 'merge' | 'follow_up' | 'discard';

export interface DelegationVerificationSpec {
  handoffSchemaVersion: 1;
  requireStructuredHandoff: boolean;
  requireSummary: boolean;
  requireEvidence: boolean;
  requireOpenIssuesStatement: boolean;
  minimumEvidenceCount: number;
  requiredRecommendationOptions: DelegationRecommendation[];
}

export interface DelegationTaskContract {
  objective: string;
  specialistId: string;
  specialistName: string;
  expectedDeliverables: string[];
  acceptanceChecklist: string[];
  handoffRequirement: string;
  verificationSpec: DelegationVerificationSpec;
}

export interface DelegationContextPacket {
  source: 'agent-workspace';
  parentSessionId: string;
  parentAgentId: string;
  parentAgentName: string;
  delegatedGoal: string;
  createdAt: number;
  reviewTarget: DelegationReviewTarget | null;
  taskContract: DelegationTaskContract;
}

export interface DelegationReviewTarget {
  delegationId: string;
  childSessionId: string;
  agentProfileId: string;
}

function createDefaultVerificationSpec(specialistId?: string): DelegationVerificationSpec {
  return {
    handoffSchemaVersion: 1,
    requireStructuredHandoff: true,
    requireSummary: true,
    requireEvidence: true,
    requireOpenIssuesStatement: true,
    minimumEvidenceCount: 1,
    requiredRecommendationOptions:
      specialistId === 'verifier' ? ['merge', 'follow_up', 'discard'] : [],
  };
}

interface BuildDelegationTaskContractInput {
  delegatedGoal: string;
  specialistId: string;
  specialistName: string;
}

interface BuildDelegationContextPacketInput extends BuildDelegationTaskContractInput {
  parentSessionId: string;
  parentAgentId: string;
  parentAgentName: string;
  createdAt?: number;
  reviewTarget?: DelegationReviewTarget | null;
}

interface ParseDelegationContextPacketFallback {
  specialistId?: string;
  specialistName?: string;
}

function getExpectedDeliverables(
  specialistId: string,
  specialistName: string,
  delegatedGoal: string,
): string[] {
  const baseline = [
    `Complete the delegated task from the ${specialistName} perspective.`,
    'Return a concise handoff summary that the parent can review without replaying the whole run.',
    'Capture concrete evidence from files, tools, or session output that supports the result.',
    'Flag unresolved risks, blockers, or follow-up items instead of guessing.',
  ];

  switch (specialistId) {
    case 'planner':
      return [
        `Break down the goal into an execution-ready plan: ${delegatedGoal}`,
        'Call out ordering, dependencies, and risky steps that the parent should validate.',
        ...baseline.slice(1),
      ];
    case 'analyst':
      return [
        `Analyze the delegated scope and return findings for: ${delegatedGoal}`,
        'Back each finding with concrete evidence instead of general impressions.',
        ...baseline.slice(1),
      ];
    case 'verifier':
      return [
        `Verify whether the reviewed delegated result is ready to merge: ${delegatedGoal}`,
        'Return exactly one recommendation: merge, follow_up, or discard.',
        'Validate the reviewed handoff against its stored task contract before recommending merge.',
        'Back the recommendation with concrete evidence and call out any unresolved issues.',
      ];
    case 'captioner':
      return [
        `Produce caption-focused output for: ${delegatedGoal}`,
        'Highlight language, timing, or readability issues that still need attention.',
        ...baseline.slice(1),
      ];
    case 'audio':
      return [
        `Produce audio-focused recommendations or changes for: ${delegatedGoal}`,
        'Call out balance, timing, and conflict risks that affect the final mix.',
        ...baseline.slice(1),
      ];
    case 'colorist':
      return [
        `Produce color-focused recommendations or changes for: ${delegatedGoal}`,
        'Highlight look consistency issues or grading risks that still require review.',
        ...baseline.slice(1),
      ];
    default:
      return baseline;
  }
}

export function buildDelegationTaskContract(
  input: BuildDelegationTaskContractInput,
): DelegationTaskContract {
  return {
    objective: input.delegatedGoal,
    specialistId: input.specialistId,
    specialistName: input.specialistName,
    expectedDeliverables: getExpectedDeliverables(
      input.specialistId,
      input.specialistName,
      input.delegatedGoal,
    ),
    acceptanceChecklist: [
      'Stay inside the delegated scope and do not silently expand the task.',
      'Provide a parent-reviewable summary before declaring the task done.',
      'Attach concrete evidence for important claims whenever possible.',
      'Call out unresolved issues explicitly so the parent can decide the next step.',
      ...(input.specialistId === 'verifier'
        ? ['Conclude with one recommendation: merge, follow_up, or discard.']
        : []),
    ],
    handoffRequirement:
      'Parent verification is required before this delegated result can be merged.',
    verificationSpec: createDefaultVerificationSpec(input.specialistId),
  };
}

export function buildDelegationContextPacket(
  input: BuildDelegationContextPacketInput,
): DelegationContextPacket {
  return {
    source: 'agent-workspace',
    parentSessionId: input.parentSessionId,
    parentAgentId: input.parentAgentId,
    parentAgentName: input.parentAgentName,
    delegatedGoal: input.delegatedGoal,
    createdAt: input.createdAt ?? Date.now(),
    reviewTarget: input.reviewTarget ?? null,
    taskContract: buildDelegationTaskContract(input),
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function normalizeRecommendationArray(value: unknown): DelegationRecommendation[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is DelegationRecommendation =>
          entry === 'merge' || entry === 'follow_up' || entry === 'discard',
      )
    : [];
}

function normalizeReviewTarget(value: unknown): DelegationReviewTarget | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<DelegationReviewTarget>;

  if (
    !isString(candidate.delegationId) ||
    !isString(candidate.childSessionId) ||
    !isString(candidate.agentProfileId)
  ) {
    return null;
  }

  return {
    delegationId: candidate.delegationId,
    childSessionId: candidate.childSessionId,
    agentProfileId: candidate.agentProfileId,
  };
}

function normalizeVerificationSpec(
  value: unknown,
  specialistId?: string,
): DelegationVerificationSpec {
  const fallback = createDefaultVerificationSpec(specialistId);

  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const candidate = value as Partial<DelegationVerificationSpec>;
  const requiredRecommendationOptions = normalizeRecommendationArray(
    candidate.requiredRecommendationOptions,
  );

  return {
    handoffSchemaVersion: 1,
    requireStructuredHandoff:
      typeof candidate.requireStructuredHandoff === 'boolean'
        ? candidate.requireStructuredHandoff
        : true,
    requireSummary: typeof candidate.requireSummary === 'boolean' ? candidate.requireSummary : true,
    requireEvidence:
      typeof candidate.requireEvidence === 'boolean' ? candidate.requireEvidence : true,
    requireOpenIssuesStatement:
      typeof candidate.requireOpenIssuesStatement === 'boolean'
        ? candidate.requireOpenIssuesStatement
        : true,
    minimumEvidenceCount:
      typeof candidate.minimumEvidenceCount === 'number' && candidate.minimumEvidenceCount > 0
        ? Math.floor(candidate.minimumEvidenceCount)
        : 1,
    requiredRecommendationOptions:
      requiredRecommendationOptions.length > 0
        ? requiredRecommendationOptions
        : fallback.requiredRecommendationOptions,
  };
}

export function parseDelegationContextPacket(
  value: string | null | undefined,
  fallback?: ParseDelegationContextPacketFallback,
): DelegationContextPacket | null {
  if (!value) {
    return null;
  }

  try {
    const candidate = JSON.parse(value) as Partial<DelegationContextPacket>;
    const contract = candidate.taskContract;
    const delegatedGoal = isString(candidate.delegatedGoal) ? candidate.delegatedGoal : null;
    const parentSessionId = isString(candidate.parentSessionId)
      ? candidate.parentSessionId
      : 'legacy-parent-session';
    const parentAgentId = isString(candidate.parentAgentId)
      ? candidate.parentAgentId
      : 'legacy-parent-agent';
    const parentAgentName = isString(candidate.parentAgentName)
      ? candidate.parentAgentName
      : 'Parent Agent';
    const specialistId = fallback?.specialistId ?? 'delegated-specialist';
    const specialistName = fallback?.specialistName ?? specialistId;

    if (candidate.source !== undefined && candidate.source !== 'agent-workspace') {
      return null;
    }

    if (!delegatedGoal) {
      return null;
    }

    const taskContract =
      contract &&
      typeof contract === 'object' &&
      isString(contract.objective) &&
      isString(contract.specialistId) &&
      isString(contract.specialistName) &&
      isString(contract.handoffRequirement)
        ? {
            objective: contract.objective,
            specialistId: contract.specialistId,
            specialistName: contract.specialistName,
            expectedDeliverables: normalizeStringArray(contract.expectedDeliverables),
            acceptanceChecklist: normalizeStringArray(contract.acceptanceChecklist),
            handoffRequirement: contract.handoffRequirement,
            verificationSpec: normalizeVerificationSpec(
              contract.verificationSpec,
              contract.specialistId,
            ),
          }
        : buildDelegationTaskContract({
            delegatedGoal,
            specialistId,
            specialistName,
          });

    return {
      source: 'agent-workspace',
      parentSessionId,
      parentAgentId,
      parentAgentName,
      delegatedGoal,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
      reviewTarget: normalizeReviewTarget(candidate.reviewTarget),
      taskContract,
    };
  } catch {
    return null;
  }
}

export function buildDelegationContractSystemMessage(packet: DelegationContextPacket): string {
  const deliverables = packet.taskContract.expectedDeliverables
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
  const checklist = packet.taskContract.acceptanceChecklist
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');

  const recommendationOptions = packet.taskContract.verificationSpec.requiredRecommendationOptions;
  const handoffSchema = {
    ...(recommendationOptions.length > 0 ? { recommendation: recommendationOptions[0] } : {}),
    summary: 'Short parent-reviewable summary',
    openIssues: ['List unresolved issues, or [] when none remain'],
    evidence: [
      { kind: 'summary', value: 'Most important supporting observation' },
      { kind: 'file', value: 'path/to/file.ts' },
      { kind: 'tool', value: 'query_timeline' },
    ],
  };

  return [
    `Delegated from ${packet.parentAgentName}.`,
    `Objective: ${packet.taskContract.objective}`,
    '',
    'Expected handoff:',
    deliverables,
    '',
    'Acceptance checklist:',
    checklist,
    '',
    'Final response requirement:',
    'Return a final DELEGATION_HANDOFF JSON block using this schema:',
    '```json',
    JSON.stringify(handoffSchema, null, 2),
    '```',
    ...(recommendationOptions.length > 0
      ? [`Recommendation must be exactly one of: ${recommendationOptions.join(', ')}.`]
      : []),
    '',
    `Handoff requirement: ${packet.taskContract.handoffRequirement}`,
  ].join('\n');
}
