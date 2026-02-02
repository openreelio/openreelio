/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visualizer } from 'rollup-plugin-visualizer';

// https://vitejs.dev/config/
const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const isStressRun = process.env.VITEST_STRESS === '1';
  const isCI = process.env.CI === 'true';
  // CI runners (GitHub Actions ubuntu-latest) have ~7GB RAM.
  // Using multiple forks with large heaps causes OOM.
  // Strategy: CI uses single fork with moderate heap, local dev uses 2 forks.
  const vitestMaxForks = Math.max(
    1,
    Number(process.env.VITEST_MAX_FORKS ?? (isCI ? '1' : '2'))
  );
  const vitestMaxOldSpaceSizeMb = Math.max(
    1024,
    Number(process.env.VITEST_MAX_OLD_SPACE_SIZE ?? (isCI ? '3072' : '4096'))
  );
  const analyzePlugins =
    mode === 'analyze'
      ? [
          visualizer({
            filename: 'bundle-stats.html',
            open: true,
            gzipSize: true,
            brotliSize: true,
            template: 'treemap', // 'sunburst', 'treemap', 'network'
          }),
        ]
      : [];

  return {
    plugins: [react(), ...analyzePlugins],
    resolve: {
      alias: {
        '@': resolve(rootDir, 'src'),
      },
    },
    // Vitest configuration
    test: {
      globals: true,
      // Use happy-dom in CI (5-10x faster, much lower memory), jsdom locally for compatibility
      environment: isCI ? 'happy-dom' : 'jsdom',
      pool: 'forks',
      // Ensure each test file has an isolated module graph so long-running runs
      // don't retain module-level caches indefinitely.
      isolate: true,
      // Disable file parallelism in CI to reduce memory pressure
      fileParallelism: !isCI,
      // Run tests sequentially in CI to prevent memory accumulation
      sequence: {
        concurrent: !isCI,
      },
      // Aggressively clean up mocks to prevent memory leaks
      restoreMocks: true,
      clearMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
      // Timeout settings to prevent CI hangs
      testTimeout: 30000, // 30 seconds per test
      hookTimeout: 30000, // 30 seconds for hooks
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
      // Large test suites can exceed the default Node heap
      // when executed with many parallel workers.
      poolOptions: {
        forks: {
          minForks: 1,
          maxForks: vitestMaxForks,
          execArgv: [`--max-old-space-size=${vitestMaxOldSpaceSizeMb}`],
        },
      },
      exclude: isStressRun
        ? ['src/**/*.bench.test.{ts,tsx}']
        : ['src/**/*.bench.test.{ts,tsx}', 'src/**/*.stress.test.{ts,tsx}'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**/*'],
      },
    },
    // Vite options tailored for Tauri development
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      // Tauri uses Chromium on Windows and WebKit on macOS and Linux
      target:
        process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
      // Don't minify for debug builds
      minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
      // Produce sourcemaps for debug builds
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
      // Rollup options for better bundle analysis
      rollupOptions: {
        output: {
          manualChunks: {
            // Split vendor chunks for better caching
            vendor: ['react', 'react-dom', 'react-router-dom'],
            state: ['zustand', 'immer'],
            icons: ['lucide-react'],
          },
        },
      },
    },
  };
});
