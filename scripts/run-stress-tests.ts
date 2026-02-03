import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

function collectStressTests(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.endsWith('.stress.test.ts') || entry.endsWith('.stress.test.tsx')) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

const stressTests = collectStressTests(join(process.cwd(), 'src'));
if (stressTests.length === 0) {
  // Mirror Vitest's behavior (non-zero exit when no files are found).
  console.error('No stress test files found under src/');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [vitestCli, 'run', ...stressTests],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      VITEST_STRESS: '1',
    },
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
