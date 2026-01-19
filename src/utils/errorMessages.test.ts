/**
 * Error Messages Utility Tests
 *
 * Tests for user-friendly error message conversion.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getUserFriendlyError,
  getErrorSeverity,
  createErrorHandler,
} from './errorMessages';

// Mock the logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// getUserFriendlyError Tests
// =============================================================================

describe('getUserFriendlyError', () => {
  describe('Project Errors', () => {
    it('should handle project not found', () => {
      const result = getUserFriendlyError('Project not found: /path/to/project');
      expect(result).toBe('The project could not be found. Please check the file path.');
    });

    it('should handle project already open', () => {
      const result = getUserFriendlyError('Project already open');
      expect(result).toBe('A project is already open. Please close it first.');
    });

    it('should handle no project open', () => {
      const result = getUserFriendlyError('No project open');
      expect(result).toBe('Please open or create a project first.');
    });

    it('should handle corrupted project', () => {
      const result = getUserFriendlyError('Project file corrupted: invalid JSON');
      expect(result).toBe('The project file appears to be corrupted. Try opening a backup.');
    });
  });

  describe('Asset Errors', () => {
    it('should handle asset not found', () => {
      const result = getUserFriendlyError('Asset not found: asset_001');
      expect(result).toBe('The media file could not be found. It may have been moved or deleted.');
    });

    it('should handle asset in use', () => {
      const result = getUserFriendlyError('Asset in use: asset_001');
      expect(result).toBe('This asset is being used in the timeline and cannot be removed.');
    });

    it('should handle unsupported format', () => {
      const result = getUserFriendlyError('Unsupported asset format: .xyz');
      expect(result).toBe('This file format is not supported.');
    });

    it('should handle import failure', () => {
      const result = getUserFriendlyError('Asset import failed: codec not found');
      expect(result).toBe('Could not import the file. Make sure it is a supported format.');
    });
  });

  describe('Timeline Errors', () => {
    it('should handle clip not found', () => {
      const result = getUserFriendlyError('Clip not found: clip_001');
      expect(result).toBe('The clip could not be found on the timeline.');
    });

    it('should handle invalid split point', () => {
      const result = getUserFriendlyError('Invalid split point: 5.0 seconds');
      expect(result).toBe('Cannot split at this position. Move the playhead inside the clip.');
    });

    it('should handle clip conflict', () => {
      const result = getUserFriendlyError('Clip conflict: another clip exists at this position');
      expect(result).toBe('Another clip already exists at this position.');
    });
  });

  describe('Command Errors', () => {
    it('should handle nothing to undo', () => {
      const result = getUserFriendlyError('Nothing to undo');
      expect(result).toBe('Nothing to undo.');
    });

    it('should handle nothing to redo', () => {
      const result = getUserFriendlyError('Nothing to redo');
      expect(result).toBe('Nothing to redo.');
    });
  });

  describe('Render Errors', () => {
    it('should handle render failure', () => {
      const result = getUserFriendlyError('Render failed: out of memory');
      expect(result).toBe('Export failed. Please check your settings and try again.');
    });

    it('should handle FFmpeg not available', () => {
      const result = getUserFriendlyError('FFmpeg not available');
      expect(result).toBe('FFmpeg is not installed. Export and preview features require FFmpeg.');
    });

    it('should handle FFmpeg error', () => {
      const result = getUserFriendlyError('FFmpeg execution failed: invalid codec');
      expect(result).toBe('Video processing failed. Please check the file format.');
    });
  });

  describe('AI Errors', () => {
    it('should handle empty intent', () => {
      const result = getUserFriendlyError('Intent cannot be empty');
      expect(result).toBe('Please enter a command for the AI.');
    });

    it('should handle AI request failure', () => {
      const result = getUserFriendlyError('AI request failed: timeout');
      expect(result).toBe('AI processing failed. Please try again.');
    });
  });

  describe('Error Objects', () => {
    it('should handle Error objects', () => {
      const error = new Error('Clip not found: clip_001');
      const result = getUserFriendlyError(error);
      expect(result).toBe('The clip could not be found on the timeline.');
    });
  });

  describe('Unknown Errors', () => {
    it('should return generic message for unknown errors', () => {
      const result = getUserFriendlyError('Some random unknown error xyz123');
      expect(result).toMatch(/error occurred/i);
    });
  });
});

// =============================================================================
// getErrorSeverity Tests
// =============================================================================

describe('getErrorSeverity', () => {
  it('should return warning for nothing to undo', () => {
    expect(getErrorSeverity('Nothing to undo')).toBe('warning');
  });

  it('should return warning for nothing to redo', () => {
    expect(getErrorSeverity('Nothing to redo')).toBe('warning');
  });

  it('should return warning for already open', () => {
    expect(getErrorSeverity('Project already open')).toBe('warning');
  });

  it('should return warning for asset in use', () => {
    expect(getErrorSeverity('Asset in use: asset_001')).toBe('warning');
  });

  it('should return error for serious errors', () => {
    expect(getErrorSeverity('Render failed')).toBe('error');
    expect(getErrorSeverity('Asset import failed')).toBe('error');
    expect(getErrorSeverity('Project corrupted')).toBe('error');
  });

  it('should handle Error objects', () => {
    const error = new Error('Nothing to undo');
    expect(getErrorSeverity(error)).toBe('warning');
  });
});

// =============================================================================
// createErrorHandler Tests
// =============================================================================

describe('createErrorHandler', () => {
  it('should call showWarning for warning severity errors', () => {
    const showError = vi.fn();
    const showWarning = vi.fn();
    const handler = createErrorHandler(showError, showWarning);

    handler('Nothing to undo');

    expect(showWarning).toHaveBeenCalledWith('Nothing to undo.');
    expect(showError).not.toHaveBeenCalled();
  });

  it('should call showError for error severity errors', () => {
    const showError = vi.fn();
    const showWarning = vi.fn();
    const handler = createErrorHandler(showError, showWarning);

    handler('Render failed: out of memory');

    expect(showError).toHaveBeenCalledWith('Export failed. Please check your settings and try again.');
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('should handle errors and call appropriate show function', () => {
    const showError = vi.fn();
    const showWarning = vi.fn();
    const handler = createErrorHandler(showError, showWarning);

    handler('Some unknown error');

    // The handler should call showError for unknown errors
    expect(showError).toHaveBeenCalled();
    // Logger is mocked so we just verify the function completes without throwing
  });
});
