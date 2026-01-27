/**
 * Test Mocks Index
 *
 * Central export point for all test mock factories.
 * Import from '@/test/mocks' to access any mock factory.
 */

// =============================================================================
// Timeline Mocks
// =============================================================================

export {
  // Track mocks
  createMockTrack,
  createMockVideoTrack,
  createMockAudioTrack,
  // Clip mocks
  createMockClip,
  createMockClips,
  // Sequence mocks
  createMockSequence,
  createMockSequenceWithTracks,
  // Asset mocks
  createMockAsset,
  createMockVideoAsset,
  createMockAudioAsset,
  // Marker mocks
  createMockMarker,
} from './timeline';

// =============================================================================
// Event Mocks
// =============================================================================

export {
  // Mouse events
  createMockMouseEvent,
  type MockMouseEventOptions,
  // Drag events
  createMockDragEvent,
  type MockDragEventOptions,
  // Keyboard events
  createMockKeyboardEvent,
  type MockKeyboardEventOptions,
  // Wheel events
  createMockWheelEvent,
  type MockWheelEventOptions,
  // DOM elements
  createMockElement,
  type MockElementOptions,
  // Event listeners
  createMockTauriListen,
  createMockEventEmitter,
} from './events';

// =============================================================================
// Job Mocks
// =============================================================================

export {
  // Job status factories
  createQueuedStatus,
  createRunningStatus,
  createCompletedStatus,
  createFailedStatus,
  createCancelledStatus,
  // Job info factories
  createMockJob,
  createMockQueuedJob,
  createMockRunningJob,
  createMockCompletedJob,
  createMockFailedJob,
  createMockJobs,
  // Job stats factories
  createMockJobStats,
  createMockIdleStats,
  createMockBusyStats,
  // Job event payloads
  createMockJobProgressPayload,
  createMockJobCompletionPayload,
  createMockJobFailurePayload,
} from './jobs';

// =============================================================================
// Tauri Mocks
// =============================================================================

export {
  // Mock types
  type MockProjectMeta,
  type MockAsset,
  type MockSequence,
  type MockCommandResult,
  // Factory functions
  createMockProjectMeta,
  createMockAsset as createMockTauriAsset,
  createMockSequence as createMockTauriSequence,
  createMockCommandResult,
  createMockProjectState,
  // Mock setup utilities
  setupTauriMocks,
  mockTauriCommand,
  mockTauriCommands,
  mockTauriCommandError,
  getMockedInvoke,
  resetTauriMocks,
} from './tauri';
