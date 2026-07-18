import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
process.env.LOOM_SITE_ORIGIN = 'https://store-verification.loom.example';
process.env.LOOM_PRIVACY_URL = `${process.env.LOOM_SITE_ORIGIN}/privacy.html`;
process.env.LOOM_SUPPORT_URL = `${process.env.LOOM_SITE_ORIGIN}/support.html`;
delete process.env.LOOM_CHROME_EXTENSION_ID;

await import('./prepare-chrome-store.mjs');

const metadata = JSON.parse(
  await readFile(join(root, 'store-artifacts', 'submission-metadata.json'), 'utf8'),
);
const archive = join(root, 'store-artifacts', metadata.archive);
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
const allowedEntries = new Set([
  'brand-animation.js',
  'callback.html',
  'callback.js',
  'manifest.json',
  'options.html',
  'options.js',
  'privacy.html',
  'service-worker.js',
  'icons/',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
]);
if (entries.some((entry) => !allowedEntries.has(entry))) {
  throw new Error(`Store archive contains an unexpected file: ${entries.join(', ')}`);
}
if (!entries.includes('manifest.json')) throw new Error('Store archive is missing root manifest.');

const manifest = JSON.parse(
  execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }),
);
const expectedOrigin = 'https://store-verification.loom.example';
if (manifest.externally_connectable?.matches?.[0] !== `${expectedOrigin}/*`) {
  throw new Error('Store manifest does not contain the exact verification origin.');
}
if (manifest.homepage_url !== expectedOrigin) {
  throw new Error('Store manifest homepage was not configured.');
}

const privacy = execFileSync('unzip', ['-p', archive, 'privacy.html'], { encoding: 'utf8' });
if (privacy.includes('__LOOM_') || privacy.includes('example.invalid')) {
  throw new Error('Store privacy disclosure contains an unresolved placeholder.');
}

console.log(`Verified Chrome Web Store archive: ${archive}`);
