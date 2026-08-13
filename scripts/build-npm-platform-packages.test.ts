/**
 * @fileoverview Tests for the npm platform package generator.
 *
 * Feature: the published binary is the checksummed binary
 *   Scenario: an unpacked binary on disk differs from the release archive
 *     Given a verified archive and a directory holding a different binary
 *     When the packages are assembled with --archives
 *     Then the packaged bytes come from the archive, not from that directory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'build-npm-platform-packages.mjs');
const WORKSPACE = join(__dirname, '__npm_package_fixtures__');

const VERSION = '9.9.9';
const TRIPLE = 'x86_64-unknown-linux-gnu';
const ARCHIVE_NAME = `openreelio-cli-${VERSION}-${TRIPLE}.tar.gz`;

const ARCHIVES_DIR = join(WORKSPACE, 'archives');
const INPUT_DIR = join(WORKSPACE, 'input');
const OUT_DIR = join(WORKSPACE, 'out');
const STAGE_DIR = join(WORKSPACE, 'stage');

const RELEASED_BINARY = 'released-binary-bytes\n';
const OTHER_BINARY = 'some-other-binary-bytes\n';

/** Runs the generator, returning combined stdout; throws with stderr on failure. */
function runGenerator(extraArgs: string[] = []): string {
  return execFileSync(
    process.execPath,
    [
      SCRIPT,
      '--version',
      VERSION,
      '--archives',
      ARCHIVES_DIR,
      '--out',
      OUT_DIR,
      '--only',
      'linux-x64',
      ...extraArgs,
    ],
    { encoding: 'utf-8', stdio: 'pipe' }
  );
}

/** Writes the sidecar in `sha256sum` format for the given archive. */
function writeChecksumSidecar(digest: string): void {
  writeFileSync(join(ARCHIVES_DIR, `${ARCHIVE_NAME}.sha256`), `${digest}  ${ARCHIVE_NAME}\n`);
}

/** Repacks the staging directory and refreshes its checksum sidecar. */
function repackStagingDirectory(): void {
  execFileSync('tar', ['-czf', `../archives/${ARCHIVE_NAME}`, 'openreelio-cli', 'LICENSE'], {
    cwd: STAGE_DIR,
  });
  writeChecksumSidecar(
    createHash('sha256').update(readFileSync(join(ARCHIVES_DIR, ARCHIVE_NAME))).digest('hex')
  );
}

/**
 * Whether this host can create symbolic links.
 *
 * Windows needs Developer Mode or elevation for them, so the link payload can
 * only be exercised where the fixture can actually be built.
 */
function canCreateSymlinks(): boolean {
  const probeDir = join(__dirname, '__npm_symlink_probe__');
  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(probeDir, { recursive: true });
  try {
    writeFileSync(join(probeDir, 'target'), 'probe\n');
    symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'));
    return lstatSync(join(probeDir, 'link')).isSymbolicLink();
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const SYMLINKS_AVAILABLE = canCreateSymlinks();

describe('build-npm-platform-packages', () => {
  beforeEach(() => {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(ARCHIVES_DIR, { recursive: true });
    mkdirSync(STAGE_DIR, { recursive: true });
    mkdirSync(join(INPUT_DIR, TRIPLE), { recursive: true });

    // The release archive: what the checksum will cover.
    writeFileSync(join(STAGE_DIR, 'openreelio-cli'), RELEASED_BINARY);
    writeFileSync(join(STAGE_DIR, 'LICENSE'), 'MIT\n');
    // Relative paths under an explicit cwd: some tar builds read an absolute
    // Windows path as a remote host spec.
    repackStagingDirectory();

    // A same-named binary on disk that the archive never contained.
    writeFileSync(join(INPUT_DIR, TRIPLE, 'openreelio-cli'), OTHER_BINARY);
  });

  afterEach(() => {
    rmSync(WORKSPACE, { recursive: true, force: true });
  });

  it('should package the binary from the verified archive when an unpacked directory disagrees', () => {
    runGenerator(['--input', INPUT_DIR]);

    const packaged = readFileSync(join(OUT_DIR, 'cli-linux-x64', 'bin', 'openreelio-cli'), 'utf-8');
    expect(packaged).toBe(RELEASED_BINARY);
    expect(packaged).not.toBe(OTHER_BINARY);
  });

  it('should refuse to package when the archive does not match its checksum', () => {
    writeChecksumSidecar('0'.repeat(64));

    let stderr = '';
    expect(() => {
      try {
        runGenerator();
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();
    expect(stderr).toContain('checksum mismatch');
  });

  it.skipIf(!SYMLINKS_AVAILABLE)(
    'should refuse to package a binary the archive smuggled in as a symbolic link',
    () => {
      // A link is not covered by the checksum: it names bytes that were never
      // in the archive, and copying it would follow the link off the staging
      // directory entirely.
      const outsideStaging = join(WORKSPACE, 'outside-the-staging-directory');
      writeFileSync(outsideStaging, 'bytes the checksum never covered\n');
      rmSync(join(STAGE_DIR, 'openreelio-cli'), { force: true });
      symlinkSync(outsideStaging, join(STAGE_DIR, 'openreelio-cli'));
      repackStagingDirectory();

      let stderr = '';
      expect(() => {
        try {
          runGenerator();
        } catch (error) {
          stderr = String((error as { stderr?: string }).stderr ?? '');
          throw error;
        }
      }).toThrow();
      expect(stderr).toContain('symbolic link');
    }
  );

  it('should refuse to package an archive entry that is not a regular file', () => {
    rmSync(join(STAGE_DIR, 'openreelio-cli'), { force: true });
    mkdirSync(join(STAGE_DIR, 'openreelio-cli'));
    repackStagingDirectory();

    let stderr = '';
    expect(() => {
      try {
        runGenerator();
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();
    expect(stderr).toContain('regular file');
  });

  it('should refuse to package a binary supplied outside the verified archive', () => {
    let stderr = '';
    expect(() => {
      try {
        runGenerator(['--binary', `linux-x64=${join(INPUT_DIR, TRIPLE, 'openreelio-cli')}`]);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();
    expect(stderr).toContain('--binary cannot be combined with --archives');
  });
});
