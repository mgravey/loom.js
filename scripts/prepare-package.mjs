import { access, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageDirectory = process.cwd();
const manifestPath = resolve(packageDirectory, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.private === true) {
  throw new Error(`Refusing to prepare private package ${manifest.name ?? packageDirectory}.`);
}

if (!String(manifest.name).startsWith('@mgravey/loom-')) {
  throw new Error(`Unexpected public package name: ${String(manifest.name)}.`);
}

await Promise.all([
  access(resolve(packageDirectory, 'README.md')),
  access(resolve(packageDirectory, 'LICENSE')),
  access(resolve(packageDirectory, 'dist/index.js')),
  access(resolve(packageDirectory, 'dist/index.d.ts')),
]);

await rm(resolve(packageDirectory, 'dist/.tsbuildinfo'), { force: true });

process.stdout.write(`Prepared ${manifest.name} for packing.\n`);
