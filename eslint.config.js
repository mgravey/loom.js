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
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.js', '**/*.config.ts'],
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
