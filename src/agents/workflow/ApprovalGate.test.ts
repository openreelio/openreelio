/**
 * Approval Gate Tests
 *
 * Tests for human-in-the-loop approval system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApprovalGate,
  createApprovalGate,
  workflowRequiresApproval,
  getStepsRequiringApproval,
  type ApprovalResponse,
} from './ApprovalGate';
import { createWorkflowState } from './WorkflowState';

describe('ApprovalGate', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = createApprovalGate();
  });

  describe('createRequest', () => {
    it('should create request from workflow', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'safe', args: {}, description: 'Safe op', requiresApproval: false },
        { toolName: 'risky', args: {}, description: 'Risky op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow);

      expect(request).not.toBeNull();
      expect(request?.workflowId).toBe(workflow.id);
      expect(request?.totalOperations).toBe(2);
      expect(request?.highRiskCount).toBe(1);
      expect(request?.steps).toHaveLength(2);
    });

    it('should calculate risk level correctly', () => {
      const lowRiskWorkflow = createWorkflowState('Test', [
        { toolName: 'safe', args: {}, description: 'Safe', requiresApproval: false },
      ]);

      const mediumRiskWorkflow = createWorkflowState('Test', [
        { toolName: 'risky', args: {}, description: 'Risky', requiresApproval: true },
      ]);

      const highRiskWorkflow = createWorkflowState('Test', [
        { toolName: 'risky1', args: {}, description: 'Risky 1', requiresApproval: true },
        { toolName: 'risky2', args: {}, description: 'Risky 2', requiresApproval: true },
        { toolName: 'risky3', args: {}, description: 'Risky 3', requiresApproval: true },
      ]);

      const lowRequest = gate.createRequest(lowRiskWorkflow);
      const mediumRequest = gate.createRequest(mediumRiskWorkflow);
      const highRequest = gate.createRequest(highRiskWorkflow);

      expect(lowRequest?.riskLevel).toBe('low');
      expect(mediumRequest?.riskLevel).toBe('medium');
      expect(highRequest?.riskLevel).toBe('high');
    });

    it('should notify request handlers', () => {
      const handler = vi.fn();
      gate.onRequest(handler);

      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      gate.createRequest(workflow);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        workflowId: workflow.id,
      }));
    });

    it('should allow custom summary', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: false },
      ]);

      const request = gate.createRequest(workflow, 'Custom summary message');

      expect(request?.summary).toBe('Custom summary message');
    });

    it('should return null when auto-approve enabled and no high-risk', () => {
      const gateWithAutoApprove = createApprovalGate({ autoApproveLowRisk: true });

      const workflow = createWorkflowState('Test', [
        { toolName: 'safe', args: {}, description: 'Safe', requiresApproval: false },
      ]);

      const request = gateWithAutoApprove.createRequest(workflow);
      expect(request).toBeNull();
    });
  });

  describe('respond', () => {
    it('should handle approval response', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;
      expect(gate.isPending(request.id)).toBe(true);

      gate.respond({
        requestId: request.id,
        approved: true,
        respondedAt: Date.now(),
      });

      expect(gate.isPending(request.id)).toBe(false);
    });

    it('should notify response handlers', () => {
      const handler = vi.fn();
      gate.onResponse(handler);

      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;
      const response: ApprovalResponse = {
        requestId: request.id,
        approved: false,
        reason: 'Too risky',
        respondedAt: Date.now(),
      };

      gate.respond(response);

      expect(handler).toHaveBeenCalledWith(response);
    });

    it('should ignore response for unknown request', () => {
      const handler = vi.fn();
      gate.onResponse(handler);

      gate.respond({
        requestId: 'unknown_id',
        approved: true,
        respondedAt: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('waitForResponse', () => {
    it('should resolve when response is received', async () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;

      // Respond after a small delay
      setTimeout(() => {
        gate.respond({
          requestId: request.id,
          approved: true,
          respondedAt: Date.now(),
        });
      }, 10);

      const response = await gate.waitForResponse(request.id);

      expect(response.approved).toBe(true);
    });

    it('should reject on timeout', async () => {
      const gateWithShortTimeout = createApprovalGate({ requestTimeout: 50 });

      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gateWithShortTimeout.createRequest(workflow)!;

      await expect(
        gateWithShortTimeout.waitForResponse(request.id)
      ).rejects.toThrow('timed out');
    });

    it('should reject for unknown request', async () => {
      await expect(
        gate.waitForResponse('unknown_id')
      ).rejects.toThrow('not found');
    });
  });

  describe('cancelRequest', () => {
    it('should remove pending request', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;
      gate.cancelRequest(request.id);

      expect(gate.isPending(request.id)).toBe(false);
    });

    it('should reject waiting promise', async () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;

      const waitPromise = gate.waitForResponse(request.id);
      gate.cancelRequest(request.id);

      await expect(waitPromise).rejects.toThrow('cancelled');
    });
  });

  describe('query methods', () => {
    it('should get request by ID', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;
      const retrieved = gate.getRequest(request.id);

      expect(retrieved).toEqual(request);
    });

    it('should get all pending requests', () => {
      const workflow1 = createWorkflowState('Test 1', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const workflow2 = createWorkflowState('Test 2', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      gate.createRequest(workflow1);
      gate.createRequest(workflow2);

      const pending = gate.getPendingRequests();
      expect(pending).toHaveLength(2);
    });

    it('should clear all requests', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      gate.createRequest(workflow);
      gate.createRequest(workflow);

      gate.clearAll();

      expect(gate.getPendingRequests()).toHaveLength(0);
    });
  });

  describe('event subscription', () => {
    it('should allow unsubscribing from requests', () => {
      const handler = vi.fn();
      const unsubscribe = gate.onRequest(handler);

      unsubscribe();

      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      gate.createRequest(workflow);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should allow unsubscribing from responses', () => {
      const handler = vi.fn();
      const unsubscribe = gate.onResponse(handler);

      unsubscribe();

      const workflow = createWorkflowState('Test', [
        { toolName: 'tool', args: {}, description: 'Op', requiresApproval: true },
      ]);

      const request = gate.createRequest(workflow)!;
      gate.respond({ requestId: request.id, approved: true, respondedAt: Date.now() });

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe('utility functions', () => {
  describe('workflowRequiresApproval', () => {
    it('should return true when high-risk operations present', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'risky', args: {}, description: 'Risky', requiresApproval: true },
      ]);

      expect(workflowRequiresApproval(workflow)).toBe(true);
    });

    it('should return false when no high-risk operations', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'safe', args: {}, description: 'Safe', requiresApproval: false },
      ]);

      expect(workflowRequiresApproval(workflow)).toBe(false);
    });
  });

  describe('getStepsRequiringApproval', () => {
    it('should return only steps requiring approval', () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'safe', args: {}, description: 'Safe', requiresApproval: false },
        { toolName: 'risky1', args: {}, description: 'Risky 1', requiresApproval: true },
        { toolName: 'risky2', args: {}, description: 'Risky 2', requiresApproval: true },
      ]);

      const riskySteps = getStepsRequiringApproval(workflow);

      expect(riskySteps).toHaveLength(2);
      expect(riskySteps.every((s) => s.requiresApproval)).toBe(true);
    });
  });
});
