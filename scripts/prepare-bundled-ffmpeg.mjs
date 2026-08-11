import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_ATTEMPTS_PER_URL = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(scriptDir, 'ffmpeg-sources.json');
const binariesDir = path.join(repoRoot, 'src-tauri', 'binaries');

const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const target = args[0] ?? process.env.OPENREELIO_RELEASE_TARGET;

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const config = loadTargetConfig(manifest, target);

if (dryRun) {
  console.log(`Manifest entry for ${target} is valid:`);
  for (const archive of config.archives) {
    console.log(
      `  ${archive.name} (${archive.format}) -> ${archive.binaries.join(', ')}`,
    );
    for (const source of archive.urls) {
      console.log(`    ${source.url} [${describeChecksum(source)}]`);
    }
  }
  process.exit(0);
}

await prepareBundledFfmpeg(target, config);

function loadTargetConfig(sourceManifest, releaseTarget) {
  const targets = sourceManifest.targets ?? {};
  const targetConfig = targets[releaseTarget];

  if (!targetConfig) {
    console.error(
      `Unsupported release target "${releaseTarget ?? ''}". Expected one of: ${Object.keys(targets).join(', ')}`,
    );
    process.exit(1);
  }

  for (const archive of targetConfig.archives ?? []) {
    if (
      !archive.name ||
      !archive.format ||
      !archive.filename ||
      !Array.isArray(archive.binaries) ||
      archive.binaries.length === 0 ||
      !Array.isArray(archive.urls) ||
      archive.urls.length === 0 ||
      archive.urls.some((source) => typeof source.url !== 'string')
    ) {
      console.error(
        `Invalid manifest entry for ${releaseTarget}: archive "${archive.name ?? '?'}" is missing required fields.`,
      );
      process.exit(1);
    }
  }

  return targetConfig;
}

function describeChecksum(source) {
  if (source.sha256) {
    return 'pinned sha256';
  }
  if (source.sha256Url) {
    return 'sha256 sidecar url';
  }
  if (source.sha256Sidecar) {
    return `sha256 sidecar suffix ${source.sha256Sidecar}`;
  }
  return 'unverified';
}

function hasChecksumSource(source) {
  return Boolean(source.sha256 || source.sha256Url || source.sha256Sidecar);
}

async function prepareBundledFfmpeg(releaseTarget, releaseConfig) {
  const downloadRoot = path.join(
    repoRoot,
    'src-tauri',
    'target',
    `ffmpeg-download-${releaseTarget}`,
  );
  const stagedBinaries = new Map();
  const allowUnverified = process.env.OPENREELIO_ALLOW_UNVERIFIED_FFMPEG === '1';

  await rm(downloadRoot, { recursive: true, force: true });
  await mkdir(downloadRoot, { recursive: true });
  await mkdir(binariesDir, { recursive: true });

  try {
    for (const archive of releaseConfig.archives) {
      const archivePath = path.join(downloadRoot, archive.filename);
      const extractDir = path.join(downloadRoot, `${archive.name}-extracted`);

      await mkdir(extractDir, { recursive: true });
      await downloadArchive(archive, archivePath, allowUnverified);
      await extractArchive(archive.format, archivePath, extractDir);

      for (const binaryName of archive.binaries) {
        const binaryPath = await findBinary(extractDir, binaryName);
        stagedBinaries.set(binaryName, binaryPath);
      }
    }

    const expectedBinaries = [
      ...new Set(releaseConfig.archives.flatMap((archive) => archive.binaries)),
    ];
    for (const binaryName of expectedBinaries) {
      const sourcePath = stagedBinaries.get(binaryName);
      if (!sourcePath) {
        throw new Error(`Missing prepared binary: ${binaryName}`);
      }

      const destination = path.join(binariesDir, binaryName);
      await copyFile(sourcePath, destination);

      if (releaseConfig.platform !== 'windows') {
        await chmod(destination, 0o755);
      }

      await run(destination, ['-version'], { quiet: true });
      console.log(`Prepared ${binaryName}: ${destination}`);
    }
  } finally {
    await rm(downloadRoot, { recursive: true, force: true });
  }
}

async function downloadArchive(archive, outputPath, allowUnverified) {
  const errors = [];

  for (const source of archive.urls) {
    if (!hasChecksumSource(source) && !allowUnverified) {
      errors.push(
        `${source.url}: no checksum source in manifest and OPENREELIO_ALLOW_UNVERIFIED_FFMPEG is not set to 1`,
      );
      continue;
    }

    try {
      const resolvedUrl = await downloadUrl(source.url, outputPath);
      await verifyDownload(source, outputPath, resolvedUrl);
      return;
    } catch (error) {
      errors.push(`${source.url}: ${error.message}`);
      console.warn(`Download failed for ${source.url}: ${error.message}`);
    }
  }

  throw new Error(
    `All download URLs failed for ${archive.name}: ${errors.join('; ')}`,
  );
}

async function downloadUrl(url, outputPath) {
  let lastError;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS_PER_URL; attempt += 1) {
    console.log(
      `Downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${DOWNLOAD_ATTEMPTS_PER_URL})` : ''}`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/octet-stream, application/x-xz, application/zip, */*',
          'User-Agent': 'OpenReelio release asset downloader',
        },
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
      return response.url || url;
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt} failed for ${url}: ${error.message}`);
      if (attempt < DOWNLOAD_ATTEMPTS_PER_URL) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`Download failed: ${url}`);
}

async function verifyDownload(source, archivePath, resolvedUrl) {
  const expected = await resolveExpectedSha256(source, resolvedUrl);

  if (!expected) {
    console.warn(
      `No checksum source for ${source.url}; accepting unverified download (OPENREELIO_ALLOW_UNVERIFIED_FFMPEG=1).`,
    );
    return;
  }

  const actual = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${path.basename(archivePath)}: expected ${expected}, got ${actual}`,
    );
  }

  console.log(`Verified SHA-256 for ${path.basename(archivePath)}: ${actual}`);
}

async function resolveExpectedSha256(source, resolvedUrl) {
  if (source.sha256) {
    return source.sha256;
  }

  let sidecarUrl = null;
  if (source.sha256Url) {
    sidecarUrl = source.sha256Url;
  } else if (source.sha256Sidecar) {
    sidecarUrl = `${resolvedUrl}${source.sha256Sidecar}`;
  }

  if (!sidecarUrl) {
    return null;
  }

  const response = await fetch(sidecarUrl, {
    headers: { 'User-Agent': 'OpenReelio release asset downloader' },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch checksum sidecar ${sidecarUrl}: HTTP ${response.status}`,
    );
  }

  const digest = parseSha256Sidecar(await response.text(), source.url);
  if (!digest) {
    throw new Error(`No matching SHA-256 digest found in ${sidecarUrl}`);
  }

  return digest;
}

function parseSha256Sidecar(sidecarText, sourceUrl) {
  // Match against the manifest URL basename: redirect targets (for example
  // GitHub release assets) often resolve to opaque object-storage paths.
  const downloadBasename = path.posix
    .basename(new URL(sourceUrl).pathname)
    .toLowerCase();
  const digestPattern = /^[0-9a-f]{64}$/i;
  const digests = [];

  for (const line of sidecarText.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || !digestPattern.test(tokens[0])) {
      continue;
    }

    // Match "digest  filename" lines against the downloaded file first.
    const fileToken = tokens[tokens.length - 1].replace(/^\*/, '');
    if (
      tokens.length > 1 &&
      path.posix.basename(fileToken).toLowerCase() === downloadBasename
    ) {
      return tokens[0];
    }

    digests.push(tokens[0]);
  }

  // A bare-digest sidecar (single digest, no filename) applies to the download.
  return digests.length === 1 ? digests[0] : null;
}

async function extractArchive(format, archivePath, outputDir) {
  if (format === 'zip') {
    if (process.platform === 'win32') {
      await run('tar', ['-xf', archivePath, '-C', outputDir]);
      return;
    }

    await run('unzip', ['-q', archivePath, '-d', outputDir]);
    return;
  }

  if (format === 'tar.xz') {
    await run('tar', ['-xJf', archivePath, '-C', outputDir]);
    return;
  }

  if (format === 'tar.gz') {
    await run('tar', ['-xzf', archivePath, '-C', outputDir]);
    return;
  }

  throw new Error(`Unsupported archive format: ${format}`);
}

async function findBinary(rootDir, binaryName) {
  const stack = [rootDir];
  const expected = binaryName.toLowerCase();

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase() === expected) {
        return entryPath;
      }
    }
  }

  throw new Error(`Unable to find ${binaryName} under ${rootDir}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.quiet ? 'ignore' : 'inherit',
      windowsHide: true,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
