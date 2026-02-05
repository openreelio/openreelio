/**
 * Approval Gate
 *
 * Human-in-the-loop approval system for high-risk operations.
 * Manages approval requests and responses for workflow steps.
 */

import type { WorkflowStep, WorkflowState } from './WorkflowState';
import { createLogger } from '@/services/logger';

const logger = createLogger('ApprovalGate');

// =============================================================================
// Types
// =============================================================================

/**
 * An approval request for user review.
 */
export interface ApprovalRequest {
  /** Unique request identifier */
  id: string;
  /** Associated workflow ID */
  workflowId: string;
  /** Steps requiring approval */
  steps: ApprovalStepSummary[];
  /** Overall risk level */
  riskLevel: 'low' | 'medium' | 'high';
  /** Total number of operations */
  totalOperations: number;
  /** Number of high-risk operations */
  highRiskCount: number;
  /** Human-readable summary */
  summary: string;
  /** When the request was created */
  createdAt: number;
  /** Request expiry time (optional) */
  expiresAt?: number;
}

/**
 * Summary of a step for approval display.
 */
export interface ApprovalStepSummary {
  /** Step ID */
  id: string;
  /** Tool name */
  toolName: string;
  /** Step description */
  description: string;
  /** Whether this specific step requires approval */
  requiresApproval: boolean;
  /** Warning message if applicable */
  warningMessage?: string;
}

/**
 * User's response to an approval request.
 */
export interface ApprovalResponse {
  /** The request ID being responded to */
  requestId: string;
  /** Whether the user approved */
  approved: boolean;
  /** User's reason for rejection (if rejected) */
  reason?: string;
  /** When the response was given */
  respondedAt: number;
}

/**
 * Callback for handling approval requests.
 */
export type ApprovalRequestHandler = (request: ApprovalRequest) => void;

/**
 * Callback for handling approval responses.
 */
export type ApprovalResponseHandler = (response: ApprovalResponse) => void;

/**
 * Configuration for the approval gate.
 */
export interface ApprovalGateConfig {
  /** Timeout for approval requests in milliseconds (default: 5 minutes) */
  requestTimeout?: number;
  /** Auto-approve low-risk operations */
  autoApproveLowRisk?: boolean;
}

// =============================================================================
// Approval Gate
// =============================================================================

/**
 * Manages human-in-the-loop approval for workflow operations.
 *
 * Features:
 * - Creates approval requests from workflow state
 * - Tracks pending requests
 * - Handles timeouts and expiry
 * - Supports auto-approval for low-risk operations
 *
 * @example
 * ```typescript
 * const gate = new ApprovalGate({ requestTimeout: 300000 });
 *
 * // Subscribe to approval requests
 * gate.onRequest((request) => {
 *   showApprovalDialog(request);
 * });
 *
 * // Create a request
 * const request = gate.createRequest(workflowState);
 *
 * // User responds
 * gate.respond({ requestId: request.id, approved: true, respondedAt: Date.now() });
 * ```
 */
export class ApprovalGate {
  private pendingRequests: Map<string, ApprovalRequest> = new Map();
  private requestHandlers: Set<ApprovalRequestHandler> = new Set();
  private responseHandlers: Set<ApprovalResponseHandler> = new Set();
  private responsePromises: Map<string, {
    resolve: (response: ApprovalResponse) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private requestTimeout: number;
  private autoApproveLowRisk: boolean;

  constructor(config: ApprovalGateConfig = {}) {
    this.requestTimeout = config.requestTimeout ?? 300000; // 5 minutes
    this.autoApproveLowRisk = config.autoApproveLowRisk ?? false;
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  /**
   * Subscribe to approval requests.
   *
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  onRequest(handler: ApprovalRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  /**
   * Subscribe to approval responses.
   *
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  onResponse(handler: ApprovalResponseHandler): () => void {
    this.responseHandlers.add(handler);
    return () => this.responseHandlers.delete(handler);
  }

  // ===========================================================================
  // Request Management
  // ===========================================================================

  /**
   * Create an approval request from workflow state.
   *
   * @param workflow - The workflow state
   * @param customSummary - Optional custom summary message
   * @returns The approval request, or null if no approval needed
   */
  createRequest(
    workflow: WorkflowState,
    customSummary?: string
  ): ApprovalRequest | null {
    const stepsRequiringApproval = workflow.steps.filter((s) => s.requiresApproval);

    // Auto-approve if no high-risk operations and auto-approve is enabled
    if (stepsRequiringApproval.length === 0 && this.autoApproveLowRisk) {
      return null;
    }

    const stepSummaries: ApprovalStepSummary[] = workflow.steps.map((step) => ({
      id: step.id,
      toolName: step.toolName,
      description: step.description,
      requiresApproval: step.requiresApproval,
    }));

    const highRiskCount = stepsRequiringApproval.length;
    const riskLevel = this.calculateRiskLevel(workflow);

    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      steps: stepSummaries,
      riskLevel,
      totalOperations: workflow.steps.length,
      highRiskCount,
      summary: customSummary ?? this.generateSummary(workflow, highRiskCount),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.requestTimeout,
    };

    this.pendingRequests.set(request.id, request);

    // Notify handlers
    for (const handler of this.requestHandlers) {
      try {
        handler(request);
      } catch (error) {
        logger.error('Error in approval request handler', { error });
      }
    }

    logger.info('Approval request created', {
      requestId: request.id,
      workflowId: workflow.id,
      highRiskCount,
    });

    return request;
  }

  /**
   * Wait for approval response with timeout.
   *
   * @param requestId - The request ID
   * @returns Promise that resolves with the response
   */
  async waitForResponse(requestId: string): Promise<ApprovalResponse> {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    const timeout = request.expiresAt
      ? request.expiresAt - Date.now()
      : this.requestTimeout;

    return new Promise((resolve, reject) => {
      // Store promise handlers for later resolution
      this.responsePromises.set(requestId, { resolve, reject });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.responsePromises.delete(requestId);
        this.pendingRequests.delete(requestId);
        reject(new Error('Approval request timed out'));
      }, timeout);

      // Modify resolve to clear timeout
      const originalResolve = resolve;
      this.responsePromises.set(requestId, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          originalResolve(response);
        },
        reject,
      });
    });
  }

  /**
   * Submit a response to an approval request.
   *
   * @param response - The approval response
   */
  respond(response: ApprovalResponse): void {
    const request = this.pendingRequests.get(response.requestId);
    if (!request) {
      logger.warn('Response for unknown request', { requestId: response.requestId });
      return;
    }

    // Check expiry
    if (request.expiresAt && Date.now() > request.expiresAt) {
      logger.warn('Response for expired request', { requestId: response.requestId });
      return;
    }

    // Remove from pending
    this.pendingRequests.delete(response.requestId);

    // Resolve waiting promise
    const promiseHandlers = this.responsePromises.get(response.requestId);
    if (promiseHandlers) {
      this.responsePromises.delete(response.requestId);
      promiseHandlers.resolve(response);
    }

    // Notify response handlers
    for (const handler of this.responseHandlers) {
      try {
        handler(response);
      } catch (error) {
        logger.error('Error in approval response handler', { error });
      }
    }

    logger.info('Approval response received', {
      requestId: response.requestId,
      approved: response.approved,
    });
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Get a pending request by ID.
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  /**
   * Get all pending requests.
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Check if a request is pending.
   */
  isPending(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  /**
   * Cancel a pending request.
   */
  cancelRequest(requestId: string): void {
    const promiseHandlers = this.responsePromises.get(requestId);
    if (promiseHandlers) {
      promiseHandlers.reject(new Error('Request cancelled'));
      this.responsePromises.delete(requestId);
    }
    this.pendingRequests.delete(requestId);
    logger.debug('Approval request cancelled', { requestId });
  }

  /**
   * Clear all pending requests.
   */
  clearAll(): void {
    for (const handlers of this.responsePromises.values()) {
      handlers.reject(new Error('All requests cleared'));
    }
    this.responsePromises.clear();
    this.pendingRequests.clear();
    logger.debug('All approval requests cleared');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private calculateRiskLevel(workflow: WorkflowState): 'low' | 'medium' | 'high' {
    const highRiskCount = workflow.steps.filter((s) => s.requiresApproval).length;

    if (highRiskCount === 0) return 'low';
    if (highRiskCount <= 2) return 'medium';
    return 'high';
  }

  private generateSummary(workflow: WorkflowState, highRiskCount: number): string {
    const totalOps = workflow.steps.length;

    if (highRiskCount === 0) {
      return `Execute ${totalOps} operation${totalOps === 1 ? '' : 's'}`;
    }

    return `Execute ${totalOps} operation${totalOps === 1 ? '' : 's'} (${highRiskCount} require${highRiskCount === 1 ? 's' : ''} approval)`;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new ApprovalGate instance.
 */
export function createApprovalGate(config?: ApprovalGateConfig): ApprovalGate {
  return new ApprovalGate(config);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a workflow requires approval.
 *
 * @param workflow - Workflow state
 * @returns Whether approval is required
 */
export function workflowRequiresApproval(workflow: WorkflowState): boolean {
  return workflow.hasHighRiskOperations;
}

/**
 * Get steps that require approval from a workflow.
 *
 * @param workflow - Workflow state
 * @returns Steps requiring approval
 */
export function getStepsRequiringApproval(workflow: WorkflowState): WorkflowStep[] {
  return workflow.steps.filter((s) => s.requiresApproval);
}
