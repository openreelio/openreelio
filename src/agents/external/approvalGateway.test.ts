import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PLAN_APPLY_APPROVAL_TTL_MS,
  ExternalAgentApprovalGateway,
  PLAN_APPLY_APPROVAL_SCOPE,
} from './approvalGateway';
import type { ExternalAgentApprovalTokenGrant } from './types';

function grant(
  overrides: Partial<ExternalAgentApprovalTokenGrant> = {},
): ExternalAgentApprovalTokenGrant {
  return {
    token: 'or_mcp_test_token',
    tokenId: 'token-1',
    sessionId: 'session-1',
    runId: 'run-1',
    planId: 'plan-1',
    projectId: 'project-1',
    runtimeId: 'codex',
    scopes: [PLAN_APPLY_APPROVAL_SCOPE],
    createdAt: 1_000,
    expiresAt: 601_000,
    ...overrides,
  };
}

describe('ExternalAgentApprovalGateway', () => {
  it('issues plan-apply tokens through IPC and records permission audit', async () => {
    const issuedGrant = grant();
    const invokeCommand = vi.fn().mockResolvedValue(issuedGrant);
    const auditRecorder = {
      recordPermissionDecision: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ExternalAgentApprovalGateway({ invoke: invokeCommand, auditRecorder });

    await expect(
      gateway.issuePlanApplyToken({
        sessionId: 'session-1',
        runId: 'run-1',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
      }),
    ).resolves.toEqual(issuedGrant);

    expect(invokeCommand).toHaveBeenCalledWith('create_external_agent_approval_token', {
      input: {
        sessionId: 'session-1',
        runId: 'run-1',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
        scopes: [PLAN_APPLY_APPROVAL_SCOPE],
        ttlMs: DEFAULT_PLAN_APPLY_APPROVAL_TTL_MS,
      },
    });
    expect(auditRecorder.recordPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        stepId: 'plan-1',
        subjectType: 'approval',
        subject: 'codex:openreelio.plan.apply:plan-1',
        action: 'allow',
        source: 'interactive_approval',
      }),
    );
  });

  it('returns an issued token even when audit persistence fails', async () => {
    const issuedGrant = grant();
    const gateway = new ExternalAgentApprovalGateway({
      invoke: vi.fn().mockResolvedValue(issuedGrant),
      auditRecorder: {
        recordPermissionDecision: vi.fn().mockRejectedValue(new Error('database unavailable')),
      },
    });

    await expect(
      gateway.issuePlanApplyToken({
        sessionId: 'session-1',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
      }),
    ).resolves.toEqual(issuedGrant);
  });

  it('normalizes required identifiers before issuing and auditing tokens', async () => {
    const issuedGrant = grant();
    const invokeCommand = vi.fn().mockResolvedValue(issuedGrant);
    const auditRecorder = {
      recordPermissionDecision: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ExternalAgentApprovalGateway({ invoke: invokeCommand, auditRecorder });

    await gateway.issuePlanApplyToken({
      sessionId: ' session-1 ',
      runId: ' run-1 ',
      planId: ' plan-1 ',
      projectId: ' project-1 ',
      runtimeId: ' codex ',
    });

    expect(invokeCommand).toHaveBeenCalledWith('create_external_agent_approval_token', {
      input: expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
      }),
    });
    expect(auditRecorder.recordPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        stepId: 'plan-1',
        subject: 'codex:openreelio.plan.apply:plan-1',
      }),
    );
  });

  it('consumes plan-apply tokens with the required approval scope', async () => {
    const validation = { valid: true, reason: null, grant: null };
    const invokeCommand = vi.fn().mockResolvedValue(validation);
    const gateway = new ExternalAgentApprovalGateway({ invoke: invokeCommand });

    await expect(
      gateway.consumePlanApplyToken({
        token: 'or_mcp_test_token',
        sessionId: 'session-1',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
      }),
    ).resolves.toEqual(validation);

    expect(invokeCommand).toHaveBeenCalledWith('consume_external_agent_approval_token', {
      input: {
        token: 'or_mcp_test_token',
        sessionId: 'session-1',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
        requiredScope: PLAN_APPLY_APPROVAL_SCOPE,
      },
    });
  });

  it('builds MCP process environment from a grant without long-lived config', () => {
    const gateway = new ExternalAgentApprovalGateway({
      invoke: vi.fn(),
    });

    expect(gateway.buildMcpApprovalEnvironment(grant())).toEqual({
      OPENREELIO_MCP_APPROVAL_TOKEN: 'or_mcp_test_token',
      OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS: '601000',
      OPENREELIO_MCP_APPROVAL_SESSION_ID: 'session-1',
      OPENREELIO_MCP_APPROVAL_PLAN_ID: 'plan-1',
      OPENREELIO_MCP_APPROVAL_PROJECT_ID: 'project-1',
      OPENREELIO_MCP_APPROVAL_RUNTIME_ID: 'codex',
    });
  });

  it('rejects blank plan ids before issuing IPC tokens', async () => {
    const invokeCommand = vi.fn();
    const gateway = new ExternalAgentApprovalGateway({ invoke: invokeCommand });

    await expect(
      gateway.issuePlanApplyToken({
        sessionId: 'session-1',
        planId: ' ',
        projectId: 'project-1',
        runtimeId: 'codex',
      }),
    ).rejects.toThrow('planId is required');
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it('rejects blank required identifiers before issuing IPC tokens', async () => {
    const invokeCommand = vi.fn();
    const gateway = new ExternalAgentApprovalGateway({ invoke: invokeCommand });

    await expect(
      gateway.issuePlanApplyToken({
        sessionId: ' ',
        planId: 'plan-1',
        projectId: 'project-1',
        runtimeId: 'codex',
      }),
    ).rejects.toThrow('sessionId is required');
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});
