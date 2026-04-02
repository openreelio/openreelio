import {
  buildPermissionSubject,
  getPermissionPatternSpecificity,
  isCanonicalPermissionPattern,
  isExactPermissionPatternMatch,
  matchLegacyPermissionPattern,
  matchPermissionPattern,
  toPermissionRulePattern,
} from './permissionSubject';

describe('permissionSubject', () => {
  it('builds canonical clip capability subjects', () => {
    const subject = buildPermissionSubject('split_clip');

    expect(subject).toMatchObject({
      subjectType: 'capability',
      subject: 'timeline.clip.split',
      normalizedToolName: 'split_clip',
      toolName: 'split_clip',
      resourceBinding: null,
    });
    expect(subject.aliases).toEqual(
      expect.arrayContaining(['timeline.clip.split', 'split_clip', 'tool.split_clip']),
    );
  });

  it('normalizes meta-tool actions to the underlying action subject', () => {
    const subject = buildPermissionSubject('query', { action: 'get_clip_info' });

    expect(subject).toMatchObject({
      subjectType: 'capability',
      subject: 'timeline.clip.read',
      normalizedToolName: 'get_clip_info',
      toolName: 'query',
      resourceBinding: null,
    });
    expect(subject.aliases).toEqual(
      expect.arrayContaining([
        'timeline.clip.read',
        'query',
        'get_clip_info',
        'tool.query',
        'tool.get_clip_info',
      ]),
    );
  });

  it('builds canonical workspace subjects', () => {
    const subject = buildPermissionSubject('write_workspace_document');

    expect(subject).toMatchObject({
      subjectType: 'workspace',
      subject: 'workspace.document.write',
      normalizedToolName: 'write_workspace_document',
      toolName: 'write_workspace_document',
      resourceBinding: null,
    });
    expect(subject.aliases).toEqual(
      expect.arrayContaining([
        'workspace.document.write',
        'write_workspace_document',
        'tool.write_workspace_document',
      ]),
    );
  });

  it('builds analysis subjects without leaking into the workspace domain', () => {
    const subject = buildPermissionSubject('analyze_workspace_video', {
      file: 'media/intro.mp4',
    });

    expect(subject).toMatchObject({
      subjectType: 'resource',
      subject: 'asset.analysis.run#path:media/intro.mp4',
      normalizedToolName: 'analyze_workspace_video',
      toolName: 'analyze_workspace_video',
      resourceBinding: 'path:media/intro.mp4',
    });
    expect(subject.aliases).toEqual(
      expect.arrayContaining([
        'asset.analysis.run#path:media/intro.mp4',
        'asset.analysis.run',
        'analyze_workspace_video',
        'tool.analyze_workspace_video',
      ]),
    );
  });

  it('builds analysis status and provider subjects explicitly', () => {
    const statusSubject = buildPermissionSubject('get_analysis_status', {
      assetId: 'asset-7',
    });
    const providersSubject = buildPermissionSubject('get_analysis_providers');

    expect(statusSubject.subject).toBe('asset.analysis.status.read#asset:asset-7');
    expect(statusSubject.subjectType).toBe('resource');
    expect(providersSubject.subject).toBe('external_provider.providers.read');
    expect(providersSubject.subjectType).toBe('external_provider');
  });

  it('builds a resource-aware canonical subject for meta-tool actions', () => {
    const subject = buildPermissionSubject('edit', {
      action: 'delete_clip',
      clipId: 'clip-42',
    });

    expect(subject.subjectType).toBe('resource');
    expect(subject.subject).toBe('timeline.clip.delete#clip:clip-42');
    expect(subject.normalizedToolName).toBe('delete_clip');
    expect(subject.toolName).toBe('edit');
    expect(subject.aliases).toContain('edit');
    expect(subject.aliases).toContain('delete_clip');
  });

  it('matches legacy tool-name patterns', () => {
    expect(matchLegacyPermissionPattern('get_*', 'get_clip_info')).toBe(true);
    expect(matchLegacyPermissionPattern('get_*', 'split_clip')).toBe(false);
  });

  it('matches canonical patterns without requiring a resource suffix', () => {
    const subject = buildPermissionSubject('edit', {
      action: 'split_clip',
      clipId: 'clip-7',
    });

    expect(matchPermissionPattern('timeline.clip.split', subject)).toBe(true);
    expect(matchPermissionPattern('timeline.clip.*', subject)).toBe(true);
    expect(matchPermissionPattern('timeline.**', subject)).toBe(true);
    expect(matchPermissionPattern('timeline.track.*', subject)).toBe(false);
  });

  it('recognizes canonical patterns and exact matches', () => {
    const subject = buildPermissionSubject('delete_clip', { clipId: 'clip-1' });

    expect(isCanonicalPermissionPattern('timeline.clip.delete#clip:*')).toBe(true);
    expect(isExactPermissionPatternMatch('timeline.clip.delete#clip:clip-1', subject)).toBe(true);
    expect(isExactPermissionPatternMatch('timeline.clip.delete', subject)).toBe(true);
    expect(
      getPermissionPatternSpecificity('timeline.clip.delete#clip:clip-1'),
    ).toBeGreaterThan(getPermissionPatternSpecificity('timeline.clip.*'));
  });

  it('keeps legacy tool globs working for meta-tool actions', () => {
    const subject = buildPermissionSubject('edit', {
      action: 'delete_clip',
    });

    expect(matchPermissionPattern('delete_*', subject)).toBe(true);
    expect(matchPermissionPattern('split_*', subject)).toBe(false);
  });

  it('keeps resource bindings when generating session-scoped allow patterns', () => {
    const subject = buildPermissionSubject('edit', {
      action: 'split_clip',
      clipId: 'clip-99',
    });

    expect(toPermissionRulePattern(subject)).toBe('timeline.clip.split#clip:clip-99');
  });

  it('captures workspace paths and job ids as concrete resource bindings', () => {
    const workspaceSubject = buildPermissionSubject('write_workspace_document', {
      relativePath: 'docs/ROADMAP.md',
    });
    const generationSubject = buildPermissionSubject('cancel_generation', {
      jobId: 'job-42',
    });

    expect(workspaceSubject.subject).toBe('workspace.document.write#path:docs/ROADMAP.md');
    expect(workspaceSubject.subjectType).toBe('resource');
    expect(generationSubject.subject).toBe('external_provider.cancel#job:job-42');
    expect(generationSubject.subjectType).toBe('resource');
  });
});
