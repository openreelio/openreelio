/**
 * Logger Service Tests
 *
 * TDD: RED phase - Tests written before implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Logger,
  LogLevel,
  createLogger,
  setGlobalLogLevel,
  getGlobalLogLevel,
  addLogHandler,
  removeLogHandler,
  clearLogHandlers,
  type LogEntry,
  type LogHandler,
} from './logger';

describe('Logger', () => {
  let logger: Logger;
  let mockHandler: LogHandler;
  let capturedLogs: LogEntry[];

  beforeEach(() => {
    capturedLogs = [];
    mockHandler = vi.fn((entry: LogEntry) => {
      capturedLogs.push(entry);
    });
    clearLogHandlers();
    setGlobalLogLevel(LogLevel.DEBUG);
    logger = createLogger('TestModule');
  });

  afterEach(() => {
    clearLogHandlers();
    vi.clearAllMocks();
  });

  describe('createLogger', () => {
    it('should create a logger with the specified module name', () => {
      const testLogger = createLogger('MyModule');
      expect(testLogger).toBeDefined();
      expect(testLogger.module).toBe('MyModule');
    });

    it('should create logger with default module name if not provided', () => {
      const testLogger = createLogger();
      expect(testLogger.module).toBe('App');
    });
  });

  describe('log levels', () => {
    beforeEach(() => {
      addLogHandler(mockHandler);
    });

    it('should log debug messages when level is DEBUG', () => {
      setGlobalLogLevel(LogLevel.DEBUG);
      logger.debug('Debug message');

      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(capturedLogs[0].level).toBe(LogLevel.DEBUG);
      expect(capturedLogs[0].message).toBe('Debug message');
    });

    it('should log info messages', () => {
      logger.info('Info message');

      expect(mockHandler).toHaveBeenCalled();
      expect(capturedLogs[0].level).toBe(LogLevel.INFO);
    });

    it('should log warn messages', () => {
      logger.warn('Warning message');

      expect(mockHandler).toHaveBeenCalled();
      expect(capturedLogs[0].level).toBe(LogLevel.WARN);
    });

    it('should log error messages', () => {
      logger.error('Error message');

      expect(mockHandler).toHaveBeenCalled();
      expect(capturedLogs[0].level).toBe(LogLevel.ERROR);
    });

    it('should not log debug messages when level is INFO', () => {
      setGlobalLogLevel(LogLevel.INFO);
      logger.debug('Debug message');

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should not log info messages when level is WARN', () => {
      setGlobalLogLevel(LogLevel.WARN);
      logger.info('Info message');

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should not log warn messages when level is ERROR', () => {
      setGlobalLogLevel(LogLevel.ERROR);
      logger.warn('Warning message');

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should not log any messages when level is SILENT', () => {
      setGlobalLogLevel(LogLevel.SILENT);
      logger.debug('Debug');
      logger.info('Info');
      logger.warn('Warn');
      logger.error('Error');

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe('log entry structure', () => {
    beforeEach(() => {
      addLogHandler(mockHandler);
    });

    it('should include timestamp in log entry', () => {
      const before = Date.now();
      logger.info('Test message');
      const after = Date.now();

      expect(capturedLogs[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(capturedLogs[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('should include module name in log entry', () => {
      logger.info('Test message');

      expect(capturedLogs[0].module).toBe('TestModule');
    });

    it('should include additional data in log entry', () => {
      const data = { userId: 123, action: 'click' };
      logger.info('User action', data);

      expect(capturedLogs[0].data).toEqual(data);
    });

    it('should include error object in log entry', () => {
      const error = new Error('Test error');
      logger.error('Something went wrong', { error });

      expect(capturedLogs[0].data?.error).toBe(error);
    });
  });

  describe('log handlers', () => {
    it('should call all registered handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      addLogHandler(handler1);
      addLogHandler(handler2);
      logger.info('Test');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should remove handler when requested', () => {
      addLogHandler(mockHandler);
      logger.info('Before removal');

      removeLogHandler(mockHandler);
      logger.info('After removal');

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it('should clear all handlers', () => {
      addLogHandler(mockHandler);
      addLogHandler(vi.fn());

      clearLogHandlers();
      logger.info('After clear');

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should handle errors in handlers gracefully', () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();

      addLogHandler(errorHandler);
      addLogHandler(normalHandler);

      // Should not throw
      expect(() => logger.info('Test')).not.toThrow();

      // Normal handler should still be called
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  describe('global log level', () => {
    it('should get and set global log level', () => {
      setGlobalLogLevel(LogLevel.WARN);
      expect(getGlobalLogLevel()).toBe(LogLevel.WARN);

      setGlobalLogLevel(LogLevel.DEBUG);
      expect(getGlobalLogLevel()).toBe(LogLevel.DEBUG);
    });

    it('should affect all loggers', () => {
      const logger1 = createLogger('Module1');
      const logger2 = createLogger('Module2');

      addLogHandler(mockHandler);
      setGlobalLogLevel(LogLevel.ERROR);

      logger1.warn('Warning from 1');
      logger2.warn('Warning from 2');

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe('convenience methods', () => {
    beforeEach(() => {
      addLogHandler(mockHandler);
    });

    it('should support formatted messages with debug', () => {
      logger.debug('Processing item', { itemId: 'abc123', status: 'pending' });

      expect(capturedLogs[0].message).toBe('Processing item');
      expect(capturedLogs[0].data).toEqual({ itemId: 'abc123', status: 'pending' });
    });

    it('should log performance timing', () => {
      logger.time('operation');
      // Simulate some work
      logger.timeEnd('operation');

      expect(capturedLogs[0].message).toContain('operation');
      expect(capturedLogs[0].data?.duration).toBeDefined();
      expect(typeof capturedLogs[0].data?.duration).toBe('number');
    });

    it('should handle multiple timers', () => {
      logger.time('timer1');
      logger.time('timer2');
      logger.timeEnd('timer1');
      logger.timeEnd('timer2');

      expect(capturedLogs).toHaveLength(2);
    });

    it('should warn on ending non-existent timer', () => {
      logger.timeEnd('nonExistent');

      expect(capturedLogs[0].level).toBe(LogLevel.WARN);
      expect(capturedLogs[0].message).toContain('nonExistent');
    });
  });

  describe('error logging utilities', () => {
    beforeEach(() => {
      addLogHandler(mockHandler);
    });

    it('should extract error details from Error objects', () => {
      const error = new Error('Test error');
      logger.error('Operation failed', { error });

      expect(capturedLogs[0].data?.error).toBe(error);
      const loggedError = capturedLogs[0].data?.error as Error;
      expect(loggedError.message).toBe('Test error');
      expect(loggedError.stack).toBeDefined();
    });

    it('should handle non-Error objects as errors', () => {
      logger.error('Operation failed', { error: 'string error' });

      expect(capturedLogs[0].data?.error).toBe('string error');
    });

    it('should handle undefined data gracefully', () => {
      logger.error('Operation failed');

      expect(capturedLogs[0].data).toBeUndefined();
    });
  });

  describe('production behavior', () => {
    it('should respect log level in production mode', () => {
      // In production, typically only WARN and above should be logged
      setGlobalLogLevel(LogLevel.WARN);
      addLogHandler(mockHandler);

      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warn message');
      logger.error('Error message');

      expect(capturedLogs).toHaveLength(2);
      expect(capturedLogs[0].level).toBe(LogLevel.WARN);
      expect(capturedLogs[1].level).toBe(LogLevel.ERROR);
    });
  });
});

describe('LogLevel enum', () => {
  it('should have correct numeric values for comparison', () => {
    expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
    expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
    expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
    expect(LogLevel.ERROR).toBeLessThan(LogLevel.SILENT);
  });
});
