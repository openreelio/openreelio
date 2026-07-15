import { describe, expect, it } from 'vitest';

import {
  createRuntimeGuidance,
  formatInstallProgress,
  formatRuntimeSource,
  isRuntimeUpdateAvailable,
  nativeDownloadFailureGuidance,
  parseRuntimeSemver,
} from './runtimeControlsShared';

describe('parseRuntimeSemver', () => {
  it('should extract a bare semver from a labelled CLI version', () => {
    expect(parseRuntimeSemver('claude 2.1.202')).toBe('2.1.202');
    expect(parseRuntimeSemver('codex-cli 0.144.4')).toBe('0.144.4');
  });

  it('should return null when no version is present', () => {
    expect(parseRuntimeSemver('unknown')).toBeNull();
    expect(parseRuntimeSemver(null)).toBeNull();
    expect(parseRuntimeSemver(undefined)).toBeNull();
  });
});

describe('isRuntimeUpdateAvailable', () => {
  it('should offer an update when the installed version differs from the pinned target', () => {
    expect(isRuntimeUpdateAvailable('codex-cli 0.118.0', '0.144.4')).toBe(true);
    expect(isRuntimeUpdateAvailable('claude 1.2.0', '2.1.202')).toBe(true);
  });

  it('should not offer an update when the installed version matches the pinned target', () => {
    expect(isRuntimeUpdateAvailable('codex-cli 0.144.4', '0.144.4')).toBe(false);
    expect(isRuntimeUpdateAvailable('claude 2.1.202', '2.1.202')).toBe(false);
  });

  it('should not offer an update when either version is unknown', () => {
    expect(isRuntimeUpdateAvailable(null, '0.144.4')).toBe(false);
    expect(isRuntimeUpdateAvailable('codex-cli 0.144.4', null)).toBe(false);
    expect(isRuntimeUpdateAvailable(null, null)).toBe(false);
  });
});

describe('formatRuntimeSource', () => {
  it('should label the legacy npm runtime so users know to migrate', () => {
    expect(formatRuntimeSource('managed-legacy')).toBe('managed (legacy npm)');
  });

  it('should pass through other known sources unchanged', () => {
    expect(formatRuntimeSource('managed')).toBe('managed');
    expect(formatRuntimeSource('system')).toBe('system');
  });

  it('should return null when the source is unknown', () => {
    expect(formatRuntimeSource(null)).toBeNull();
    expect(formatRuntimeSource(undefined)).toBeNull();
  });
});

describe('formatInstallProgress', () => {
  it('should include the rounded percent when known', () => {
    expect(
      formatInstallProgress({
        runtimeId: 'codex',
        downloadedBytes: 50,
        totalBytes: 100,
        percent: 42.4,
        stage: 'downloading',
      }),
    ).toBe('Downloading 42%');
  });

  it('should show only the stage label when percent is unknown', () => {
    expect(
      formatInstallProgress({
        runtimeId: 'claude',
        downloadedBytes: 0,
        totalBytes: null,
        percent: null,
        stage: 'verifying',
      }),
    ).toBe('Verifying');
  });

  it('should return null when there is no active progress', () => {
    expect(formatInstallProgress(null)).toBeNull();
    expect(formatInstallProgress(undefined)).toBeNull();
  });
});

describe('nativeDownloadFailureGuidance', () => {
  it('should surface network guidance for download/network failures', () => {
    expect(
      nativeDownloadFailureGuidance('Failed to download binary: connection timed out'),
    ).toBe('Check your network connection and try again.');
    expect(nativeDownloadFailureGuidance('proxy error while fetching')).toBe(
      'Check your network connection and try again.',
    );
  });

  it('should return null for unrelated messages', () => {
    expect(nativeDownloadFailureGuidance('Codex CLI was not found.')).toBeNull();
    expect(nativeDownloadFailureGuidance(null)).toBeNull();
  });
});

describe('createRuntimeGuidance', () => {
  const claude = createRuntimeGuidance({
    productName: 'Claude',
    reinstallMessage: 'Reinstall Claude Code.',
    notInstalledPattern: /claude(?: code)?(?: cli)? (?:was |is )?not (?:installed|found)/i,
    notInstalledMessage: 'Claude Code is not installed yet. Install it to continue.',
  });
  const codex = createRuntimeGuidance({
    productName: 'Codex',
    reinstallMessage: 'Reinstall Codex.',
    notInstalledPattern: /codex(?: cli)? (?:was |is )?not (?:installed|found)/i,
    notInstalledMessage: 'Codex is not installed yet. Install Codex to continue.',
  });

  it('should map launcher, download, and not-installed errors to per-runtime guidance', () => {
    expect(claude.getSafeRuntimeGuidance('os error 193 (%1 is not a valid Win32 application)')).toBe(
      'Reinstall Claude Code.',
    );
    expect(claude.getSafeRuntimeGuidance('connection timed out')).toBe(
      'Check your network connection and try again.',
    );
    expect(claude.getSafeRuntimeGuidance('Claude Code was not installed.')).toBe(
      'Claude Code is not installed yet. Install it to continue.',
    );
    expect(codex.getSafeRuntimeGuidance('Codex CLI was not found.')).toBe(
      'Codex is not installed yet. Install Codex to continue.',
    );
  });

  it('should return null when no safe guidance applies', () => {
    expect(claude.getSafeRuntimeGuidance('some unexpected failure')).toBeNull();
    expect(claude.getSafeRuntimeGuidance(null)).toBeNull();
  });

  it('should hide raw errors behind product-specific guidance unless diagnostics are on', () => {
    expect(claude.formatActionError(new Error('kaboom'), false)).toBe(
      'The Claude setup action could not be completed. Check your connection and try again.',
    );
    expect(codex.formatActionError(new Error('kaboom'), false)).toBe(
      'The Codex setup action could not be completed. Check your connection and try again.',
    );
    expect(claude.formatActionError(new Error('kaboom'), true)).toBe('kaboom');
  });

  it('should prefer the raw message with diagnostics on and the fallback otherwise', () => {
    expect(claude.formatRuntimeMessage('raw detail', 'fallback', true)).toBe('raw detail');
    expect(claude.formatRuntimeMessage('some unexpected failure', 'fallback', false)).toBe(
      'fallback',
    );
  });
});
