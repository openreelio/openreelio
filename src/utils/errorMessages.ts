/**
 * Error Message Utilities
 *
 * Converts backend error messages to user-friendly messages.
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('ErrorMessages');

// =============================================================================
// Error Message Mapping
// =============================================================================

/** Error patterns and their user-friendly messages */
const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  message: (matches: RegExpMatchArray) => string;
}> = [
  // Project Errors
  {
    pattern: /Project not found/i,
    message: () => 'The project could not be found. Please check the file path.',
  },
  {
    pattern: /Project already open/i,
    message: () => 'A project is already open. Please close it first.',
  },
  {
    pattern: /Project file corrupted/i,
    message: () => 'The project file appears to be corrupted. Try opening a backup.',
  },
  {
    pattern: /Failed to save project/i,
    message: () => 'Could not save the project. Check if you have write permissions.',
  },
  {
    pattern: /No project open/i,
    message: () => 'Please open or create a project first.',
  },

  // Asset Errors
  {
    pattern: /Asset not found: (.+)/i,
    message: () => 'The media file could not be found. It may have been moved or deleted.',
  },
  {
    pattern: /Asset in use/i,
    message: () => 'This asset is being used in the timeline and cannot be removed.',
  },
  {
    pattern: /Asset import failed/i,
    message: () => 'Could not import the file. Make sure it is a supported format.',
  },
  {
    pattern: /Unsupported asset format/i,
    message: () => 'This file format is not supported.',
  },
  {
    pattern: /File not found/i,
    message: () => 'The file could not be found. Please check if it exists.',
  },
  {
    pattern: /FFprobe error/i,
    message: () => 'Could not read media information. The file may be corrupted.',
  },

  // Timeline Errors
  {
    pattern: /Clip not found/i,
    message: () => 'The clip could not be found on the timeline.',
  },
  {
    pattern: /Track not found/i,
    message: () => 'The track could not be found.',
  },
  {
    pattern: /Sequence not found/i,
    message: () => 'The sequence could not be found.',
  },
  {
    pattern: /Invalid split point/i,
    message: () => 'Cannot split at this position. Move the playhead inside the clip.',
  },
  {
    pattern: /Invalid time range/i,
    message: () => 'The specified time range is invalid.',
  },
  {
    pattern: /Clip conflict/i,
    message: () => 'Another clip already exists at this position.',
  },

  // Command Errors
  {
    pattern: /Nothing to undo/i,
    message: () => 'Nothing to undo.',
  },
  {
    pattern: /Nothing to redo/i,
    message: () => 'Nothing to redo.',
  },
  {
    pattern: /Invalid command/i,
    message: () => 'The operation could not be completed.',
  },
  {
    pattern: /Command execution failed/i,
    message: () => 'The operation failed. Please try again.',
  },

  // Render Errors
  {
    pattern: /Render failed/i,
    message: () => 'Export failed. Please check your settings and try again.',
  },
  {
    pattern: /Proxy generation failed/i,
    message: () => 'Could not generate preview. The file may be corrupted.',
  },
  {
    pattern: /FFmpeg.*not (found|available)/i,
    message: () => 'FFmpeg is not installed. Export and preview features require FFmpeg.',
  },
  {
    pattern: /FFmpeg.*(failed|error)/i,
    message: () => 'Video processing failed. Please check the file format.',
  },

  // AI Errors
  {
    pattern: /AI request failed/i,
    message: () => 'AI processing failed. Please try again.',
  },
  {
    pattern: /Intent cannot be empty/i,
    message: () => 'Please enter a command for the AI.',
  },

  // Network Errors
  {
    pattern: /network|connection|timeout/i,
    message: () => 'Connection error. Please check your network.',
  },

  // Permission Errors
  {
    pattern: /Permission denied/i,
    message: () => 'Access denied. Check file permissions.',
  },
];

// =============================================================================
// Functions
// =============================================================================

/**
 * Convert a technical error message to a user-friendly message.
 *
 * @param error - The error message or Error object
 * @returns User-friendly error message
 */
export function getUserFriendlyError(error: unknown): string {
  const errorStr = error instanceof Error ? error.message : String(error);

  // Try to match against known patterns
  for (const { pattern, message } of ERROR_PATTERNS) {
    const matches = errorStr.match(pattern);
    if (matches) {
      return message(matches);
    }
  }

  // If no pattern matches, return a generic message with the original error
  // For development, we include the original error; in production, you might want to hide it
  if (process.env.NODE_ENV === 'development') {
    return `An error occurred: ${errorStr}`;
  }

  return 'An unexpected error occurred. Please try again.';
}

/**
 * Determine the severity of an error for toast display.
 *
 * @param error - The error message or Error object
 * @returns 'error' | 'warning' depending on severity
 */
export function getErrorSeverity(error: unknown): 'error' | 'warning' {
  const errorStr = error instanceof Error ? error.message : String(error);

  // Warnings (recoverable or expected conditions)
  const warningPatterns = [
    /Nothing to undo/i,
    /Nothing to redo/i,
    /already open/i,
    /already exists/i,
    /in use/i,
  ];

  for (const pattern of warningPatterns) {
    if (pattern.test(errorStr)) {
      return 'warning';
    }
  }

  return 'error';
}

/**
 * Create an error handler that shows toast notifications.
 *
 * @param showError - Function to show error toast
 * @param showWarning - Function to show warning toast
 * @returns Error handler function
 */
export function createErrorHandler(
  showError: (message: string) => void,
  showWarning: (message: string) => void
): (error: unknown) => void {
  return (error: unknown) => {
    const message = getUserFriendlyError(error);
    const severity = getErrorSeverity(error);

    if (severity === 'warning') {
      showWarning(message);
    } else {
      showError(message);
    }

    // Also log for debugging
    logger.error('Handled error', { error });
  };
}

export default {
  getUserFriendlyError,
  getErrorSeverity,
  createErrorHandler,
};
