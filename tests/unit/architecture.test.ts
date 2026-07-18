import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const runtimePackages = [
  'types',
  'plugin-api',
  'core',
  'tool-workspace',
  'agent-codex',
  'coding',
  'execution-browser',
  'model-openai-responses',
  'platform-browser',
  'storage-indexeddb',
  'workspace-fsa',
  'credential-broker-api',
  'credential-provider-api',
  'auth-extension',
  'extension',
  'auth-codex-experimental',
  'extension-codex-experimental',
  'model-codex-experimental',
  'examples',
] as const;

const allowedInternalDependencies: Readonly<
  Record<(typeof runtimePackages)[number], readonly string[]>
> = Object.freeze({
  types: [],
  'plugin-api': ['@loom/types'],
  core: ['@loom/plugin-api', '@loom/types'],
  'tool-workspace': ['@loom/plugin-api', '@loom/types'],
  'agent-codex': ['@loom/plugin-api', '@loom/tool-workspace', '@loom/types'],
  coding: ['@loom/agent-codex', '@loom/plugin-api', '@loom/tool-workspace', '@loom/types'],
  'execution-browser': [],
  'model-openai-responses': ['@loom/agent-codex', '@loom/plugin-api', '@loom/types'],
  'platform-browser': ['@loom/plugin-api', '@loom/types'],
  'storage-indexeddb': ['@loom/plugin-api', '@loom/types'],
  'workspace-fsa': ['@loom/plugin-api', '@loom/tool-workspace', '@loom/types'],
  'credential-broker-api': [],
  'credential-provider-api': [],
  'auth-extension': ['@loom/credential-broker-api', '@loom/plugin-api', '@loom/types'],
  extension: ['@loom/credential-broker-api', '@loom/credential-provider-api'],
  'auth-codex-experimental': ['@loom/credential-provider-api'],
  'extension-codex-experimental': [
    '@loom/auth-codex-experimental',
    '@loom/credential-provider-api',
    '@loom/extension',
  ],
  'model-codex-experimental': ['@loom/agent-codex', '@loom/plugin-api', '@loom/types'],
  examples: ['@loom/agent-codex', '@loom/plugin-api', '@loom/tool-workspace', '@loom/types'],
});

async function sourceFiles(packageName: string): Promise<readonly string[]> {
  const sourceDirectory = join(workspaceRoot, 'packages', packageName, 'src');
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  }

  await visit(sourceDirectory);
  return files.sort();
}

function importsIn(source: string): readonly string[] {
  const imports: string[] = [];
  const pattern = /\b(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) imports.push(specifier);
  }
  return imports;
}

async function packageImports(packageName: string): Promise<readonly string[]> {
  const imports: string[] = [];
  for (const file of await sourceFiles(packageName)) {
    imports.push(...importsIn(await readFile(file, 'utf8')));
  }
  return imports;
}

describe('package architecture', () => {
  it('keeps every package private, ESM-only, and explicitly exported', async () => {
    for (const packageName of runtimePackages) {
      const manifest = JSON.parse(
        await readFile(join(workspaceRoot, 'packages', packageName, 'package.json'), 'utf8'),
      ) as {
        private?: boolean;
        type?: string;
        exports?: { readonly '.': { readonly import?: string; readonly types?: string } };
      };

      expect(manifest.private, packageName).toBe(true);
      expect(manifest.type, packageName).toBe('module');
      expect(manifest.exports?.['.']?.import, packageName).toBe('./dist/index.js');
      expect(manifest.exports?.['.']?.types, packageName).toBe('./dist/index.d.ts');
    }
  });

  it('enforces the internal package dependency direction', async () => {
    for (const packageName of runtimePackages) {
      const allowed = allowedInternalDependencies[packageName];
      const imports = (await packageImports(packageName)).filter((value) =>
        value.startsWith('@loom/'),
      );
      expect(
        imports.filter((value) => !allowed.includes(value)),
        packageName,
      ).toEqual([]);

      const manifest = JSON.parse(
        await readFile(join(workspaceRoot, 'packages', packageName, 'package.json'), 'utf8'),
      ) as { readonly dependencies?: Readonly<Record<string, string>> };
      const dependencies = Object.keys(manifest.dependencies ?? {}).filter((value) =>
        value.startsWith('@loom/'),
      );
      expect(dependencies.sort(), `${packageName} manifest`).toEqual([...allowed].sort());
    }
  });

  it('keeps examples on public package entry points', async () => {
    const imports = await packageImports('examples');
    expect(
      imports.filter((value) => value.startsWith('@loom/') && value.split('/').length > 2),
    ).toEqual([]);
    expect(imports).not.toContain('@loom/core');
  });

  it('keeps the experimental Codex browser example on public package entry points', async () => {
    const imports = await packageImports('example-codex-experimental');
    expect(
      imports.filter((value) => value.startsWith('@loom/') && value.split('/').length > 2),
    ).toEqual([]);
    expect(new Set(imports.filter((value) => value.startsWith('@loom/')))).toEqual(
      new Set([
        '@loom/agent-codex',
        '@loom/auth-extension',
        '@loom/coding',
        '@loom/execution-browser',
        '@loom/model-codex-experimental',
        '@loom/tool-workspace',
        '@loom/types',
        '@loom/workspace-fsa',
      ]),
    );
  });

  it('keeps the browser example on explicit public package dependencies', async () => {
    const allowed = [
      '@loom/agent-codex',
      '@loom/core',
      '@loom/examples',
      '@loom/platform-browser',
      '@loom/storage-indexeddb',
      '@loom/types',
      '@loom/workspace-fsa',
    ];
    const imports = await packageImports('example-browser');
    expect(imports.filter((value) => value.startsWith('node:'))).toEqual([]);
    expect(
      imports.filter((value) => value.startsWith('@loom/') && !allowed.includes(value)),
    ).toEqual([]);

    const manifest = JSON.parse(
      await readFile(join(workspaceRoot, 'packages', 'example-browser', 'package.json'), 'utf8'),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...allowed].sort());
  });

  it('keeps the credential broker example on explicit public package dependencies', async () => {
    const allowed = ['@loom/auth-extension', '@loom/core'];
    const imports = await packageImports('example-extension');
    expect(imports.filter((value) => value.startsWith('node:'))).toEqual([]);
    expect(
      imports.filter((value) => value.startsWith('@loom/') && !allowed.includes(value)),
    ).toEqual([]);

    const manifest = JSON.parse(
      await readFile(join(workspaceRoot, 'packages', 'example-extension', 'package.json'), 'utf8'),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...allowed].sort());
  });

  it('keeps core source provider- and host-neutral', async () => {
    const forbiddenImports = [
      'openai',
      'anthropic',
      '@google/generative-ai',
      'pyodide',
      'quickjs',
      'isomorphic-git',
      'simple-git',
    ];
    const forbiddenIdentifiers = [
      'OpenAI',
      'Codex',
      'Claude',
      'Chrome',
      'Pyodide',
      'QuickJS',
      'FileSystemAccessAPI',
      'window',
      'document',
      'navigator',
      'localStorage',
      'indexedDB',
    ];

    for (const file of await sourceFiles('core')) {
      const source = await readFile(file, 'utf8');
      for (const specifier of importsIn(source)) {
        expect(
          specifier.startsWith('node:') ||
            forbiddenImports.some(
              (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
            ),
          `${file} imports ${specifier}`,
        ).toBe(false);
      }
      for (const identifier of forbiddenIdentifiers) {
        expect(
          new RegExp(`\\b${identifier}\\b`, 'u').test(source),
          `${file} uses ${identifier}`,
        ).toBe(false);
      }
    }
  });

  it('keeps Phase 2 plugins provider- and host-neutral', async () => {
    const forbiddenImports = [
      '@loom/core',
      'openai',
      'anthropic',
      '@google/generative-ai',
      'node:fs',
      'node:path',
    ];
    const forbiddenIdentifiers = [
      'window',
      'document',
      'navigator',
      'fetch',
      'localStorage',
      'indexedDB',
      'FileSystemAccessAPI',
    ];

    for (const packageName of ['tool-workspace', 'agent-codex'] as const) {
      for (const file of await sourceFiles(packageName)) {
        const source = await readFile(file, 'utf8');
        for (const specifier of importsIn(source)) {
          expect(
            forbiddenImports.some(
              (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
            ),
            `${file} imports ${specifier}`,
          ).toBe(false);
        }
        for (const identifier of forbiddenIdentifiers) {
          expect(
            new RegExp(`\\b${identifier}\\b`, 'u').test(source),
            `${file} uses ${identifier}`,
          ).toBe(false);
        }
      }
    }
  });

  it('keeps Phase 3 browser plugins isolated from core and provider implementations', async () => {
    const forbiddenImports = [
      '@loom/core',
      '@loom/agent-codex',
      'openai',
      'anthropic',
      '@google/generative-ai',
      'node:fs',
      'node:path',
    ];

    for (const packageName of ['platform-browser', 'storage-indexeddb', 'workspace-fsa'] as const) {
      for (const file of await sourceFiles(packageName)) {
        const source = await readFile(file, 'utf8');
        for (const specifier of importsIn(source)) {
          expect(
            forbiddenImports.some(
              (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
            ),
            `${file} imports ${specifier}`,
          ).toBe(false);
        }
      }
    }
  });

  it('keeps Phase 4 broker packages isolated from core and concrete providers', async () => {
    const forbiddenImports = [
      '@loom/core',
      '@loom/agent-codex',
      'openai',
      'anthropic',
      '@google/generative-ai',
      'node:fs',
      'node:path',
    ];

    for (const packageName of [
      'credential-broker-api',
      'credential-provider-api',
      'auth-extension',
      'extension',
    ] as const) {
      for (const file of await sourceFiles(packageName)) {
        const source = await readFile(file, 'utf8');
        for (const specifier of importsIn(source)) {
          expect(
            forbiddenImports.some(
              (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
            ),
            `${file} imports ${specifier}`,
          ).toBe(false);
        }
      }
    }
  });

  it('isolates the Phase 5 provider in leaf packages', async () => {
    for (const packageName of [
      'auth-codex-experimental',
      'extension-codex-experimental',
    ] as const) {
      const imports = await packageImports(packageName);
      expect(imports).not.toContain('@loom/core');
      expect(imports).not.toContain('@loom/plugin-api');
      expect(imports).not.toContain('@loom/types');
      expect(imports.filter((value) => value.startsWith('node:'))).toEqual([]);
    }

    const modelImports = await packageImports('model-codex-experimental');
    expect(modelImports).not.toContain('@loom/core');
    expect(modelImports.filter((value) => value.startsWith('node:'))).toEqual([]);

    const platformModelImports = await packageImports('model-openai-responses');
    expect(platformModelImports).not.toContain('@loom/core');
    expect(platformModelImports.filter((value) => value.startsWith('node:'))).toEqual([]);

    for (const packageName of [
      'credential-broker-api',
      'credential-provider-api',
      'extension',
    ] as const) {
      const source = await Promise.all(
        (await sourceFiles(packageName)).map((file) => readFile(file, 'utf8')),
      );
      expect(source.join('\n')).not.toMatch(/\b(?:OpenAI|Codex)\b/u);
    }
  });
});
