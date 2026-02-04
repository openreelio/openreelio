/**
 * Workflow Module
 *
 * Exports workflow management functionality.
 */

// Workflow state
export {
  createWorkflowState,
  isValidTransition,
  getValidNextPhases,
  isTerminalPhase,
  canCancel,
  getCurrentStep,
  getNextPendingStep,
  getWorkflowProgress,
  getStepStatusSummary,
  getPhaseDescription,
  VALID_TRANSITIONS,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowPhase,
  type StepStatus,
} from './WorkflowState';

// Approval gate
export {
  ApprovalGate,
  createApprovalGate,
  workflowRequiresApproval,
  getStepsRequiringApproval,
  type ApprovalRequest,
  type ApprovalStepSummary,
  type ApprovalResponse,
  type ApprovalRequestHandler,
  type ApprovalResponseHandler,
  type ApprovalGateConfig,
} from './ApprovalGate';

// Checkpoint
export {
  CheckpointManager,
  createCheckpointManager,
  InMemoryCheckpointStorage,
  getCheckpointDiff,
  type Checkpoint,
  type CheckpointConfig,
  type CheckpointStorage,
} from './Checkpoint';

// Workflow engine
export {
  WorkflowEngine,
  createWorkflowEngine,
  type WorkflowEventType,
  type WorkflowEvent,
  type WorkflowEventHandler,
  type StepExecutor,
  type WorkflowEngineConfig,
} from './WorkflowEngine';
