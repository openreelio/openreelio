import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const targets = {
  'x86_64-pc-windows-msvc': {
    platform: 'windows',
    sources: [
      {
        name: 'ffmpeg',
        format: 'zip',
        url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
        filename: 'ffmpeg-release-essentials.zip',
        binaries: ['ffmpeg.exe', 'ffprobe.exe'],
      },
    ],
  },
  'x86_64-apple-darwin': {
    platform: 'macos',
    sources: [
      {
        name: 'ffmpeg',
        format: 'zip',
        url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
        filename: 'ffmpeg.zip',
        binaries: ['ffmpeg'],
      },
      {
        name: 'ffprobe',
        format: 'zip',
        url: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
        filename: 'ffprobe.zip',
        binaries: ['ffprobe'],
      },
    ],
  },
  'aarch64-apple-darwin': {
    platform: 'macos',
    sources: [
      {
        name: 'ffmpeg',
        format: 'zip',
        url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
        filename: 'ffmpeg.zip',
        binaries: ['ffmpeg'],
      },
      {
        name: 'ffprobe',
        format: 'zip',
        url: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
        filename: 'ffprobe.zip',
        binaries: ['ffprobe'],
      },
    ],
  },
  'x86_64-unknown-linux-gnu': {
    platform: 'linux',
    sources: [
      {
        name: 'ffmpeg',
        format: 'tar.xz',
        url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
        fallbackUrls: [
          'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
        ],
        filename: 'ffmpeg-release-amd64-static.tar.xz',
        binaries: ['ffmpeg', 'ffprobe'],
      },
    ],
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const binariesDir = path.join(repoRoot, 'src-tauri', 'binaries');

const target = process.argv[2] ?? process.env.OPENREELIO_RELEASE_TARGET;
const config = targets[target];

if (!config) {
  console.error(
    `Unsupported release target "${target ?? ''}". Expected one of: ${Object.keys(targets).join(', ')}`,
  );
  process.exit(1);
}

if (process.env.OPENREELIO_ALLOW_UNVERIFIED_FFMPEG !== '1') {
  console.error(
    'FFmpeg release downloads are not checksum-pinned yet. Set OPENREELIO_ALLOW_UNVERIFIED_FFMPEG=1 only in the controlled release workflow.',
  );
  process.exit(1);
}

await prepareBundledFfmpeg(target, config);

async function prepareBundledFfmpeg(releaseTarget, releaseConfig) {
  const downloadRoot = path.join(
    repoRoot,
    'src-tauri',
    'target',
    `ffmpeg-download-${releaseTarget}`,
  );
  const stagedBinaries = new Map();

  await rm(downloadRoot, { recursive: true, force: true });
  await mkdir(downloadRoot, { recursive: true });
  await mkdir(binariesDir, { recursive: true });

  try {
    for (const source of releaseConfig.sources) {
      const archivePath = path.join(downloadRoot, source.filename);
      const extractDir = path.join(downloadRoot, `${source.name}-extracted`);

      await mkdir(extractDir, { recursive: true });
      await downloadFile(source, archivePath);
      await extractArchive(source.format, archivePath, extractDir);

      for (const binaryName of source.binaries) {
        const binaryPath = await findBinary(extractDir, binaryName);
        stagedBinaries.set(binaryName, binaryPath);
      }
    }

    const expectedBinaries = [
      ...new Set(releaseConfig.sources.flatMap((source) => source.binaries)),
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

async function downloadFile(source, outputPath) {
  const urls = [source.url, ...(source.fallbackUrls ?? [])];
  let lastError;

  for (const url of urls) {
    try {
      await downloadUrl(url, outputPath);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Download failed for ${url}: ${error.message}`);
    }
  }

  throw lastError ?? new Error(`No download URLs configured for ${source.name}`);
}

async function downloadUrl(url, outputPath) {
  console.log(`Downloading ${url}`);

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
  } finally {
    clearTimeout(timeout);
  }
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
