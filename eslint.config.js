import eslint from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['packages/*/src/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      'scripts/after-effects/*.jsx',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', prefer: 'type-imports' },
      ],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      'import-x/no-cycle': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/no-relative-packages': 'error',
      'import-x/no-self-import': 'error',
    },
  },
  {
    files: sourceFiles,
    rules: {
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'fetch',
        'crypto',
        'Worker',
        'WebSocket',
        'localStorage',
        'indexedDB',
        'chrome',
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Published runtime source must remain browser-compatible and Node-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/types/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', 'node:*'],
              message: '@loom/types is dependency-free and environment-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/plugin-api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', '!@loom/types', 'node:*'],
              message: '@loom/plugin-api may depend only on @loom/types.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/types',
                '!@loom/plugin-api',
                '@openai/*',
                '@anthropic-ai/*',
                '@google/generative-ai',
                'openai',
                'anthropic',
                'pyodide',
                'quickjs*',
                'git',
                'git/*',
                'isomorphic-git',
                'simple-git',
                'node:*',
              ],
              message: '@loom/core may depend only on @loom/types and @loom/plugin-api.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Identifier[name=/^(OpenAI|Codex|Claude|Chrome|Pyodide|QuickJS|Git|FileSystemAccessAPI)$/i]',
          message: 'Core identifiers must be provider- and environment-neutral.',
        },
      ],
    },
  },
  {
    files: ['packages/tool-workspace/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', '!@loom/types', '!@loom/plugin-api', 'node:*'],
              message: '@loom/tool-workspace may depend only on @loom/types and @loom/plugin-api.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/agent-codex/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/types',
                '!@loom/plugin-api',
                '!@loom/tool-workspace',
                'node:*',
              ],
              message: '@loom/agent-codex may depend only on Loom contracts and workspace tools.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/platform-browser/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', '!@loom/types', '!@loom/plugin-api', 'node:*'],
              message: '@loom/platform-browser may depend only on Loom public contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/storage-indexeddb/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', '!@loom/types', '!@loom/plugin-api', 'node:*'],
              message: '@loom/storage-indexeddb may depend only on Loom public contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/workspace-fsa/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/types',
                '!@loom/plugin-api',
                '!@loom/tool-workspace',
                'node:*',
              ],
              message: '@loom/workspace-fsa may depend only on Loom workspace contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/credential-broker-api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', 'node:*'],
              message: 'The credential broker protocol is dependency- and host-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/credential-provider-api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', 'node:*'],
              message: 'The credential provider SPI is dependency- and host-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/auth-extension/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/types',
                '!@loom/plugin-api',
                '!@loom/credential-broker-api',
                'node:*',
              ],
              message: 'The extension auth adapter may depend only on public Loom contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/extension/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/credential-broker-api',
                '!@loom/credential-provider-api',
                'node:*',
              ],
              message: 'The credential broker extension may depend only on public credential APIs.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/auth-codex-experimental/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*', '!@loom/credential-provider-api', 'node:*'],
              message: 'The Codex auth experiment may depend only on the provider SPI.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/model-openai-responses/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/agent-codex',
                '!@loom/plugin-api',
                '!@loom/types',
                'node:*',
              ],
              message: 'The OpenAI Responses adapter may depend only on public agent contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/model-codex-experimental/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/agent-codex',
                '!@loom/plugin-api',
                '!@loom/types',
                'node:*',
              ],
              message: 'The experimental model adapter may depend only on public agent contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/extension-codex-experimental/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@loom/*',
                '!@loom/auth-codex-experimental',
                '!@loom/credential-provider-api',
                '!@loom/extension',
                'node:*',
              ],
              message: 'The experimental extension is a leaf composition over public APIs.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/examples/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@loom/*/*', 'node:*'],
              message: 'Examples must use public Loom package exports only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['packages/example-codex-experimental/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      '**/*.config.ts',
      '**/*.test.ts',
      '**/*.spec.ts',
      'packages/*/test/**/*.ts',
      'tests/**/*.ts',
    ],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
);
