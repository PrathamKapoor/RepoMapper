import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'var/**', 'data/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
