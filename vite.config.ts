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
  const vitestMaxThreads = Math.max(
    1,
    Number(process.env.VITEST_MAX_THREADS ?? '2')
  );
  const vitestMaxOldSpaceSizeMb = Math.max(
    1024,
    Number(process.env.VITEST_MAX_OLD_SPACE_SIZE ?? '4096')
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
      environment: 'jsdom',
      pool: 'forks',
      // Ensure each test file has an isolated module graph so long-running runs
      // don't retain module-level caches indefinitely.
      isolate: true,
      // Timeout settings to prevent CI hangs
      testTimeout: 30000, // 30 seconds per test
      hookTimeout: 30000, // 30 seconds for hooks
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
      // Large jsdom-heavy test suites can exceed the default Node heap
      // when executed with many parallel workers. Keep the default conservative
      // and allow overriding via VITEST_MAX_THREADS.
      poolOptions: {
        forks: {
          minForks: 1,
          maxForks: vitestMaxThreads,
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
