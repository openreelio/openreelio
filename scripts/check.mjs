import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string}} [options]
 */
function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const display = [command, ...args].join(' ');
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell });

    child.on('error', (error) => {
      reject(new Error(`Failed to start: ${display}\n${String(error)}`));
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Terminated by signal ${signal}: ${display}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${display}`));
        return;
      }
      resolve();
    });
  });
}

function parseArgs(argv) {
  const args = new Set(argv);
  const frontend = args.has('--frontend') || args.has('-f');
  const rust = args.has('--rust') || args.has('-r');
  const build = args.has('--build');
  const install = args.has('--install');
  const help = args.has('--help') || args.has('-h');

  if (help) {
    return { help: true };
  }

  const runFrontend = frontend || (!frontend && !rust);
  const runRust = rust || (!frontend && !rust);

  return { help: false, runFrontend, runRust, build, install };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      [
        'Usage: node scripts/check.mjs [--frontend|-f] [--rust|-r] [--build] [--install]',
        '',
        'Examples:',
        '  node scripts/check.mjs',
        '  node scripts/check.mjs --frontend',
        '  node scripts/check.mjs --rust --build',
        '  node scripts/check.mjs --install',
        '',
      ].join('\n')
    );
    return;
  }

  const npm = npmCommand();

  if (options.runFrontend) {
    if (options.install) {
      await run(npm, ['ci'], { cwd: repoRoot });
    }

    await run(npm, ['run', 'lint', '--if-present'], { cwd: repoRoot });
    await run(npm, ['run', 'type-check'], { cwd: repoRoot });
    await run(npm, ['test', '--', 'run', '--reporter=verbose'], { cwd: repoRoot });

    if (options.build) {
      await run(npm, ['run', 'build'], { cwd: repoRoot });
    }
  }

  if (options.runRust) {
    const tauriDir = path.join(repoRoot, 'src-tauri');

    await run('cargo', ['fmt', '--all', '--', '--check'], { cwd: tauriDir });
    await run('cargo', ['clippy', '--all-targets', '--all-features', '--', '-D', 'warnings'], {
      cwd: tauriDir,
    });
    await run('cargo', ['test', '--all-features'], { cwd: tauriDir });

    if (options.build) {
      await run('cargo', ['build', '--release'], { cwd: tauriDir });
    }
  }
}

await main();
