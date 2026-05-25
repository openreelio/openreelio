import { invoke } from '@tauri-apps/api/core';

import type { AgentPlanApprovalProof, ExternalAgentApprovalTokenGrant } from '@/bindings';

export const AGENT_PLAN_APPROVAL_SCOPE = 'openreelio.plan.apply';
export const AGENT_PLAN_APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface IssueAgentPlanApprovalProofInput {
  sessionId: string;
  runId?: string | null;
  planId: string;
  projectId: string;
  runtimeId: string;
}

export interface IssueAgentPlanApprovalProofResult {
  proof: AgentPlanApprovalProof;
  grant: ExternalAgentApprovalTokenGrant;
}

export async function issueAgentPlanApprovalProof(
  input: IssueAgentPlanApprovalProofInput,
): Promise<IssueAgentPlanApprovalProofResult> {
  const sessionId = input.sessionId.trim();
  const planId = input.planId.trim();
  const projectId = input.projectId.trim();
  const runtimeId = input.runtimeId.trim();
  const runId = input.runId?.trim() || null;

  if (!sessionId) {
    throw new Error('sessionId is required for AgentPlan approval proof');
  }
  if (!planId) {
    throw new Error('planId is required for AgentPlan approval proof');
  }
  if (!projectId) {
    throw new Error('projectId is required for AgentPlan approval proof');
  }
  if (!runtimeId) {
    throw new Error('runtimeId is required for AgentPlan approval proof');
  }

  const grant = await invoke<ExternalAgentApprovalTokenGrant>(
    'create_external_agent_approval_token',
    {
      input: {
        sessionId,
        runId,
        planId,
        projectId,
        runtimeId,
        scopes: [AGENT_PLAN_APPROVAL_SCOPE],
        ttlMs: AGENT_PLAN_APPROVAL_TTL_MS,
      },
    },
  );

  return {
    grant,
    proof: {
      token: grant.token,
      tokenId: grant.tokenId,
      projectId: grant.projectId,
      runtimeId: grant.runtimeId,
      requiredScope: AGENT_PLAN_APPROVAL_SCOPE,
    },
  };
}
