/**
 * Workspace Tools Tests
 *
 * BDD tests for workspace document editing tools.
 * Mocks: @tauri-apps/api/core (global setup), @/services/workspaceGateway (IPC boundary).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { globalToolRegistry, type ToolExecutionResult } from '../ToolRegistry';

// ---------------------------------------------------------------------------
// Mock the thin IPC boundary wrappers
// ---------------------------------------------------------------------------

vi.mock('@/services/workspaceGateway', () => ({
  listWorkspaceDocumentsFromBackend: vi.fn(),
  readWorkspaceDocumentFromBackend: vi.fn(),
  writeWorkspaceDocumentToBackend: vi.fn(),
}));

vi.mock('./commandExecutor', () => ({
  executeAgentCommand: vi.fn(),
}));

import {
  listWorkspaceDocumentsFromBackend,
  readWorkspaceDocumentFromBackend,
  writeWorkspaceDocumentToBackend,
} from '@/services/workspaceGateway';
import { executeAgentCommand } from './commandExecutor';
import {
  registerWorkspaceTools,
  unregisterWorkspaceTools,
  getWorkspaceToolNames,
} from './workspaceTools';

const mockListDocs = vi.mocked(listWorkspaceDocumentsFromBackend);
const mockReadDoc = vi.mocked(readWorkspaceDocumentFromBackend);
const mockWriteDoc = vi.mocked(writeWorkspaceDocumentToBackend);
const mockExecCmd = vi.mocked(executeAgentCommand);

// =============================================================================
// Test Helpers
// =============================================================================

function expectSuccess<T>(
  result: ToolExecutionResult,
): asserts result is ToolExecutionResult & { success: true; result: T } {
  expect(result.success).toBe(true);
  expect(result.error).toBeUndefined();
}

function getResult<T>(result: ToolExecutionResult): T {
  expectSuccess<T>(result);
  return result.result as T;
}

function expectFailure(result: ToolExecutionResult, messageFragment?: string): void {
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  if (messageFragment) {
    expect(result.error).toContain(messageFragment);
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('workspaceTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    registerWorkspaceTools();
  });

  afterEach(() => {
    unregisterWorkspaceTools();
  });

  // ===========================================================================
  // Registration
  // ===========================================================================

  describe('registration', () => {
    it('should register all workspace tools in the global registry', () => {
      const expectedNames = [
        'list_workspace_documents',
        'read_workspace_document',
        'write_workspace_document',
        'replace_workspace_document_text',
        'create_workspace_folder',
        'rename_workspace_entry',
        'move_workspace_entry',
        'delete_workspace_entry',
      ];

      for (const name of expectedNames) {
        expect(globalToolRegistry.has(name)).toBe(true);
      }
    });

    it('should register all tools in the utility category', () => {
      const utilityTools = globalToolRegistry.listByCategory('utility');
      expect(utilityTools.length).toBe(8);
    });

    it('should return correct tool names from getWorkspaceToolNames', () => {
      const names = getWorkspaceToolNames();
      expect(names).toHaveLength(8);
      expect(names).toContain('list_workspace_documents');
      expect(names).toContain('read_workspace_document');
      expect(names).toContain('write_workspace_document');
      expect(names).toContain('replace_workspace_document_text');
      expect(names).toContain('create_workspace_folder');
      expect(names).toContain('rename_workspace_entry');
      expect(names).toContain('move_workspace_entry');
      expect(names).toContain('delete_workspace_entry');
    });

    it('should unregister all tools cleanly', () => {
      unregisterWorkspaceTools();

      for (const name of getWorkspaceToolNames()) {
        expect(globalToolRegistry.has(name)).toBe(false);
      }
    });

    it('should allow re-registration after unregistration', () => {
      unregisterWorkspaceTools();
      registerWorkspaceTools();
      expect(globalToolRegistry.has('list_workspace_documents')).toBe(true);
    });
  });

  // ===========================================================================
  // list_workspace_documents
  // ===========================================================================

  describe('list_workspace_documents', () => {
    it('should return file list with count when backend succeeds', async () => {
      const mockFiles = [
        { relativePath: 'docs/README.md', sizeBytes: 1024, modifiedAtUnixSec: 1700000000 },
        { relativePath: 'AGENTS.md', sizeBytes: 512, modifiedAtUnixSec: 1700000100 },
      ];
      mockListDocs.mockResolvedValueOnce(mockFiles);

      const result = await globalToolRegistry.execute('list_workspace_documents', {});
      const data = getResult<{ files: typeof mockFiles; count: number }>(result);

      expect(data.files).toEqual(mockFiles);
      expect(data.count).toBe(2);
      expect(mockListDocs).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should pass query and limit to backend', async () => {
      mockListDocs.mockResolvedValueOnce([]);

      await globalToolRegistry.execute('list_workspace_documents', {
        query: 'README',
        limit: 10,
      });

      expect(mockListDocs).toHaveBeenCalledWith('README', 10);
    });

    it('should reject non-integer limit via parameter validation', async () => {
      const result = await globalToolRegistry.execute('list_workspace_documents', {
        limit: 7.9,
      });

      // ToolRegistry validates 'integer' type and rejects floats
      expectFailure(result, 'must be an integer');
      expect(mockListDocs).not.toHaveBeenCalled();
    });

    it('should reject non-numeric limit via parameter validation', async () => {
      const result = await globalToolRegistry.execute('list_workspace_documents', {
        limit: 'invalid',
      });

      expectFailure(result, 'must be a number');
      expect(mockListDocs).not.toHaveBeenCalled();
    });

    it('should reject non-string query via parameter validation', async () => {
      const result = await globalToolRegistry.execute('list_workspace_documents', {
        query: 42,
      });

      expectFailure(result, 'must be a string');
      expect(mockListDocs).not.toHaveBeenCalled();
    });

    it('should return error when backend throws', async () => {
      mockListDocs.mockRejectedValueOnce(new Error('IPC connection failed'));

      const result = await globalToolRegistry.execute('list_workspace_documents', {});
      expectFailure(result, 'IPC connection failed');
    });

    it('should handle non-Error throws gracefully', async () => {
      mockListDocs.mockRejectedValueOnce('network timeout');

      const result = await globalToolRegistry.execute('list_workspace_documents', {});
      expectFailure(result, 'network timeout');
    });

    it('should return empty list when no files match', async () => {
      mockListDocs.mockResolvedValueOnce([]);

      const result = await globalToolRegistry.execute('list_workspace_documents', {
        query: 'nonexistent_file',
      });
      const data = getResult<{ files: unknown[]; count: number }>(result);

      expect(data.files).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('should reject Infinity as limit via parameter validation', async () => {
      const result = await globalToolRegistry.execute('list_workspace_documents', {
        limit: Infinity,
      });

      // Infinity fails Number.isInteger check
      expectFailure(result, 'must be an integer');
      expect(mockListDocs).not.toHaveBeenCalled();
    });

    it('should reject NaN as limit via parameter validation', async () => {
      const result = await globalToolRegistry.execute('list_workspace_documents', {
        limit: NaN,
      });

      // NaN fails Number.isInteger check
      expectFailure(result, 'must be an integer');
      expect(mockListDocs).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // read_workspace_document
  // ===========================================================================

  describe('read_workspace_document', () => {
    it('should return document content when backend succeeds', async () => {
      const mockDocument = {
        relativePath: 'docs/README.md',
        content: '# Hello World\n\nThis is a document.',
        sizeBytes: 37,
        modifiedAtUnixSec: 1700000000,
      };
      mockReadDoc.mockResolvedValueOnce(mockDocument);

      const result = await globalToolRegistry.execute('read_workspace_document', {
        relativePath: 'docs/README.md',
      });
      const data = getResult<typeof mockDocument>(result);

      expect(data).toEqual(mockDocument);
      expect(mockReadDoc).toHaveBeenCalledWith('docs/README.md');
    });

    it('should return error when file is not found', async () => {
      mockReadDoc.mockRejectedValueOnce(new Error('File not found: missing.md'));

      const result = await globalToolRegistry.execute('read_workspace_document', {
        relativePath: 'missing.md',
      });
      expectFailure(result, 'File not found');
    });

    it('should return error when backend throws', async () => {
      mockReadDoc.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await globalToolRegistry.execute('read_workspace_document', {
        relativePath: 'secret.txt',
      });
      expectFailure(result, 'Permission denied');
    });
  });

  // ===========================================================================
  // write_workspace_document
  // ===========================================================================

  describe('write_workspace_document', () => {
    it('should write content and return result', async () => {
      const mockWriteResult = {
        relativePath: 'docs/notes.md',
        bytesWritten: 25,
        created: false,
      };
      mockWriteDoc.mockResolvedValueOnce(mockWriteResult);

      const result = await globalToolRegistry.execute('write_workspace_document', {
        relativePath: 'docs/notes.md',
        content: '# Updated notes content',
      });
      const data = getResult<typeof mockWriteResult>(result);

      expect(data).toEqual(mockWriteResult);
      expect(mockWriteDoc).toHaveBeenCalledWith('docs/notes.md', '# Updated notes content', true);
    });

    it('should default createIfMissing to true', async () => {
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'new.md',
        bytesWritten: 5,
        created: true,
      });

      await globalToolRegistry.execute('write_workspace_document', {
        relativePath: 'new.md',
        content: 'hello',
      });

      expect(mockWriteDoc).toHaveBeenCalledWith('new.md', 'hello', true);
    });

    it('should pass createIfMissing=false when explicitly set', async () => {
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'existing.md',
        bytesWritten: 5,
        created: false,
      });

      await globalToolRegistry.execute('write_workspace_document', {
        relativePath: 'existing.md',
        content: 'hello',
        createIfMissing: false,
      });

      expect(mockWriteDoc).toHaveBeenCalledWith('existing.md', 'hello', false);
    });

    it('should return error when backend rejects write', async () => {
      mockWriteDoc.mockRejectedValueOnce(new Error('Disk full'));

      const result = await globalToolRegistry.execute('write_workspace_document', {
        relativePath: 'big-file.md',
        content: 'x'.repeat(1000),
      });
      expectFailure(result, 'Disk full');
    });

    it('should write empty string content', async () => {
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'empty.md',
        bytesWritten: 0,
        created: false,
      });

      const result = await globalToolRegistry.execute('write_workspace_document', {
        relativePath: 'empty.md',
        content: '',
      });
      expectSuccess(result);
      expect(mockWriteDoc).toHaveBeenCalledWith('empty.md', '', true);
    });
  });

  // ===========================================================================
  // replace_workspace_document_text
  // ===========================================================================

  describe('replace_workspace_document_text', () => {
    it('should replace all occurrences by default', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'foo bar foo baz foo',
        sizeBytes: 19,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 22,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'foo',
        replaceText: 'qux',
      });
      const data = getResult<{ relativePath: string; changed: boolean; replacements: number }>(
        result,
      );

      expect(data.changed).toBe(true);
      expect(data.replacements).toBe(3);
      expect(mockWriteDoc).toHaveBeenCalledWith('doc.md', 'qux bar qux baz qux', false);
    });

    it('should replace only first occurrence when replaceAll=false', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'aaa bbb aaa',
        sizeBytes: 11,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 11,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'aaa',
        replaceText: 'ccc',
        replaceAll: false,
      });
      const data = getResult<{ replacements: number; changed: boolean }>(result);

      expect(data.replacements).toBe(1);
      expect(data.changed).toBe(true);
      expect(mockWriteDoc).toHaveBeenCalledWith('doc.md', 'ccc bbb aaa', false);
    });

    it('should reject empty searchText', async () => {
      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: '',
        replaceText: 'anything',
      });

      expectFailure(result, 'searchText must not be empty');
      expect(mockReadDoc).not.toHaveBeenCalled();
    });

    it('should return changed=false when search text is not found', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'hello world',
        sizeBytes: 11,
        modifiedAtUnixSec: 1700000000,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'xyz',
        replaceText: 'abc',
      });
      const data = getResult<{ changed: boolean; replacements: number }>(result);

      expect(data.changed).toBe(false);
      expect(data.replacements).toBe(0);
      expect(mockWriteDoc).not.toHaveBeenCalled();
    });

    it('should handle replacement that creates longer content', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'a b a',
        sizeBytes: 5,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 15,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'a',
        replaceText: 'longword',
      });
      const data = getResult<{ replacements: number }>(result);

      expect(data.replacements).toBe(2);
      expect(mockWriteDoc).toHaveBeenCalledWith('doc.md', 'longword b longword', false);
    });

    it('should handle replacement that removes text', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'keep_remove_keep',
        sizeBytes: 16,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 9,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: '_remove',
        replaceText: '',
      });
      const data = getResult<{ replacements: number; changed: boolean }>(result);

      expect(data.replacements).toBe(1);
      expect(data.changed).toBe(true);
      expect(mockWriteDoc).toHaveBeenCalledWith('doc.md', 'keep_keep', false);
    });

    it('should return error when read fails', async () => {
      mockReadDoc.mockRejectedValueOnce(new Error('File not found'));

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'nonexistent.md',
        searchText: 'foo',
        replaceText: 'bar',
      });
      expectFailure(result, 'File not found');
    });

    it('should return error when write fails after successful read', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'hello world',
        sizeBytes: 11,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockRejectedValueOnce(new Error('Write permission denied'));

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'hello',
        replaceText: 'hi',
      });
      expectFailure(result, 'Write permission denied');
    });

    it('should handle overlapping search patterns correctly via split-join', async () => {
      // "aaa" searching for "aa" with split-join: "aaa".split("aa") => ["", "a"] => join("XX") => "XXa"
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'aaa',
        sizeBytes: 3,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 4,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'aa',
        replaceText: 'XX',
      });
      const data = getResult<{ replacements: number }>(result);

      // countOccurrences uses indexOf with index + needle.length, so "aaa" has 1 occurrence of "aa"
      expect(data.replacements).toBe(1);
      expect(mockWriteDoc).toHaveBeenCalledWith('doc.md', 'XXa', false);
    });

    it('should always pass createIfMissing=false to writeWorkspaceDocumentToBackend', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'old text',
        sizeBytes: 8,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 8,
        created: false,
      });

      await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'old',
        replaceText: 'new',
      });

      // The third argument (createIfMissing) should always be false for replace operations
      expect(mockWriteDoc).toHaveBeenCalledWith('doc.md', 'new text', false);
    });
  });

  // ===========================================================================
  // countOccurrences (tested through replace_workspace_document_text)
  // ===========================================================================

  describe('countOccurrences behavior', () => {
    it('should count non-overlapping occurrences', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'abcabcabc',
        sizeBytes: 9,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 6,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'abc',
        replaceText: 'XY',
      });
      const data = getResult<{ replacements: number }>(result);

      expect(data.replacements).toBe(3);
    });

    it('should count single character occurrences', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'a.b.c.d',
        sizeBytes: 7,
        modifiedAtUnixSec: 1700000000,
      });
      mockWriteDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        bytesWritten: 7,
        created: false,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: '.',
        replaceText: '-',
      });
      const data = getResult<{ replacements: number }>(result);

      expect(data.replacements).toBe(3);
    });

    it('should return 0 replacements for content without the needle', async () => {
      mockReadDoc.mockResolvedValueOnce({
        relativePath: 'doc.md',
        content: 'no match here',
        sizeBytes: 13,
        modifiedAtUnixSec: 1700000000,
      });

      const result = await globalToolRegistry.execute('replace_workspace_document_text', {
        relativePath: 'doc.md',
        searchText: 'missing',
        replaceText: 'found',
      });
      const data = getResult<{ replacements: number; changed: boolean }>(result);

      expect(data.replacements).toBe(0);
      expect(data.changed).toBe(false);
    });
  });

  // ===========================================================================
  // create_workspace_folder
  // ===========================================================================

  describe('create_workspace_folder', () => {
    it('should call executeAgentCommand with CreateFolder', async () => {
      mockExecCmd.mockResolvedValueOnce({ opId: 'op_1', changes: [], createdIds: [], deletedIds: [] });

      const result = await globalToolRegistry.execute('create_workspace_folder', {
        relativePath: 'docs/guides',
      });
      expectSuccess(result);

      expect(mockExecCmd).toHaveBeenCalledWith('CreateFolder', {
        relativePath: 'docs/guides',
      });
    });

    it('should return error when command fails', async () => {
      mockExecCmd.mockRejectedValueOnce(new Error('Folder already exists'));

      const result = await globalToolRegistry.execute('create_workspace_folder', {
        relativePath: 'docs/guides',
      });
      expectFailure(result, 'Folder already exists');
    });
  });

  // ===========================================================================
  // rename_workspace_entry
  // ===========================================================================

  describe('rename_workspace_entry', () => {
    it('should call executeAgentCommand with RenameFile', async () => {
      mockExecCmd.mockResolvedValueOnce({ opId: 'op_2', changes: [], createdIds: [], deletedIds: [] });

      const result = await globalToolRegistry.execute('rename_workspace_entry', {
        oldRelativePath: 'docs/old-name.md',
        newName: 'new-name.md',
      });
      expectSuccess(result);

      expect(mockExecCmd).toHaveBeenCalledWith('RenameFile', {
        oldRelativePath: 'docs/old-name.md',
        newName: 'new-name.md',
      });
    });

    it('should return error when rename fails', async () => {
      mockExecCmd.mockRejectedValueOnce(new Error('Name conflict'));

      const result = await globalToolRegistry.execute('rename_workspace_entry', {
        oldRelativePath: 'docs/file.md',
        newName: 'conflict.md',
      });
      expectFailure(result, 'Name conflict');
    });
  });

  // ===========================================================================
  // move_workspace_entry
  // ===========================================================================

  describe('move_workspace_entry', () => {
    it('should call executeAgentCommand with MoveFile', async () => {
      mockExecCmd.mockResolvedValueOnce({ opId: 'op_3', changes: [], createdIds: [], deletedIds: [] });

      const result = await globalToolRegistry.execute('move_workspace_entry', {
        sourcePath: 'docs/file.md',
        destFolderPath: 'archive',
      });
      expectSuccess(result);

      expect(mockExecCmd).toHaveBeenCalledWith('MoveFile', {
        sourcePath: 'docs/file.md',
        destFolderPath: 'archive',
      });
    });

    it('should return error when move fails', async () => {
      mockExecCmd.mockRejectedValueOnce(new Error('Destination not found'));

      const result = await globalToolRegistry.execute('move_workspace_entry', {
        sourcePath: 'docs/file.md',
        destFolderPath: 'nonexistent',
      });
      expectFailure(result, 'Destination not found');
    });
  });

  // ===========================================================================
  // delete_workspace_entry
  // ===========================================================================

  describe('delete_workspace_entry', () => {
    it('should call executeAgentCommand with DeleteFile', async () => {
      mockExecCmd.mockResolvedValueOnce({ opId: 'op_4', changes: [], createdIds: [], deletedIds: [] });

      const result = await globalToolRegistry.execute('delete_workspace_entry', {
        relativePath: 'temp/old-file.md',
      });
      expectSuccess(result);

      expect(mockExecCmd).toHaveBeenCalledWith('DeleteFile', {
        relativePath: 'temp/old-file.md',
      });
    });

    it('should return error when delete fails', async () => {
      mockExecCmd.mockRejectedValueOnce(new Error('File in use'));

      const result = await globalToolRegistry.execute('delete_workspace_entry', {
        relativePath: 'locked-file.md',
      });
      expectFailure(result, 'File in use');
    });
  });

  // ===========================================================================
  // Error handling: all tools catch and return { success: false, error }
  // ===========================================================================

  describe('error handling', () => {
    it('should wrap non-Error objects into error messages', async () => {
      mockReadDoc.mockRejectedValueOnce(42);

      const result = await globalToolRegistry.execute('read_workspace_document', {
        relativePath: 'file.md',
      });
      expectFailure(result, '42');
    });

    it('should wrap string rejections into error messages', async () => {
      mockExecCmd.mockRejectedValueOnce('backend crashed');

      const result = await globalToolRegistry.execute('create_workspace_folder', {
        relativePath: 'new-folder',
      });
      expectFailure(result, 'backend crashed');
    });

    it('should handle undefined rejection gracefully', async () => {
      mockWriteDoc.mockRejectedValueOnce(undefined);

      const result = await globalToolRegistry.execute('write_workspace_document', {
        relativePath: 'file.md',
        content: 'data',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
