/**
 * Workspace Gateway Tests
 *
 * Tests for path validation security, IPC wrapper functions, and response parsing.
 * Mock: @tauri-apps/api/core (already mocked in global setup).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  validateRelativePath,
  readWorkspaceDocumentFromBackend,
  writeWorkspaceDocumentToBackend,
  deleteFileInBackend,
  renameFileInBackend,
  moveFileInBackend,
  listWorkspaceDocumentsFromBackend,
  createFolderInBackend,
} from './workspaceGateway';

const mockInvoke = vi.mocked(invoke);

// =============================================================================
// validateRelativePath
// =============================================================================

describe('validateRelativePath', () => {
  // ---------------------------------------------------------------------------
  // Rejection cases
  // ---------------------------------------------------------------------------

  describe('rejection', () => {
    it('should reject empty string', () => {
      expect(() => validateRelativePath('')).toThrow('non-empty string');
    });

    it('should reject null bytes', () => {
      expect(() => validateRelativePath('docs/file\0.md')).toThrow('null bytes');
    });

    it('should reject null byte at start', () => {
      expect(() => validateRelativePath('\0docs/file.md')).toThrow('null bytes');
    });

    it('should reject null byte at end', () => {
      expect(() => validateRelativePath('docs/file.md\0')).toThrow('null bytes');
    });

    it('should reject absolute Unix paths', () => {
      expect(() => validateRelativePath('/etc/passwd')).toThrow('relative, not absolute');
    });

    it('should reject absolute path with only slash', () => {
      expect(() => validateRelativePath('/')).toThrow('relative, not absolute');
    });

    it('should reject Windows absolute paths with C:', () => {
      expect(() => validateRelativePath('C:\\Users\\admin')).toThrow('relative, not absolute');
    });

    it('should reject Windows absolute paths with D:', () => {
      expect(() => validateRelativePath('D:\\data\\file.txt')).toThrow('relative, not absolute');
    });

    it('should reject Windows absolute path with forward slashes', () => {
      expect(() => validateRelativePath('C:/Users/admin')).toThrow('relative, not absolute');
    });

    it('should reject lowercase drive letters', () => {
      expect(() => validateRelativePath('c:\\temp')).toThrow('relative, not absolute');
    });

    it('should reject directory traversal with ../', () => {
      expect(() => validateRelativePath('../secret.txt')).toThrow('directory traversal');
    });

    it('should reject directory traversal in middle of path', () => {
      expect(() => validateRelativePath('docs/../../../etc/passwd')).toThrow(
        'directory traversal',
      );
    });

    it('should reject directory traversal at end', () => {
      expect(() => validateRelativePath('docs/sub/..')).toThrow('directory traversal');
    });

    it('should reject backslash traversal', () => {
      expect(() => validateRelativePath('docs\\..\\secret.txt')).toThrow('directory traversal');
    });

    it('should reject standalone .. segment', () => {
      expect(() => validateRelativePath('..')).toThrow('directory traversal');
    });

    it('should reject deeper traversal chains', () => {
      expect(() => validateRelativePath('a/b/../../..')).toThrow('directory traversal');
    });
  });

  // ---------------------------------------------------------------------------
  // Acceptance cases
  // ---------------------------------------------------------------------------

  describe('acceptance', () => {
    it('should accept simple relative path', () => {
      expect(() => validateRelativePath('docs/README.md')).not.toThrow();
    });

    it('should accept source file paths', () => {
      expect(() => validateRelativePath('src/index.ts')).not.toThrow();
    });

    it('should accept deeply nested paths', () => {
      expect(() => validateRelativePath('a/b/c/d/e/f.txt')).not.toThrow();
    });

    it('should accept filenames with dots (not traversal)', () => {
      expect(() => validateRelativePath('file.test.ts')).not.toThrow();
    });

    it('should accept dotfiles like .gitignore', () => {
      expect(() => validateRelativePath('.gitignore')).not.toThrow();
    });

    it('should accept dotfiles in subdirectories', () => {
      expect(() => validateRelativePath('config/.env.example')).not.toThrow();
    });

    it('should accept hidden directories', () => {
      expect(() => validateRelativePath('.github/workflows/ci.yml')).not.toThrow();
    });

    it('should accept single segment path', () => {
      expect(() => validateRelativePath('file.md')).not.toThrow();
    });

    it('should accept path with single dot directory', () => {
      // "." as a segment is fine; only ".." is traversal
      expect(() => validateRelativePath('./docs/file.md')).not.toThrow();
    });

    it('should accept names that contain double dots but are not traversal', () => {
      // "...foo" is a valid filename, not directory traversal
      expect(() => validateRelativePath('...readme')).not.toThrow();
    });

    it('should accept paths with dashes and underscores', () => {
      expect(() => validateRelativePath('my-project_files/data_2024.csv')).not.toThrow();
    });

    it('should accept paths with spaces', () => {
      expect(() => validateRelativePath('my docs/some file.md')).not.toThrow();
    });
  });
});

// =============================================================================
// IPC Wrapper Functions
// =============================================================================

describe('IPC wrapper functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // readWorkspaceDocumentFromBackend
  // ---------------------------------------------------------------------------

  describe('readWorkspaceDocumentFromBackend', () => {
    it('should validate path before calling invoke', async () => {
      await expect(readWorkspaceDocumentFromBackend('../secret.txt')).rejects.toThrow(
        'directory traversal',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject absolute paths before calling invoke', async () => {
      await expect(readWorkspaceDocumentFromBackend('/etc/passwd')).rejects.toThrow(
        'relative, not absolute',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject empty path before calling invoke', async () => {
      await expect(readWorkspaceDocumentFromBackend('')).rejects.toThrow('non-empty string');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call invoke with correct command and parse response', async () => {
      const mockResponse = {
        relativePath: 'docs/file.md',
        content: 'Hello',
        sizeBytes: 5,
        modifiedAtUnixSec: 1700000000,
      };
      mockInvoke.mockResolvedValueOnce(mockResponse);

      const result = await readWorkspaceDocumentFromBackend('docs/file.md');

      expect(mockInvoke).toHaveBeenCalledWith('read_workspace_document', {
        relativePath: 'docs/file.md',
      });
      expect(result).toEqual(mockResponse);
    });

    it('should reject malformed response payload', async () => {
      mockInvoke.mockResolvedValueOnce({ relativePath: 'file.md' }); // missing content, sizeBytes, modifiedAtUnixSec

      await expect(readWorkspaceDocumentFromBackend('file.md')).rejects.toThrow(
        'Invalid workspace document fields',
      );
    });

    it('should reject null response payload', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      await expect(readWorkspaceDocumentFromBackend('file.md')).rejects.toThrow(
        'Invalid workspace document payload',
      );
    });

    it('should reject response with non-finite sizeBytes', async () => {
      mockInvoke.mockResolvedValueOnce({
        relativePath: 'file.md',
        content: 'data',
        sizeBytes: NaN,
        modifiedAtUnixSec: 1700000000,
      });

      await expect(readWorkspaceDocumentFromBackend('file.md')).rejects.toThrow(
        'Invalid workspace document fields',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // writeWorkspaceDocumentToBackend
  // ---------------------------------------------------------------------------

  describe('writeWorkspaceDocumentToBackend', () => {
    it('should validate path before calling invoke', async () => {
      await expect(
        writeWorkspaceDocumentToBackend('../../escape.txt', 'content', true),
      ).rejects.toThrow('directory traversal');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject Windows absolute paths before calling invoke', async () => {
      await expect(
        writeWorkspaceDocumentToBackend('C:\\Windows\\system32\\file.txt', 'content', true),
      ).rejects.toThrow('relative, not absolute');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call invoke with correct arguments', async () => {
      const mockResponse = {
        relativePath: 'notes.md',
        bytesWritten: 13,
        created: true,
      };
      mockInvoke.mockResolvedValueOnce(mockResponse);

      const result = await writeWorkspaceDocumentToBackend('notes.md', 'Hello, World!', true);

      expect(mockInvoke).toHaveBeenCalledWith('write_workspace_document', {
        relativePath: 'notes.md',
        content: 'Hello, World!',
        createIfMissing: true,
      });
      expect(result).toEqual(mockResponse);
    });

    it('should default createIfMissing to true', async () => {
      mockInvoke.mockResolvedValueOnce({
        relativePath: 'file.md',
        bytesWritten: 4,
        created: true,
      });

      await writeWorkspaceDocumentToBackend('file.md', 'test');

      expect(mockInvoke).toHaveBeenCalledWith('write_workspace_document', {
        relativePath: 'file.md',
        content: 'test',
        createIfMissing: true,
      });
    });

    it('should reject malformed write response', async () => {
      mockInvoke.mockResolvedValueOnce({
        relativePath: 'file.md',
        bytesWritten: 'not a number',
        created: true,
      });

      await expect(writeWorkspaceDocumentToBackend('file.md', 'data', true)).rejects.toThrow(
        'Invalid workspace document write fields',
      );
    });

    it('should reject write response with missing created field', async () => {
      mockInvoke.mockResolvedValueOnce({
        relativePath: 'file.md',
        bytesWritten: 10,
      });

      await expect(writeWorkspaceDocumentToBackend('file.md', 'data', true)).rejects.toThrow(
        'Invalid workspace document write fields',
      );
    });

    it('should reject write response with Infinity bytesWritten', async () => {
      mockInvoke.mockResolvedValueOnce({
        relativePath: 'file.md',
        bytesWritten: Infinity,
        created: false,
      });

      await expect(writeWorkspaceDocumentToBackend('file.md', 'data', true)).rejects.toThrow(
        'Invalid workspace document write fields',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // deleteFileInBackend
  // ---------------------------------------------------------------------------

  describe('deleteFileInBackend', () => {
    it('should validate path before calling invoke', async () => {
      await expect(deleteFileInBackend('../../../etc/hosts')).rejects.toThrow(
        'directory traversal',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject empty path', async () => {
      await expect(deleteFileInBackend('')).rejects.toThrow('non-empty string');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call invoke with execute_command for valid paths', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await deleteFileInBackend('temp/old-file.md');

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'DeleteFile',
        payload: { relativePath: 'temp/old-file.md' },
      });
    });

    it('should propagate backend errors', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('File not found'));

      await expect(deleteFileInBackend('missing.md')).rejects.toThrow('File not found');
    });
  });

  // ---------------------------------------------------------------------------
  // renameFileInBackend
  // ---------------------------------------------------------------------------

  describe('renameFileInBackend', () => {
    it('should reject newName with forward slash', async () => {
      await expect(renameFileInBackend('file.md', 'sub/name.md')).rejects.toThrow(
        'path separators',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject newName with backslash', async () => {
      await expect(renameFileInBackend('file.md', 'sub\\name.md')).rejects.toThrow(
        'path separators',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject newName with null byte', async () => {
      await expect(renameFileInBackend('file.md', 'name\0.md')).rejects.toThrow(
        'path separators or null bytes',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should validate old path for traversal before calling invoke', async () => {
      await expect(renameFileInBackend('../escape.md', 'safe.md')).rejects.toThrow(
        'directory traversal',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call invoke with correct arguments for valid inputs', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await renameFileInBackend('docs/old.md', 'new.md');

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RenameFile',
        payload: { oldRelativePath: 'docs/old.md', newName: 'new.md' },
      });
    });

    it('should accept newName with dots that are not path separators', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await renameFileInBackend('file.md', 'my.new.file.md');

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RenameFile',
        payload: { oldRelativePath: 'file.md', newName: 'my.new.file.md' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // moveFileInBackend
  // ---------------------------------------------------------------------------

  describe('moveFileInBackend', () => {
    it('should validate source path for traversal', async () => {
      await expect(moveFileInBackend('../escape.md', 'dest')).rejects.toThrow(
        'directory traversal',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should validate destination path for traversal', async () => {
      await expect(moveFileInBackend('file.md', '../../escape')).rejects.toThrow(
        'directory traversal',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should validate source path for absolute paths', async () => {
      await expect(moveFileInBackend('/etc/file.md', 'dest')).rejects.toThrow(
        'relative, not absolute',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should validate destination path for absolute paths', async () => {
      await expect(moveFileInBackend('file.md', 'C:\\Windows')).rejects.toThrow(
        'relative, not absolute',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call invoke with correct arguments for valid paths', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await moveFileInBackend('docs/file.md', 'archive/2024');

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'MoveFile',
        payload: { sourcePath: 'docs/file.md', destFolderPath: 'archive/2024' },
      });
    });

    it('should reject when both paths are invalid', async () => {
      // First validation (source) should throw before reaching second
      await expect(moveFileInBackend('../escape', '../also-escape')).rejects.toThrow(
        'directory traversal',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // listWorkspaceDocumentsFromBackend
  // ---------------------------------------------------------------------------

  describe('listWorkspaceDocumentsFromBackend', () => {
    it('should call invoke with list_workspace_documents', async () => {
      const mockFiles = [
        { relativePath: 'README.md', sizeBytes: 100, modifiedAtUnixSec: 1700000000 },
      ];
      mockInvoke.mockResolvedValueOnce(mockFiles);

      const result = await listWorkspaceDocumentsFromBackend();

      expect(mockInvoke).toHaveBeenCalledWith('list_workspace_documents', {
        query: undefined,
        limit: undefined,
      });
      expect(result).toEqual(mockFiles);
    });

    it('should pass query and limit to invoke', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      await listWorkspaceDocumentsFromBackend('readme', 5);

      expect(mockInvoke).toHaveBeenCalledWith('list_workspace_documents', {
        query: 'readme',
        limit: 5,
      });
    });

    it('should reject non-array response', async () => {
      mockInvoke.mockResolvedValueOnce({ files: [] }); // Object instead of array

      await expect(listWorkspaceDocumentsFromBackend()).rejects.toThrow(
        'Invalid workspace document list payload',
      );
    });

    it('should reject array with malformed entries', async () => {
      mockInvoke.mockResolvedValueOnce([
        { relativePath: 'file.md' }, // missing sizeBytes and modifiedAtUnixSec
      ]);

      await expect(listWorkspaceDocumentsFromBackend()).rejects.toThrow(
        'Invalid workspace document entry fields',
      );
    });

    it('should reject entry with non-string relativePath', async () => {
      mockInvoke.mockResolvedValueOnce([
        { relativePath: 123, sizeBytes: 100, modifiedAtUnixSec: 1700000000 },
      ]);

      await expect(listWorkspaceDocumentsFromBackend()).rejects.toThrow(
        'Invalid workspace document entry fields',
      );
    });

    it('should reject entry that is not a record', async () => {
      mockInvoke.mockResolvedValueOnce([42]);

      await expect(listWorkspaceDocumentsFromBackend()).rejects.toThrow(
        'Invalid workspace document entry payload',
      );
    });

    it('should reject entry with NaN sizeBytes', async () => {
      mockInvoke.mockResolvedValueOnce([
        { relativePath: 'file.md', sizeBytes: NaN, modifiedAtUnixSec: 1700000000 },
      ]);

      await expect(listWorkspaceDocumentsFromBackend()).rejects.toThrow(
        'Invalid workspace document entry fields',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // createFolderInBackend
  // ---------------------------------------------------------------------------

  describe('createFolderInBackend', () => {
    it('should validate path before calling invoke', async () => {
      await expect(createFolderInBackend('../escape')).rejects.toThrow('directory traversal');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call invoke with CreateFolder command', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await createFolderInBackend('new-folder/sub');

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'CreateFolder',
        payload: { relativePath: 'new-folder/sub' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Response parsing edge cases
  // ---------------------------------------------------------------------------

  describe('response parsing', () => {
    it('should reject null as workspace document', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      await expect(readWorkspaceDocumentFromBackend('file.md')).rejects.toThrow(
        'Invalid workspace document payload',
      );
    });

    it('should reject array as workspace document', async () => {
      // Arrays pass isRecord() (typeof [] === 'object' && [] !== null) but fail field checks
      mockInvoke.mockResolvedValueOnce([]);

      await expect(readWorkspaceDocumentFromBackend('file.md')).rejects.toThrow(
        'Invalid workspace document fields',
      );
    });

    it('should reject primitive as workspace document', async () => {
      mockInvoke.mockResolvedValueOnce('string response');

      await expect(readWorkspaceDocumentFromBackend('file.md')).rejects.toThrow(
        'Invalid workspace document payload',
      );
    });

    it('should reject write result with non-boolean created', async () => {
      mockInvoke.mockResolvedValueOnce({
        relativePath: 'file.md',
        bytesWritten: 10,
        created: 'yes', // should be boolean
      });

      await expect(writeWorkspaceDocumentToBackend('file.md', 'data', true)).rejects.toThrow(
        'Invalid workspace document write fields',
      );
    });

    it('should reject write result that is null', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      await expect(writeWorkspaceDocumentToBackend('file.md', 'data')).rejects.toThrow(
        'Invalid workspace document write payload',
      );
    });

    it('should accept valid document with zero sizeBytes', async () => {
      const response = {
        relativePath: 'empty.md',
        content: '',
        sizeBytes: 0,
        modifiedAtUnixSec: 0,
      };
      mockInvoke.mockResolvedValueOnce(response);

      const result = await readWorkspaceDocumentFromBackend('empty.md');
      expect(result).toEqual(response);
    });

    it('should accept valid write result with zero bytesWritten', async () => {
      const response = {
        relativePath: 'empty.md',
        bytesWritten: 0,
        created: false,
      };
      mockInvoke.mockResolvedValueOnce(response);

      const result = await writeWorkspaceDocumentToBackend('empty.md', '');
      expect(result).toEqual(response);
    });
  });

  // ---------------------------------------------------------------------------
  // Error re-wrapping
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should re-throw Error instances from invoke', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(deleteFileInBackend('file.md')).rejects.toThrow('Connection refused');
    });

    it('should wrap non-Error rejections into Error instances', async () => {
      mockInvoke.mockRejectedValueOnce('raw string error');

      const promise = deleteFileInBackend('file.md');
      await expect(promise).rejects.toThrow('raw string error');

      // Verify the thrown value is an Error instance (not a raw string)
      mockInvoke.mockRejectedValueOnce('another string error');
      try {
        await deleteFileInBackend('file.md');
        expect.fail('Expected deleteFileInBackend to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('another string error');
      }
    });
  });
});
