/**
 * Playback Duration Guard
 *
 * Architecture rule:
 * - `playbackStore.setDuration(...)` must only be called from playback-core modules.
 * - In editor mode the TimelineEngine (via useTimelineEngine) is the single authority
 *   for duration, so no other component may compete with it.
 * - UI / feature layers read `duration` from the store but never write it.
 *
 * Rationale:
 * Competing setDuration writers (e.g. EditorView, ProxyPreviewPlayer) previously
 * overwrote the padded duration from useTimelineEngine with a raw value, causing
 * the SeekBar and Timeline playhead to reference different time ranges and breaking
 * bidirectional position sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

/**
 * Modules that are permitted to call `setDuration(...)` on the playback store.
 * All other source files must only READ duration from the store.
 */
const ALLOWED_SET_DURATION_CALLERS = new Set([
  // Core playback infrastructure
  'src/stores/playbackStore.ts',
  'src/core/TimelineEngine.ts',
  'src/hooks/useTimelineEngine.ts',
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

/**
 * Detects calls to `setDuration(...)` that target the playback store.
 *
 * Matches:
 *   - `setDuration(value)`         (destructured from usePlaybackStore)
 *   - `something.setDuration(value)` (property access on store)
 *
 * Does NOT match (excluded patterns):
 *   - `useState` setters named `setDuration` (local component state)
 *   - Store definition files that declare the method
 */
function hasPlaybackSetDurationCall(content: string, filePath: string): boolean {
  // Quick pre-check: if the file doesn't even mention setDuration, skip AST parsing
  if (!content.includes('setDuration')) return false;

  // Exclude files that use a LOCAL useState-based setDuration.
  // These are component-internal state setters, not playback store writes.
  // Heuristic: if the file contains `useState` and destructures `setDuration` from it,
  // it is likely local state. But we need more precise detection via AST.

  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true, scriptKind);

  let found = false;

  // Track whether setDuration is destructured from usePlaybackStore
  let isFromPlaybackStore = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    // Detect: const { ..., setDuration, ... } = usePlaybackStore(...)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'usePlaybackStore'
      ) {
        if (node.name && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (ts.isBindingElement(element)) {
              const name = element.propertyName ?? element.name;
              if (ts.isIdentifier(name) && name.text === 'setDuration') {
                isFromPlaybackStore = true;
              }
            }
          }
        }
      }
    }

    // Detect: const setDuration = usePlaybackStore((state) => state.setDuration)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && node.name.text === 'setDuration') {
        if (ts.isCallExpression(node.initializer)) {
          const callee = node.initializer.expression;
          if (ts.isIdentifier(callee) && callee.text === 'usePlaybackStore') {
            isFromPlaybackStore = true;
          }
        }
      }
    }

    // If we confirmed setDuration comes from playback store, look for calls
    if (isFromPlaybackStore && ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'setDuration') {
        found = true;
        return;
      }
    }

    // Also detect property access: store.setDuration(...) or playbackStore.setDuration(...)
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === 'setDuration'
      ) {
        const objText = expr.expression.getText(sourceFile);
        if (
          objText.includes('playback') ||
          objText.includes('Playback') ||
          objText === 'store'
        ) {
          found = true;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

describe('Playback duration guard', () => {
  it('calls playbackStore.setDuration only from allowed core modules', () => {
    const violations: string[] = [];
    const files = collectSourceFiles(SRC_ROOT);

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!hasPlaybackSetDurationCall(content, filePath)) {
        continue;
      }

      const normalized = normalizePath(path.relative(process.cwd(), filePath));
      if (!ALLOWED_SET_DURATION_CALLERS.has(normalized)) {
        violations.push(normalized);
      }
    }

    expect(violations).toEqual([]);
  });
});
