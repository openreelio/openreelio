/**
 * Tauri API Mocks
 *
 * Provides typed mock implementations for Tauri IPC commands.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Mock } from 'vitest';

// =============================================================================
// Types
// =============================================================================

export interface MockProjectMeta {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  modifiedAt: string;
}

export interface MockAsset {
  id: string;
  name: string;
  uri: string;
  assetType: string;
  durationSec: number | null;
}

export interface MockSequence {
  id: string;
  name: string;
  format: string;
  tracks: unknown[];
}

export interface MockCommandResult {
  opId: string;
  changes: unknown[];
  createdIds: string[];
  deletedIds: string[];
}

// =============================================================================
// Mock Implementations
// =============================================================================

/**
 * Creates a mock project metadata object
 */
export function createMockProjectMeta(overrides: Partial<MockProjectMeta> = {}): MockProjectMeta {
  return {
    id: 'proj_001',
    name: 'Test Project',
    path: '/path/to/project',
    createdAt: '2024-01-01T00:00:00Z',
    modifiedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a mock asset object
 */
export function createMockAsset(overrides: Partial<MockAsset> = {}): MockAsset {
  return {
    id: `asset_${Math.random().toString(36).substring(7)}`,
    name: 'video.mp4',
    uri: '/path/to/video.mp4',
    assetType: 'video',
    durationSec: 120.0,
    ...overrides,
  };
}

/**
 * Creates a mock sequence object
 */
export function createMockSequence(overrides: Partial<MockSequence> = {}): MockSequence {
  return {
    id: `seq_${Math.random().toString(36).substring(7)}`,
    name: 'Main Sequence',
    format: 'youtube_1080',
    tracks: [],
    ...overrides,
  };
}

/**
 * Creates a mock command result
 */
export function createMockCommandResult(overrides: Partial<MockCommandResult> = {}): MockCommandResult {
  return {
    opId: `op_${Math.random().toString(36).substring(7)}`,
    changes: [],
    createdIds: [],
    deletedIds: [],
    ...overrides,
  };
}

// =============================================================================
// Mock Setup Utilities
// =============================================================================

const mockedInvoke = invoke as Mock;

/**
 * Sets up Tauri invoke mock with predefined responses
 */
export function setupTauriMocks(mocks: Record<string, unknown> = {}): void {
  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd in mocks) {
      const mock = mocks[cmd];
      return Promise.resolve(typeof mock === 'function' ? mock(args) : mock);
    }
    return Promise.reject(new Error(`Unhandled invoke: ${cmd}`));
  });
}

/**
 * Sets up a single command mock
 */
export function mockTauriCommand<T>(command: string, response: T | ((args: unknown) => T)): void {
  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === command) {
      return Promise.resolve(typeof response === 'function' ? (response as (args: unknown) => T)(args) : response);
    }
    return Promise.reject(new Error(`Unhandled invoke: ${cmd}`));
  });
}

/**
 * Sets up a command mock that throws an error
 */
export function mockTauriCommandError(command: string, error: string): void {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === command) {
      return Promise.reject(new Error(error));
    }
    return Promise.reject(new Error(`Unhandled invoke: ${cmd}`));
  });
}

/**
 * Gets the mock invoke function for assertions
 */
export function getMockedInvoke(): Mock {
  return mockedInvoke;
}

/**
 * Resets all Tauri mocks
 */
export function resetTauriMocks(): void {
  mockedInvoke.mockReset();
}
