import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = join(repositoryRoot, 'packages');
const rootLicense = await readFile(join(repositoryRoot, 'LICENSE'), 'utf8');
const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDirectory, entry.name));

const manifests = [];
for (const packageDirectory of packageDirectories) {
  try {
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
    manifests.push({ directory: packageDirectory, manifest });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const publicPackages = manifests.filter(({ manifest }) => manifest.private !== true);
const publicNames = new Set(publicPackages.map(({ manifest }) => manifest.name));
const failures = [];

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

for (const { directory, manifest } of publicPackages) {
  const label = manifest.name ?? relative(repositoryRoot, directory);
  requireCondition(
    typeof manifest.name === 'string' && manifest.name.startsWith('@mgravey/loom-'),
    `${label}: public names must start with @mgravey/loom-.`,
  );
  requireCondition(manifest.license === 'MPL-2.0', `${label}: license must be MPL-2.0.`);
  requireCondition(
    manifest.type === 'module',
    `${label}: only the ESM package format is supported.`,
  );
  requireCondition(
    manifest.exports?.['.']?.import === './dist/index.js',
    `${label}: missing ESM export.`,
  );
  requireCondition(
    manifest.exports?.['.']?.types === './dist/index.d.ts',
    `${label}: missing declaration export.`,
  );
  requireCondition(manifest.publishConfig?.access === 'public', `${label}: access must be public.`);
  requireCondition(
    manifest.publishConfig?.provenance === true,
    `${label}: npm provenance must be enabled.`,
  );
  requireCondition(
    manifest.repository?.url === 'git+https://github.com/mgravey/loom.js.git',
    `${label}: repository URL is missing or incorrect.`,
  );
  requireCondition(
    manifest.repository?.directory === relative(repositoryRoot, directory),
    `${label}: repository.directory is missing or incorrect.`,
  );
  requireCondition(
    manifest.scripts?.prepack === 'pnpm run build && node ../../scripts/prepare-package.mjs',
    `${label}: safe prepack build is missing.`,
  );

  for (const [dependencyName, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependencyName.startsWith('@mgravey/loom-')) continue;
    requireCondition(
      publicNames.has(dependencyName),
      `${label}: public package depends on private package ${dependencyName}.`,
    );
    requireCondition(range === 'workspace:^', `${label}: ${dependencyName} must use workspace:^.`);
  }

  for (const filename of ['README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
    try {
      await access(join(directory, filename));
    } catch {
      failures.push(`${label}: missing ${filename}.`);
    }
  }

  try {
    const packageLicense = await readFile(join(directory, 'LICENSE'), 'utf8');
    requireCondition(
      packageLicense === rootLicense,
      `${label}: LICENSE differs from the root license.`,
    );
  } catch {
    // The missing file is reported above.
  }
}

for (const { manifest } of manifests.filter(({ manifest }) => manifest.private === true)) {
  requireCondition(
    manifest.publishConfig?.access !== 'public',
    `${manifest.name}: private packages must not have public publishConfig.`,
  );
}

requireCondition(publicPackages.length > 0, 'No public packages were found.');
requireCondition(
  publicNames.size === publicPackages.length,
  'Public package names must be unique.',
);

if (failures.length > 0) {
  throw new Error(`Public package verification failed:\n- ${failures.join('\n- ')}`);
}

process.stdout.write(
  `Verified ${publicPackages.length} public packages:\n${[...publicNames]
    .sort()
    .map((name) => `- ${name}`)
    .join('\n')}\n`,
);
