/**
 * Centralized Logging Service
 *
 * Provides a unified logging interface that replaces console.log/warn/error
 * throughout the application. Supports:
 * - Log levels (DEBUG, INFO, WARN, ERROR, SILENT)
 * - Module-specific loggers
 * - Custom log handlers for extensibility
 * - Performance timing utilities
 *
 * @example
 * ```typescript
 * import { createLogger } from '@/services/logger';
 *
 * const logger = createLogger('Timeline');
 * logger.info('Clip added', { clipId: '123' });
 * logger.error('Failed to split clip', { error });
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/** Log severity levels */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/** Structure of a log entry */
export interface LogEntry {
  /** Timestamp when the log was created */
  timestamp: number;
  /** Log severity level */
  level: LogLevel;
  /** Module or component that created the log */
  module: string;
  /** Log message */
  message: string;
  /** Additional structured data */
  data?: Record<string, unknown>;
}

/** Handler function for processing log entries */
export type LogHandler = (entry: LogEntry) => void;

/** Logger interface */
export interface Logger {
  /** Module name for this logger */
  readonly module: string;
  /** Log debug message (lowest priority) */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Log info message */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log warning message */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log error message (highest priority) */
  error(message: string, data?: Record<string, unknown>): void;
  /** Start a performance timer */
  time(label: string): void;
  /** End a performance timer and log the duration */
  timeEnd(label: string): void;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of log entries to keep in history buffer */
const MAX_LOG_HISTORY = 100;

// =============================================================================
// Module State
// =============================================================================

/** Current global log level */
let globalLogLevel: LogLevel = LogLevel.INFO;

/** Registered log handlers */
const handlers: Set<LogHandler> = new Set();

/** Active performance timers */
const timers: Map<string, Map<string, number>> = new Map();

/** Circular buffer of recent log entries for error reporting */
const logHistory: LogEntry[] = [];

// =============================================================================
// Handler Management
// =============================================================================

/**
 * Add a log handler that will receive all log entries.
 *
 * @param handler - Function to call for each log entry
 */
export function addLogHandler(handler: LogHandler): void {
  handlers.add(handler);
}

/**
 * Remove a previously added log handler.
 *
 * @param handler - Handler to remove
 */
export function removeLogHandler(handler: LogHandler): void {
  handlers.delete(handler);
}

/**
 * Remove all log handlers.
 */
export function clearLogHandlers(): void {
  handlers.clear();
}

// =============================================================================
// Log Level Management
// =============================================================================

/**
 * Set the global log level.
 * Messages below this level will be ignored.
 *
 * @param level - Minimum log level to process
 */
export function setGlobalLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * Get the current global log level.
 *
 * @returns Current log level
 */
export function getGlobalLogLevel(): LogLevel {
  return globalLogLevel;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Serialize an Error object into a plain object for logging.
 * Error objects don't serialize well to JSON by default.
 *
 * @param error - Error to serialize
 * @returns Plain object with error properties
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const baseInfo: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    // Include any custom properties
    Object.getOwnPropertyNames(error).forEach((key) => {
      if (!['name', 'message', 'stack'].includes(key)) {
        baseInfo[key] = (error as unknown as Record<string, unknown>)[key];
      }
    });
    return baseInfo;
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  return { value: error };
}

/** Maximum depth for recursive normalization to prevent stack overflow */
const MAX_NORMALIZATION_DEPTH = 10;

/**
 * Normalize log data, serializing any Error objects.
 * Handles circular references by tracking visited objects.
 *
 * @param data - Data to normalize
 * @param seen - WeakSet to track visited objects (for circular reference detection)
 * @param depth - Current recursion depth
 * @returns Normalized data with serialized errors
 */
function normalizeLogData(
  data?: Record<string, unknown>,
  seen: WeakSet<object> = new WeakSet(),
  depth: number = 0
): Record<string, unknown> | undefined {
  if (!data) return undefined;

  // Prevent infinite recursion
  if (depth > MAX_NORMALIZATION_DEPTH) {
    return { _truncated: true, _reason: 'Max depth exceeded' };
  }

  // Detect circular reference
  if (seen.has(data)) {
    return { _circular: true };
  }

  seen.add(data);

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Error) {
      normalized[key] = serializeError(value);
    } else if (Array.isArray(value)) {
      // Handle arrays separately
      normalized[key] = value.map((item) => {
        if (item instanceof Error) {
          return serializeError(item);
        } else if (typeof item === 'object' && item !== null) {
          return normalizeLogData(item as Record<string, unknown>, seen, depth + 1);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      // Recursively check nested objects for Error instances
      normalized[key] = normalizeLogData(value as Record<string, unknown>, seen, depth + 1);
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

// =============================================================================
// Internal Logging
// =============================================================================

/**
 * Process a log entry through all handlers.
 */
function processLog(entry: LogEntry): void {
  // Check if this log level should be processed
  if (entry.level < globalLogLevel) {
    return;
  }

  // Add to history buffer (circular, keeps last MAX_LOG_HISTORY entries)
  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }

  // Call all handlers, catching errors to prevent one handler from breaking others
  handlers.forEach((handler) => {
    try {
      handler(entry);
    } catch {
      // Silently ignore handler errors to prevent infinite loops
      // We can't log handler errors because that could cause more errors
    }
  });
}

/**
 * Create a log entry and process it.
 */
function log(
  module: string,
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    module,
    message,
    data: normalizeLogData(data),
  };

  processLog(entry);
}

// =============================================================================
// Log History Access
// =============================================================================

/**
 * Get a copy of the recent log history.
 * Useful for error reporting and debugging.
 *
 * @param level - Optional minimum level to filter by
 * @returns Array of recent log entries
 */
export function getLogHistory(level?: LogLevel): readonly LogEntry[] {
  if (level === undefined) {
    return [...logHistory];
  }
  return logHistory.filter((entry) => entry.level >= level);
}

/**
 * Clear the log history buffer.
 */
export function clearLogHistory(): void {
  logHistory.length = 0;
}

/**
 * Export log history as a formatted string for error reports.
 *
 * @param level - Optional minimum level to filter by
 * @returns Formatted log history string
 */
export function exportLogHistory(level?: LogLevel): string {
  const entries = getLogHistory(level);
  const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];

  return entries
    .map((entry) => {
      const timestamp = new Date(entry.timestamp).toISOString();
      const levelName = levelNames[entry.level] ?? 'UNKNOWN';
      const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
      return `[${timestamp}] [${levelName}] [${entry.module}] ${entry.message}${dataStr}`;
    })
    .join('\n');
}

// =============================================================================
// Logger Factory
// =============================================================================

/**
 * Create a logger instance for a specific module.
 *
 * @param moduleName - Name of the module (for log identification)
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger('Timeline');
 * logger.info('Timeline initialized');
 * ```
 */
export function createLogger(moduleName: string = 'App'): Logger {
  // Get or create timer map for this module
  if (!timers.has(moduleName)) {
    timers.set(moduleName, new Map());
  }
  const moduleTimers = timers.get(moduleName)!;

  return {
    get module(): string {
      return moduleName;
    },

    debug(message: string, data?: Record<string, unknown>): void {
      log(moduleName, LogLevel.DEBUG, message, data);
    },

    info(message: string, data?: Record<string, unknown>): void {
      log(moduleName, LogLevel.INFO, message, data);
    },

    warn(message: string, data?: Record<string, unknown>): void {
      log(moduleName, LogLevel.WARN, message, data);
    },

    error(message: string, data?: Record<string, unknown>): void {
      log(moduleName, LogLevel.ERROR, message, data);
    },

    time(label: string): void {
      moduleTimers.set(label, performance.now());
    },

    timeEnd(label: string): void {
      const startTime = moduleTimers.get(label);

      if (startTime === undefined) {
        log(moduleName, LogLevel.WARN, `Timer '${label}' does not exist`, {
          availableTimers: Array.from(moduleTimers.keys()),
        });
        return;
      }

      const duration = performance.now() - startTime;
      moduleTimers.delete(label);

      log(moduleName, LogLevel.INFO, `${label}: ${duration.toFixed(2)}ms`, {
        duration,
        label,
      });
    },
  };
}

// =============================================================================
// Default Console Handler
// =============================================================================

/**
 * Default handler that logs to console.
 * Formats output based on log level.
 */
export const consoleHandler: LogHandler = (entry: LogEntry): void => {
  const timestamp = new Date(entry.timestamp).toISOString();
  const formattedMessage = `[${timestamp}] [${entry.module}] ${entry.message}`;

  switch (entry.level) {
    case LogLevel.DEBUG:
      console.debug(formattedMessage, entry.data ?? '');
      break;
    case LogLevel.INFO:
      console.info(formattedMessage, entry.data ?? '');
      break;
    case LogLevel.WARN:
      console.warn(formattedMessage, entry.data ?? '');
      break;
    case LogLevel.ERROR:
      console.error(formattedMessage, entry.data ?? '');
      break;
    default:
      break;
  }
};

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the logger with default settings.
 * Should be called once at application startup.
 */
export function initializeLogger(): void {
  // Set log level based on environment
  if (import.meta.env?.DEV) {
    setGlobalLogLevel(LogLevel.DEBUG);
  } else {
    setGlobalLogLevel(LogLevel.WARN);
  }

  // Add console handler by default
  addLogHandler(consoleHandler);
}

// =============================================================================
// Exports
// =============================================================================

export default {
  createLogger,
  addLogHandler,
  removeLogHandler,
  clearLogHandlers,
  setGlobalLogLevel,
  getGlobalLogLevel,
  getLogHistory,
  clearLogHistory,
  exportLogHistory,
  serializeError,
  consoleHandler,
  initializeLogger,
  LogLevel,
};
