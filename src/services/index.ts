/**
 * Services Index
 *
 * Centralized exports for application services.
 */

export {
  createLogger,
  addLogHandler,
  removeLogHandler,
  clearLogHandlers,
  setGlobalLogLevel,
  getGlobalLogLevel,
  consoleHandler,
  initializeLogger,
  LogLevel,
  type Logger,
  type LogEntry,
  type LogHandler,
} from './logger';
