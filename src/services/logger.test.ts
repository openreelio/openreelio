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
  getLogHistory,
  clearLogHistory,
  exportLogHistory,
  serializeError,
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

      // Error objects are serialized to plain objects for JSON compatibility
      const loggedError = capturedLogs[0].data?.error as Record<string, unknown>;
      expect(loggedError.name).toBe('Error');
      expect(loggedError.message).toBe('Test error');
      expect(loggedError.stack).toBeDefined();
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

      // Error objects are serialized to plain objects for JSON compatibility
      const loggedError = capturedLogs[0].data?.error as Record<string, unknown>;
      expect(loggedError.name).toBe('Error');
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

describe('Log History', () => {
  let logger: Logger;

  beforeEach(() => {
    clearLogHandlers();
    clearLogHistory();
    setGlobalLogLevel(LogLevel.DEBUG);
    logger = createLogger('HistoryTest');
    // Add a handler so logs are processed
    addLogHandler(() => {});
  });

  afterEach(() => {
    clearLogHandlers();
    clearLogHistory();
  });

  it('should store logs in history buffer', () => {
    logger.info('Test message 1');
    logger.warn('Test message 2');

    const history = getLogHistory();
    expect(history).toHaveLength(2);
    expect(history[0].message).toBe('Test message 1');
    expect(history[1].message).toBe('Test message 2');
  });

  it('should filter history by log level', () => {
    logger.debug('Debug');
    logger.info('Info');
    logger.warn('Warn');
    logger.error('Error');

    const warnAndAbove = getLogHistory(LogLevel.WARN);
    expect(warnAndAbove).toHaveLength(2);
    expect(warnAndAbove[0].message).toBe('Warn');
    expect(warnAndAbove[1].message).toBe('Error');
  });

  it('should clear history', () => {
    logger.info('Message 1');
    logger.info('Message 2');

    clearLogHistory();

    expect(getLogHistory()).toHaveLength(0);
  });

  it('should export history as formatted string', () => {
    logger.info('Test message', { key: 'value' });

    const exported = exportLogHistory();
    expect(exported).toContain('[INFO]');
    expect(exported).toContain('[HistoryTest]');
    expect(exported).toContain('Test message');
    expect(exported).toContain('{"key":"value"}');
  });
});

describe('serializeError', () => {
  it('should serialize Error object to plain object', () => {
    const error = new Error('Test error');
    const serialized = serializeError(error);

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('Test error');
    expect(serialized.stack).toBeDefined();
  });

  it('should include custom Error properties', () => {
    class CustomError extends Error {
      code: number;
      constructor(message: string, code: number) {
        super(message);
        this.name = 'CustomError';
        this.code = code;
      }
    }

    const error = new CustomError('Custom error', 42);
    const serialized = serializeError(error);

    expect(serialized.name).toBe('CustomError');
    expect(serialized.message).toBe('Custom error');
    expect(serialized.code).toBe(42);
  });

  it('should handle string errors', () => {
    const serialized = serializeError('String error');
    expect(serialized.message).toBe('String error');
  });

  it('should handle other types', () => {
    const serialized = serializeError({ foo: 'bar' });
    expect(serialized.value).toEqual({ foo: 'bar' });
  });
});

describe('normalizeLogData edge cases', () => {
  let logger: Logger;
  let capturedLogs: LogEntry[];
  const captureHandler: LogHandler = (entry) => {
    capturedLogs.push(entry);
  };

  beforeEach(() => {
    clearLogHandlers();
    clearLogHistory();
    setGlobalLogLevel(LogLevel.DEBUG);
    capturedLogs = [];
    addLogHandler(captureHandler);
    logger = createLogger('NormalizeTest');
  });

  afterEach(() => {
    clearLogHandlers();
    clearLogHistory();
  });

  it('should handle circular references without stack overflow', () => {
    // Create circular reference
    const obj: Record<string, unknown> = { name: 'root' };
    obj.self = obj;

    // Should not throw
    expect(() => logger.info('Circular test', { data: obj })).not.toThrow();

    // Should have logged with circular marker
    expect(capturedLogs).toHaveLength(1);
    const loggedData = capturedLogs[0].data as Record<string, unknown>;
    expect(loggedData.data).toBeDefined();
    const nestedData = loggedData.data as Record<string, unknown>;
    expect(nestedData.name).toBe('root');
    expect(nestedData.self).toEqual({ _circular: true });
  });

  it('should handle deeply nested objects with depth limit', () => {
    // Create deeply nested object (more than MAX_NORMALIZATION_DEPTH)
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 15; i++) {
      nested = { nested };
    }

    // Should not throw
    expect(() => logger.info('Deep nesting test', { data: nested })).not.toThrow();

    // Should have logged with truncation marker at some depth
    expect(capturedLogs).toHaveLength(1);
  });

  it('should handle arrays with Error objects', () => {
    const errors = [new Error('Error 1'), new Error('Error 2')];

    logger.error('Multiple errors', { errors });

    expect(capturedLogs).toHaveLength(1);
    const loggedData = capturedLogs[0].data as Record<string, unknown>;
    const loggedErrors = loggedData.errors as Array<Record<string, unknown>>;
    expect(loggedErrors).toHaveLength(2);
    expect(loggedErrors[0].name).toBe('Error');
    expect(loggedErrors[0].message).toBe('Error 1');
    expect(loggedErrors[1].message).toBe('Error 2');
  });

  it('should handle arrays with nested objects', () => {
    const items = [
      { id: 1, error: new Error('Item 1 error') },
      { id: 2, error: new Error('Item 2 error') },
    ];

    logger.info('Items with errors', { items });

    expect(capturedLogs).toHaveLength(1);
    const loggedData = capturedLogs[0].data as Record<string, unknown>;
    const loggedItems = loggedData.items as Array<Record<string, unknown>>;
    expect(loggedItems).toHaveLength(2);
    expect((loggedItems[0].error as Record<string, unknown>).message).toBe('Item 1 error');
  });
});
