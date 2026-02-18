import {
  parseRegisterFileResult,
  parseRelativeWorkspacePath,
  parseRelativeWorkspacePathList,
  parseWorkspaceFileEvent,
  parseWorkspaceScanResult,
  parseWorkspaceTree,
  WORKSPACE_SCHEMA_LIMITS,
} from './workspaceSchemas';

describe('workspaceSchemas', () => {
  describe('parseRelativeWorkspacePath', () => {
    it('should normalize Windows separators', () => {
      const path = parseRelativeWorkspacePath(' footage\\clip.mp4 ');
      expect(path).toBe('footage/clip.mp4');
    });

    it('should reject path traversal segments', () => {
      expect(() => parseRelativeWorkspacePath('../secrets.mp4')).toThrow(
        'relativePath contains invalid "." or ".." path segments',
      );
    });

    it('should reject absolute paths', () => {
      expect(() => parseRelativeWorkspacePath('/tmp/clip.mp4')).toThrow(
        'relativePath must not be absolute',
      );
    });

    it('should reject control characters', () => {
      expect(() => parseRelativeWorkspacePath('footage/clip\n.mp4')).toThrow(
        'relativePath contains control characters',
      );
    });
  });

  describe('parseRelativeWorkspacePathList', () => {
    it('should dedupe and preserve insertion order', () => {
      const paths = parseRelativeWorkspacePathList(['a.mp4', 'a.mp4', 'b\\clip.mp4', '']);
      expect(paths).toEqual(['a.mp4', 'b/clip.mp4']);
    });

    it('should reject oversized batch input', () => {
      const oversized = Array.from(
        { length: WORKSPACE_SCHEMA_LIMITS.maxBatchRegistrationPaths + 1 },
        (_, idx) => `clip-${idx}.mp4`,
      );

      expect(() => parseRelativeWorkspacePathList(oversized)).toThrow(
        `Cannot register more than ${WORKSPACE_SCHEMA_LIMITS.maxBatchRegistrationPaths} files at once`,
      );
    });
  });

  describe('parseWorkspaceScanResult', () => {
    it('should parse valid scan results', () => {
      const parsed = parseWorkspaceScanResult({
        totalFiles: 12,
        newFiles: 2,
        removedFiles: 1,
        registeredFiles: 5,
      });

      expect(parsed).toEqual({
        totalFiles: 12,
        newFiles: 2,
        removedFiles: 1,
        registeredFiles: 5,
      });
    });

    it('should reject malformed scan results', () => {
      expect(() =>
        parseWorkspaceScanResult({
          totalFiles: '12',
          newFiles: 2,
          removedFiles: 1,
          registeredFiles: 5,
        }),
      ).toThrow('Invalid workspace scan result payload');
    });
  });

  describe('parseWorkspaceTree', () => {
    it('should parse valid tree payloads', () => {
      const parsed = parseWorkspaceTree([
        {
          relativePath: 'footage',
          name: 'footage',
          isDirectory: true,
          kind: null,
          fileSize: null,
          assetId: null,
          children: [
            {
              relativePath: 'footage/clip.mp4',
              name: 'clip.mp4',
              isDirectory: false,
              kind: 'video',
              fileSize: 100,
              assetId: 'asset-1',
              children: [],
            },
          ],
        },
      ]);

      expect(parsed[0]?.children[0]?.kind).toBe('video');
      expect(parsed[0]?.kind).toBeUndefined();
    });

    it('should reject invalid file nodes with children', () => {
      expect(() =>
        parseWorkspaceTree([
          {
            relativePath: 'clip.mp4',
            name: 'clip.mp4',
            isDirectory: false,
            kind: 'video',
            fileSize: 100,
            assetId: null,
            children: [
              {
                relativePath: 'clip.mp4/child.mp4',
                name: 'child.mp4',
                isDirectory: false,
                kind: 'video',
                fileSize: 50,
                assetId: null,
                children: [],
              },
            ],
          },
        ]),
      ).toThrow('file entries must not include child nodes');
    });
  });

  describe('parseRegisterFileResult', () => {
    it('should validate register result payload', () => {
      const parsed = parseRegisterFileResult({
        assetId: 'asset-123',
        relativePath: 'footage/clip.mp4',
        alreadyRegistered: false,
      });

      expect(parsed.assetId).toBe('asset-123');
    });
  });

  describe('parseWorkspaceFileEvent', () => {
    it('should parse valid event payloads with null kind', () => {
      const parsed = parseWorkspaceFileEvent({
        relativePath: 'footage/clip.mp4',
        kind: null,
      });

      expect(parsed.kind).toBeNull();
    });
  });
});
