/**
 * Playback Write Path Guard
 *
 * Architecture rule:
 * - Direct `setCurrentTime(...)` calls are only allowed in playback-core modules.
 * - Feature/UI layers must use `seek(...)` for user-intent time changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

const ALLOWED_SET_CURRENT_TIME_CALLERS = new Set([
  'src/components/preview/ProxyPreviewPlayer.tsx',
  'src/core/TimelineEngine.ts',
  'src/hooks/usePlaybackLoop.ts',
  'src/hooks/useTimelineEngine.ts',
  'src/services/playheadBackendSync.ts',
]);

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) continue;
    if (fullPath.endsWith('.test.ts') || fullPath.endsWith('.test.tsx')) continue;
    if (fullPath.endsWith('.spec.ts') || fullPath.endsWith('.spec.tsx')) continue;

    files.push(fullPath);
  }

  return files;
}

function hasDirectSetCurrentTimeCall(content: string, filePath: string): boolean {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true, scriptKind);

  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isCallExpression(node)) {
      const expression = node.expression;

      if (ts.isIdentifier(expression) && expression.text === 'setCurrentTime') {
        found = true;
        return;
      }

      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'setCurrentTime') {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

describe('Playback write path guard', () => {
  it('uses direct setCurrentTime only in allowed core modules', () => {
    const violations: string[] = [];
    const files = collectSourceFiles(SRC_ROOT);

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!hasDirectSetCurrentTimeCall(content, filePath)) {
        continue;
      }

      const normalized = normalizePath(path.relative(process.cwd(), filePath));
      if (!ALLOWED_SET_CURRENT_TIME_CALLERS.has(normalized)) {
        violations.push(normalized);
      }
    }

    expect(violations).toEqual([]);
  });
});

