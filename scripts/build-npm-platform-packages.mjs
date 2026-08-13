#!/usr/bin/env node

/**
 * @fileoverview Assembles the `@openreelio/cli-*` npm platform packages.
 *
 * The published npm surface is a shim package (`npm/openreelio-cli`) plus one
 * binary-carrying package per release target. The binaries only exist as
 * release assets, so the platform packages are generated at publish time rather
 * than committed. This script is that generator.
 *
 * It never downloads anything. The release path passes `--archives`: every
 * selected archive is checked against its `.sha256` sidecar and then unpacked
 * into a private staging directory, and the binary that gets packaged is taken
 * from that unpacked copy. That is what makes the checksum mean something --
 * the bytes that ship are the bytes that were verified. `--input`/`--binary`
 * stay available for local runs against already-unpacked binaries, but those
 * bytes are not verified.
 *
 * Usage:
 *   node scripts/build-npm-platform-packages.mjs [options]
 *
 * Options:
 *   --input <dir>          Directory of unpacked release binaries. Ignored when
 *                          --archives is given.
 *                          Default: dist/cli-assets
 *                          Looked up per target, first match wins:
 *                            <input>/<target-triple>/openreelio-cli[.exe]
 *                            <input>/<platform>/openreelio-cli[.exe]
 *                            <input>/openreelio-cli-<version>-<triple>/openreelio-cli[.exe]
 *                            <input>/openreelio-cli-<platform>[.exe]
 *   --binary <plat>=<path> Explicit binary for one platform (repeatable).
 *                          Overrides --input resolution for that platform.
 *                          Cannot be combined with --archives.
 *   --archives <dir>       Directory holding the release archives and their
 *                          .sha256 sidecars. Each selected target's archive is
 *                          verified, unpacked, and packaged from the unpacked
 *                          copy; --input and --binary are not consulted.
 *   --out <dir>            Output directory.
 *                          Default: npm/platform-packages/generated (git-ignored)
 *   --shim-out <dir>       Also write a version-stamped copy of the shim package
 *                          (npm/openreelio-cli) here, with optionalDependencies
 *                          pinned to --version.
 *   --version <semver>     Version to stamp. Default: the shim package version.
 *   --only <a,b>           Restrict to a comma-separated list of platforms.
 *   --help                 Print this help.
 *
 * Exit codes:
 *   0 - packages written
 *   1 - bad arguments, missing binary, or checksum mismatch
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SHIM_DIR = join(PROJECT_ROOT, 'npm', 'openreelio-cli');
const SCOPE = '@openreelio';

/**
 * Release targets published to npm. Kept deliberately in lockstep with the
 * matrix in .github/workflows/release.yml and the table in the shim launcher.
 *
 * Linux is glibc (gnu) only: the release matrix builds no musl target, so a
 * `linux-x64-musl` package would ship a binary that cannot run.
 */
const TARGETS = [
  {
    platform: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    os: 'win32',
    cpu: 'x64',
    binaryName: 'openreelio-cli.exe',
    archiveExtension: 'zip',
  },
  {
    platform: 'darwin-x64',
    triple: 'x86_64-apple-darwin',
    os: 'darwin',
    cpu: 'x64',
    binaryName: 'openreelio-cli',
    archiveExtension: 'tar.gz',
  },
  {
    platform: 'darwin-arm64',
    triple: 'aarch64-apple-darwin',
    os: 'darwin',
    cpu: 'arm64',
    binaryName: 'openreelio-cli',
    archiveExtension: 'tar.gz',
  },
  {
    platform: 'linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    os: 'linux',
    cpu: 'x64',
    binaryName: 'openreelio-cli',
    archiveExtension: 'tar.gz',
  },
];

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Aborts with a message on stderr.
 *
 * @param {string} message Reason for the failure.
 * @returns {never}
 */
function fail(message) {
  console.error(`build-npm-platform-packages: ${message}`);
  process.exit(1);
}

/**
 * Parses argv into a flat option object.
 *
 * @param {string[]} argv Raw arguments (without node/script).
 * @returns {{input?: string, archives?: string, out?: string, shimOut?: string,
 *   version?: string, only?: string, help: boolean, binaries: Map<string,string>}}
 */
function parseArgs(argv) {
  const options = { help: false, binaries: new Map() };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      fail(`unexpected argument "${raw}"`);
    }

    const equalsAt = raw.indexOf('=');
    const key = equalsAt === -1 ? raw.slice(2) : raw.slice(2, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : raw.slice(equalsAt + 1);

    const readValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        fail(`option --${key} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (key) {
      case 'help':
        options.help = true;
        break;
      case 'input':
        options.input = readValue();
        break;
      case 'archives':
        options.archives = readValue();
        break;
      case 'out':
        options.out = readValue();
        break;
      case 'shim-out':
        options.shimOut = readValue();
        break;
      case 'version':
        options.version = readValue();
        break;
      case 'only':
        options.only = readValue();
        break;
      case 'binary': {
        const value = readValue();
        const separatorAt = value.indexOf('=');
        if (separatorAt === -1) {
          fail('--binary expects <platform>=<path>');
        }
        options.binaries.set(value.slice(0, separatorAt), value.slice(separatorAt + 1));
        break;
      }
      default:
        fail(`unknown option --${key}`);
    }
  }

  return options;
}

/** Prints the usage block extracted from this file's header comment. */
function printHelp() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
  const usageAt = source.indexOf(' * Usage:');
  const endAt = source.indexOf(' */', usageAt);
  const usage = source
    .slice(usageAt, endAt)
    .split('\n')
    .map((line) => line.replace(/^ \* ?/, ''))
    .join('\n')
    .trimEnd();
  console.log(usage);
}

/**
 * Reads and validates the shim package manifest.
 *
 * @returns {Record<string, unknown>} Parsed package.json of the shim.
 */
function readShimManifest() {
  const manifestPath = join(SHIM_DIR, 'package.json');
  if (!existsSync(manifestPath)) {
    fail(`shim package not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const declared = Object.keys(manifest.optionalDependencies ?? {}).sort();
  const expected = TARGETS.map((target) => `${SCOPE}/cli-${target.platform}`).sort();

  if (declared.join(',') !== expected.join(',')) {
    fail(
      'shim optionalDependencies drifted from the release targets.\n' +
        `  declared: ${declared.join(', ') || '(none)'}\n` +
        `  expected: ${expected.join(', ')}`,
    );
  }

  return manifest;
}

/**
 * Computes the SHA-256 of a file.
 *
 * @param {string} filePath Absolute path.
 * @returns {Promise<string>} Lowercase hex digest.
 */
function sha256OfFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Verifies one target's release archive against its `.sha256` sidecar.
 *
 * @param {typeof TARGETS[number]} target Release target.
 * @param {string} archivesDir Directory holding archives and sidecars.
 * @param {string} version Version being published.
 * @returns {Promise<string>} The archive file name that was verified.
 */
async function verifyArchive(target, archivesDir, version) {
  const archiveName = `openreelio-cli-${version}-${target.triple}.${target.archiveExtension}`;
  const archivePath = join(archivesDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;

  if (!existsSync(archivePath)) {
    fail(`missing release archive for ${target.platform}: ${archivePath}`);
  }
  if (!existsSync(checksumPath)) {
    fail(`missing checksum sidecar for ${target.platform}: ${checksumPath}`);
  }

  // sha256sum/shasum sidecar format: "<hex>  <filename>".
  const expected = readFileSync(checksumPath, 'utf-8').trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    fail(`unreadable checksum sidecar for ${target.platform}: ${checksumPath}`);
  }

  const actual = await sha256OfFile(archivePath);
  if (actual !== expected) {
    fail(
      `checksum mismatch for ${archiveName}\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}`,
    );
  }

  return archiveName;
}

/**
 * Unpacks a verified archive into a private staging directory.
 *
 * Packaging from this copy, rather than from a separately supplied directory,
 * is what ties the checksum to the payload: a binary that was never inside the
 * verified archive cannot reach the published package.
 *
 * @param {typeof TARGETS[number]} target Release target.
 * @param {string} archivePath Archive whose checksum already matched.
 * @param {string} stagingRoot Directory to unpack into.
 * @returns {string} Absolute path to the unpacked binary.
 */
function extractVerifiedArchive(target, archivePath, stagingRoot) {
  const destination = join(stagingRoot, target.triple);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  // The archive is copied in and unpacked from inside the staging directory:
  // some tar builds read an absolute Windows path ("D:\...") as a remote host
  // spec, and a bare file name in the working directory cannot be misread.
  const localName = `archive.${target.archiveExtension}`;
  copyFileSync(archivePath, join(destination, localName));

  // GNU tar (Linux) cannot read zip and unzip is not installed everywhere, so
  // zip extraction tries unzip first and falls back to bsdtar (Windows, macOS).
  const attempts =
    target.archiveExtension === 'zip'
      ? [
          ['unzip', ['-o', '-q', localName]],
          ['tar', ['-xf', localName]],
        ]
      : [['tar', ['-xzf', localName]]];

  const failures = [];
  let unpacked = false;

  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { cwd: destination, encoding: 'utf-8' });
    if (!result.error && result.status === 0) {
      unpacked = true;
      break;
    }
    failures.push(
      `${command}: ${
        result.error ? result.error.message : `exit ${result.status} ${(result.stderr ?? '').trim()}`
      }`,
    );
  }

  if (!unpacked) {
    fail(`could not unpack ${archivePath}\n  ${failures.join('\n  ')}`);
  }

  rmSync(join(destination, localName), { force: true });

  const binaryPath = join(destination, target.binaryName);
  if (!existsSync(binaryPath)) {
    fail(`verified archive ${archivePath} does not contain ${target.binaryName}`);
  }

  return binaryPath;
}

/**
 * Locates the unpacked binary for a target.
 *
 * @param {typeof TARGETS[number]} target Release target.
 * @param {string|undefined} explicitPath Value of a matching --binary option.
 * @param {string} inputDir Directory of unpacked binaries.
 * @param {string} version Version being published.
 * @returns {string} Absolute path to the binary.
 */
function resolveBinary(target, explicitPath, inputDir, version) {
  if (explicitPath) {
    const absolute = resolve(PROJECT_ROOT, explicitPath);
    if (!existsSync(absolute)) {
      fail(`--binary ${target.platform} points at a missing file: ${absolute}`);
    }
    return absolute;
  }

  const candidates = [
    join(inputDir, target.triple, target.binaryName),
    join(inputDir, target.platform, target.binaryName),
    join(inputDir, `openreelio-cli-${version}-${target.triple}`, target.binaryName),
    join(inputDir, `openreelio-cli-${target.platform}${target.os === 'win32' ? '.exe' : ''}`),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail(
      `no binary found for ${target.platform}. Looked in:\n` +
        candidates.map((candidate) => `  ${candidate}`).join('\n') +
        `\nPass --binary ${target.platform}=<path> to point at it directly.`,
    );
  }

  return found;
}

/**
 * Writes one platform package directory.
 *
 * @param {typeof TARGETS[number]} target Release target.
 * @param {string} binaryPath Source binary.
 * @param {string} version Version to stamp.
 * @param {string} outDir Output root.
 * @returns {string} The package directory that was written.
 */
function writePlatformPackage(target, binaryPath, version, outDir) {
  const packageName = `${SCOPE}/cli-${target.platform}`;
  const packageDir = join(outDir, `cli-${target.platform}`);

  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(join(packageDir, 'bin'), { recursive: true });

  // No "bin" field and no "exports": the shim resolves this package's
  // package.json and joins bin/<binary> itself. Declaring a bin here would
  // create a second, conflicting command link.
  const manifest = {
    name: packageName,
    version,
    description: `OpenReelio CLI binary for ${target.os} ${target.cpu} (${target.triple}).`,
    homepage: 'https://github.com/openreelio/openreelio#readme',
    bugs: { url: 'https://github.com/openreelio/openreelio/issues' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/openreelio/openreelio.git',
    },
    license: 'MIT',
    author: 'Junseo5',
    os: [target.os],
    cpu: [target.cpu],
    engines: { node: '>=18' },
    files: [`bin/${target.binaryName}`, 'README.md', 'LICENSE'],
    preferUnplugged: true,
  };

  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );

  const readme = [
    `# ${packageName}`,
    '',
    `Prebuilt OpenReelio CLI binary for **${target.os} ${target.cpu}** (\`${target.triple}\`).`,
    '',
    'This package is an implementation detail of',
    '[`openreelio-cli`](https://www.npmjs.com/package/openreelio-cli). Install that',
    'package instead; npm selects the right binary package from `os`/`cpu`.',
    '',
    '```bash',
    'npm install openreelio-cli',
    '```',
    '',
    '## License',
    '',
    'MIT (c) 2026 Junseo5',
    '',
  ].join('\n');
  writeFileSync(join(packageDir, 'README.md'), readme, 'utf-8');

  copyFileSync(join(PROJECT_ROOT, 'LICENSE'), join(packageDir, 'LICENSE'));

  const destinationBinary = join(packageDir, 'bin', target.binaryName);
  copyFileSync(binaryPath, destinationBinary);
  if (target.os !== 'win32') {
    // npm pack preserves the mode bit; without it the installed binary is not
    // executable. Windows hosts cannot set it, hence the warning below.
    chmodSync(destinationBinary, 0o755);
    if (process.platform === 'win32') {
      console.warn(
        `  warning: generated ${packageName} on Windows; the executable bit may not survive npm pack.`,
      );
    }
  }

  return packageDir;
}

/**
 * Writes a version-stamped copy of the shim package.
 *
 * @param {Record<string, unknown>} shimManifest Parsed shim package.json.
 * @param {string} version Version to stamp.
 * @param {string} shimOutDir Destination directory.
 * @returns {string} The directory that was written.
 */
function writeStampedShim(shimManifest, version, shimOutDir) {
  rmSync(shimOutDir, { recursive: true, force: true });
  mkdirSync(join(shimOutDir, 'bin'), { recursive: true });

  const manifest = { ...shimManifest, version };
  manifest.optionalDependencies = Object.fromEntries(
    TARGETS.map((target) => [`${SCOPE}/cli-${target.platform}`, version]),
  );

  writeFileSync(
    join(shimOutDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );

  for (const file of ['README.md', 'LICENSE']) {
    copyFileSync(join(SHIM_DIR, file), join(shimOutDir, file));
  }
  copyFileSync(
    join(SHIM_DIR, 'bin', 'openreelio-cli.mjs'),
    join(shimOutDir, 'bin', 'openreelio-cli.mjs'),
  );

  return shimOutDir;
}

/** Entry point. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const shimManifest = readShimManifest();
  const version = options.version ?? shimManifest.version;
  if (typeof version !== 'string' || !SEMVER_REGEX.test(version)) {
    fail(`invalid version: ${String(version)}`);
  }

  const knownPlatforms = new Set(TARGETS.map((target) => target.platform));
  for (const platform of options.binaries.keys()) {
    if (!knownPlatforms.has(platform)) {
      fail(`--binary references unknown platform "${platform}"`);
    }
  }

  let selected = TARGETS;
  if (options.only) {
    const requested = options.only
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const platform of requested) {
      if (!knownPlatforms.has(platform)) {
        fail(`--only references unknown platform "${platform}"`);
      }
    }
    selected = TARGETS.filter((target) => requested.includes(target.platform));
    if (selected.length === 0) {
      fail('--only selected no targets');
    }
  }

  const inputDir = resolve(PROJECT_ROOT, options.input ?? join('dist', 'cli-assets'));
  const outDir = resolve(
    PROJECT_ROOT,
    options.out ?? join('npm', 'platform-packages', 'generated'),
  );
  const archivesDir = options.archives ? resolve(PROJECT_ROOT, options.archives) : undefined;
  const stagingRoot = join(outDir, '.staging');

  if (archivesDir && options.binaries.size > 0) {
    fail('--binary cannot be combined with --archives: the verified archive is the only source');
  }

  mkdirSync(outDir, { recursive: true });

  console.log(`Assembling ${selected.length} platform package(s) at version ${version}`);
  if (!archivesDir) {
    console.log('  note: no --archives given; the packaged binaries are not checksum-verified.');
  } else if (options.input) {
    console.log('  note: --input is ignored; binaries come from the verified archives.');
  }

  for (const target of selected) {
    let binaryPath;
    if (archivesDir) {
      const archiveName = await verifyArchive(target, archivesDir, version);
      binaryPath = extractVerifiedArchive(target, join(archivesDir, archiveName), stagingRoot);
      console.log(`  verified ${archiveName} -> ${target.binaryName}`);
    } else {
      binaryPath = resolveBinary(
        target,
        options.binaries.get(target.platform),
        inputDir,
        version,
      );
    }

    const packageDir = writePlatformPackage(target, binaryPath, version, outDir);
    console.log(`  ${SCOPE}/cli-${target.platform} -> ${packageDir}`);
  }

  if (archivesDir) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  if (options.shimOut) {
    const shimOutDir = resolve(PROJECT_ROOT, options.shimOut);
    writeStampedShim(shimManifest, version, shimOutDir);
    console.log(`  openreelio-cli -> ${shimOutDir}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
