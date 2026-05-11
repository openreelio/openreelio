import { invoke } from '@tauri-apps/api/core';

import { createLogger } from '@/services/logger';

import {
  createAgentSessionBackend,
  type CreatePersistedPermissionDecisionInput,
} from '../engine/core/agentSessionBackend';
import type {
  ConsumeExternalAgentPlanApplyApprovalInput,
  CreateExternalAgentPlanApplyApprovalInput,
  ExternalAgentApprovalTokenGrant,
  ExternalAgentApprovalTokenValidation,
  ExternalAgentMcpApprovalEnvironment,
} from './types';

export const PLAN_APPLY_APPROVAL_SCOPE = 'openreelio.plan.apply' as const;
export const DEFAULT_PLAN_APPLY_APPROVAL_TTL_MS = 10 * 60 * 1000;

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface PermissionAuditRecorder {
  recordPermissionDecision(input: CreatePersistedPermissionDecisionInput): Promise<unknown>;
}

export interface ExternalAgentApprovalGatewayDependencies {
  invoke?: TauriInvoke;
  auditRecorder?: PermissionAuditRecorder;
}

const logger = createLogger('ExternalAgentApprovalGateway');

export class ExternalAgentApprovalGateway {
  private readonly invokeCommand: TauriInvoke;
  private readonly auditRecorder: PermissionAuditRecorder;

  constructor(dependencies: ExternalAgentApprovalGatewayDependencies = {}) {
    this.invokeCommand = dependencies.invoke ?? invoke;
    this.auditRecorder = dependencies.auditRecorder ?? createAgentSessionBackend();
  }

  async issuePlanApplyToken(
    input: CreateExternalAgentPlanApplyApprovalInput,
  ): Promise<ExternalAgentApprovalTokenGrant> {
    if (!input.planId.trim()) {
      throw new Error('planId is required for external agent plan apply approval');
    }

    const grant = (await this.invokeCommand('create_external_agent_approval_token', {
      input: {
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        planId: input.planId,
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        scopes: [PLAN_APPLY_APPROVAL_SCOPE],
        ttlMs: input.ttlMs ?? DEFAULT_PLAN_APPLY_APPROVAL_TTL_MS,
      },
    })) as ExternalAgentApprovalTokenGrant;

    await this.persistPlanApplyAudit(input, grant);
    return grant;
  }

  async consumePlanApplyToken(
    input: ConsumeExternalAgentPlanApplyApprovalInput,
  ): Promise<ExternalAgentApprovalTokenValidation> {
    return (await this.invokeCommand('consume_external_agent_approval_token', {
      input: {
        token: input.token,
        sessionId: input.sessionId,
        planId: input.planId,
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        requiredScope: PLAN_APPLY_APPROVAL_SCOPE,
      },
    })) as ExternalAgentApprovalTokenValidation;
  }

  async revokeToken(token: string): Promise<boolean> {
    const result = (await this.invokeCommand('revoke_external_agent_approval_token', {
      input: { token },
    })) as { revoked: boolean };
    return result.revoked;
  }

  buildMcpApprovalEnvironment(
    grant: ExternalAgentApprovalTokenGrant,
  ): ExternalAgentMcpApprovalEnvironment {
    return {
      OPENREELIO_MCP_APPROVAL_TOKEN: grant.token,
      OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS: String(grant.expiresAt),
    };
  }

  private async persistPlanApplyAudit(
    input: CreateExternalAgentPlanApplyApprovalInput,
    grant: ExternalAgentApprovalTokenGrant,
  ): Promise<void> {
    try {
      await this.auditRecorder.recordPermissionDecision({
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        stepId: input.planId,
        subjectType: 'approval',
        subject: `${input.runtimeId}:${PLAN_APPLY_APPROVAL_SCOPE}:${input.planId}`,
        action: 'allow',
        source: 'interactive_approval',
        reason: `Issued external agent plan-apply approval for ${input.runtimeId}; token expires at ${new Date(
          grant.expiresAt,
        ).toISOString()}`,
      });
    } catch (error) {
      logger.warn('Failed to persist external agent approval audit', {
        sessionId: input.sessionId,
        planId: input.planId,
        runtimeId: input.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createExternalAgentApprovalGateway(
  dependencies: ExternalAgentApprovalGatewayDependencies = {},
): ExternalAgentApprovalGateway {
  return new ExternalAgentApprovalGateway(dependencies);
}
