import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = join(repositoryRoot, 'packages');
const artifactsDirectory = join(repositoryRoot, 'release-artifacts');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${String(result.status)}.`);
  }
  return result;
}

run(process.execPath, [join(repositoryRoot, 'scripts/verify-public-packages.mjs')], {
  stdio: 'inherit',
});
await mkdir(artifactsDirectory, { recursive: true });

const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
const publicPackages = [];
for (const entry of packageEntries) {
  if (!entry.isDirectory()) continue;
  const directory = join(packagesDirectory, entry.name);
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.private !== true) publicPackages.push({ directory, manifest });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

publicPackages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));

for (const { directory, manifest } of publicPackages) {
  process.stdout.write(`Packing ${manifest.name}@${manifest.version}...\n`);
  run('pnpm', ['pack', '--pack-destination', artifactsDirectory], {
    cwd: directory,
    stdio: 'inherit',
  });
}

const artifactNames = (await readdir(artifactsDirectory))
  .filter((name) => name.endsWith('.tgz'))
  .sort();
if (artifactNames.length < publicPackages.length) {
  throw new Error(
    `Expected at least ${publicPackages.length} tarballs, found ${artifactNames.length}.`,
  );
}

const smokeDirectory = await mkdtemp(join(tmpdir(), 'loom-package-smoke-'));
await writeFile(
  join(smokeDirectory, 'package.json'),
  `${JSON.stringify({ name: 'loom-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
);

const expectedArtifacts = publicPackages.map(({ manifest }) => {
  const unscopedName = manifest.name.replace(/^@/, '').replace('/', '-');
  return join(artifactsDirectory, `${unscopedName}-${manifest.version}.tgz`);
});

run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...expectedArtifacts], {
  cwd: smokeDirectory,
  stdio: 'inherit',
});

const imports = publicPackages
  .map(({ manifest }) => `await import('${manifest.name}');`)
  .join('\n');
await writeFile(join(smokeDirectory, 'smoke.mjs'), `${imports}\n`);
run(process.execPath, ['smoke.mjs'], { cwd: smokeDirectory, stdio: 'inherit' });

process.stdout.write(
  `Packed and smoke-tested ${publicPackages.length} packages in ${basename(artifactsDirectory)}.\n`,
);
