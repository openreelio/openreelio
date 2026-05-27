/**
 * Process Command Window Guard
 *
 * Architecture rule:
 * - Tauri runtime subprocesses must be configured through core::process helpers.
 * - Build-script subprocesses must also use a Windows no-window command helper.
 * - On Windows, console binaries can flash a command window when spawned from
 *   the GUI process unless CREATE_NO_WINDOW is applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TAURI_RUNTIME_SRC_ROOT = path.resolve(process.cwd(), 'src-tauri/src');
const TAURI_BUILD_SCRIPT_PATH = 'src-tauri/build.rs';
const PROCESS_HELPER_PATH = 'src-tauri/src/core/process.rs';
const PROCESS_SCAN_PATHS = [
  TAURI_RUNTIME_SRC_ROOT,
  path.resolve(process.cwd(), TAURI_BUILD_SCRIPT_PATH),
];
const COMMAND_CREATION_CONTEXT_LINES = 8;

interface CommandCreation {
  file: string;
  line: number;
  variableName: string | null;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function collectRustFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectRustFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.rs')) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectRustFilesFromPath(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return targetPath.endsWith('.rs') ? [targetPath] : [];
  }

  return collectRustFiles(targetPath);
}

function lineWithoutComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

function importsProcessCommand(content: string, processModule: 'std' | 'tokio'): boolean {
  const directImport = new RegExp(`^\\s*use\\s+${processModule}::process::Command\\s*;`, 'm');
  const groupedImport = new RegExp(
    `^\\s*use\\s+${processModule}::process::\\{[^}]*\\bCommand\\b[^}]*\\}\\s*;`,
    'm',
  );
  const nestedImport = new RegExp(
    `^\\s*use\\s+${processModule}::\\{[^;]*\\bprocess::Command\\b[^;]*\\}\\s*;`,
    'm',
  );

  return directImport.test(content) || groupedImport.test(content) || nestedImport.test(content);
}

function unsupportedProcessCommandAliases(content: string): string[] {
  const violations: string[] = [];
  const aliasPatterns = [
    /\buse\s+(?:std|tokio)::process::\{[^}]*\bCommand\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\buse\s+(?:std|tokio)::process\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ];

  for (const pattern of aliasPatterns) {
    for (const match of content.matchAll(pattern)) {
      violations.push(match[1]);
    }
  }

  return violations;
}

function isProcessCommandCreation(
  line: string,
  hasStdCommandImport: boolean,
  hasTokioCommandImport: boolean,
): boolean {
  if (/\bstd::process::Command::new\s*\(/.test(line)) return true;
  if (/\btokio::process::Command::new\s*\(/.test(line)) return true;
  if (!/\bCommand::new\s*\(/.test(line)) return false;

  return hasStdCommandImport || hasTokioCommandImport;
}

function commandVariableName(line: string): string | null {
  const match = line.match(
    /\b(?:let\s+mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:(?:std|tokio)::process::)?Command::new\s*\(/,
  );

  return match?.[1] ?? null;
}

function collectProcessCommandCreations(filePath: string, content: string): CommandCreation[] {
  const hasStdCommandImport = importsProcessCommand(content, 'std');
  const hasTokioCommandImport = importsProcessCommand(content, 'tokio');
  const lines = content.split('\n');
  const creations: CommandCreation[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lineWithoutComment(lines[index]);
    if (!isProcessCommandCreation(line, hasStdCommandImport, hasTokioCommandImport)) {
      continue;
    }

    creations.push({
      file: normalizePath(path.relative(process.cwd(), filePath)),
      line: index + 1,
      variableName: commandVariableName(line),
    });
  }

  return creations;
}

function isConfiguredAfterCreation(
  lines: string[],
  creationLineIndex: number,
  variableName: string,
  normalizedPath: string,
): boolean {
  const helperNames =
    normalizedPath === TAURI_BUILD_SCRIPT_PATH
      ? ['configure_build_command']
      : ['configure_std_command', 'configure_tokio_command'];
  const configurePattern = new RegExp(
    `\\b(?:crate::core::process::)?(?:${helperNames.join('|')})\\s*\\(\\s*&mut\\s+${variableName}\\s*\\)`,
  );
  const endIndex = Math.min(lines.length - 1, creationLineIndex + COMMAND_CREATION_CONTEXT_LINES);

  for (let index = creationLineIndex; index <= endIndex; index += 1) {
    if (configurePattern.test(lineWithoutComment(lines[index]))) {
      return true;
    }
  }

  return false;
}

describe('Process command window guard', () => {
  it('configures every Tauri runtime and build-script subprocess command through no-window helpers', () => {
    const violations: string[] = [];

    for (const filePath of PROCESS_SCAN_PATHS.flatMap(collectRustFilesFromPath)) {
      const normalizedPath = normalizePath(path.relative(process.cwd(), filePath));
      if (normalizedPath === PROCESS_HELPER_PATH) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      for (const alias of unsupportedProcessCommandAliases(content)) {
        violations.push(
          `${normalizedPath} imports process Command through unsupported alias ${alias}`,
        );
      }

      for (const creation of collectProcessCommandCreations(filePath, content)) {
        if (!creation.variableName) {
          violations.push(`${creation.file}:${creation.line} creates a process command inline`);
          continue;
        }

        if (
          !isConfiguredAfterCreation(
            lines,
            creation.line - 1,
            creation.variableName,
            normalizedPath,
          )
        ) {
          violations.push(
            `${creation.file}:${creation.line} creates ${creation.variableName} without configure_*_command`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
