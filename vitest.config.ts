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
        'packages/{types,plugin-api,core,tool-workspace,agent-codex,coding,execution-browser,model-openai-responses,platform-browser,storage-indexeddb,workspace-fsa,credential-broker-api,credential-provider-api,auth-extension,extension,auth-codex-experimental,extension-codex-experimental,model-codex-experimental}/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        'packages/*/src/service-worker.ts',
        'packages/execution-browser/src/**/*.ts',
        'packages/extension-codex-experimental/src/callback.ts',
        'packages/extension-codex-experimental/src/options.ts',
        'packages/model-codex-experimental/src/contracts.ts',
        'packages/model-openai-responses/src/contracts.ts',
        'packages/workspace-fsa/src/adapter.ts',
      ],
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
