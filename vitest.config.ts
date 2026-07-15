import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'tests/unit/**/*.test.ts',
    ],
    exclude: ['tests/browser/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/{types,plugin-api,core,tool-workspace,agent-codex,platform-browser,storage-indexeddb,workspace-fsa,credential-broker-api,auth-extension,extension}/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
