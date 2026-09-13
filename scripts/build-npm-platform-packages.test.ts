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
function runGenerator(extraArgs: string[] = [], platform = 'linux-x64'): string {
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
      platform,
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

/** CRC-32 (IEEE 802.3), the checksum every zip entry carries. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Writes a stored (uncompressed) zip whose entry names are taken verbatim.
 *
 * Every zip tool normalises names on the way in, so the only way to reproduce
 * an archive whose entries use backslash separators - what PowerShell's
 * Compress-Archive writes for nested directories - is to lay the bytes out
 * directly: local headers, the central directory, then the end record.
 */
function writeStoredZip(archivePath: string, entries: Array<[string, string]>): void {
  const DOS_DATE_1980_01_01 = 0x21;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const data = Buffer.from(content, 'utf-8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralSize = centrals.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // central directory disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  writeFileSync(archivePath, Buffer.concat([...locals, ...centrals, end]));
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

  it('should package a Windows archive whose entries use backslash separators', () => {
    const windowsTriple = 'x86_64-pc-windows-msvc';
    const windowsArchive = `openreelio-cli-${VERSION}-${windowsTriple}.zip`;
    const archivePath = join(ARCHIVES_DIR, windowsArchive);
    const archivedManifest = '{"archived": true}\n';

    // The v0.1.13 Windows archive: Compress-Archive wrote the nested emoji
    // pack with backslashes, and unzip extracts it but exits 1 to warn.
    writeStoredZip(archivePath, [
      ['openreelio-cli.exe', RELEASED_BINARY],
      ['LICENSE', 'MIT\n'],
      ['emoji\\manifest.json', archivedManifest],
      ['emoji\\png\\1f600.png', 'png-bytes\n'],
    ]);
    writeFileSync(
      join(ARCHIVES_DIR, `${windowsArchive}.sha256`),
      `${createHash('sha256').update(readFileSync(archivePath)).digest('hex')}  ${windowsArchive}\n`
    );

    runGenerator([], 'win32-x64');

    const packageDir = join(OUT_DIR, 'cli-win32-x64');
    expect(readFileSync(join(packageDir, 'bin', 'openreelio-cli.exe'), 'utf-8')).toBe(
      RELEASED_BINARY
    );
    // The pack came out of the archive as real directories, not from the
    // checkout fallback and not as files literally named "emoji\manifest.json".
    expect(readFileSync(join(packageDir, 'emoji', 'manifest.json'), 'utf-8')).toBe(
      archivedManifest
    );
    expect(readFileSync(join(packageDir, 'emoji', 'png', '1f600.png'), 'utf-8')).toBe(
      'png-bytes\n'
    );
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
