import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const artifacts = await mkdtemp(join(tmpdir(), 'loom-chrome-store-verify-'));
process.env.LOOM_SITE_ORIGIN = 'https://store-verification.loom.example';
process.env.LOOM_SITE_BASE_PATH = '/loom.js';
process.env.LOOM_STORE_ARTIFACTS_DIR = artifacts;
delete process.env.LOOM_HOMEPAGE_URL;
delete process.env.LOOM_PRIVACY_URL;
delete process.env.LOOM_SUPPORT_URL;
process.env.LOOM_SUPPORT_EMAIL = 'sideproject@mgravey.com';
process.env.LOOM_ALLOW_TEST_ORIGIN = '1';
delete process.env.LOOM_CHROME_EXTENSION_ID;

await import('./prepare-chrome-store.mjs');

const metadata = JSON.parse(await readFile(join(artifacts, 'submission-metadata.json'), 'utf8'));
const archive = join(artifacts, metadata.archive);
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
  'THIRD_PARTY_NOTICES.txt',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
]);
if (entries.some((entry) => !allowedEntries.has(entry))) {
  throw new Error(`Store archive contains an unexpected file: ${entries.join(', ')}`);
}
if (!entries.includes('manifest.json')) throw new Error('Store archive is missing root manifest.');
if (!entries.includes('THIRD_PARTY_NOTICES.txt')) {
  throw new Error('Store archive is missing third-party license notices.');
}

const manifest = JSON.parse(
  execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }),
);
const expectedOrigin = 'https://store-verification.loom.example';
const expectedMatches = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'].sort();
if (
  !Array.isArray(manifest.externally_connectable?.matches) ||
  JSON.stringify([...manifest.externally_connectable.matches].sort()) !==
    JSON.stringify(expectedMatches)
) {
  throw new Error('Store manifest does not contain the reviewed external routing patterns.');
}
if (
  manifest.action?.default_title !== 'Loom.js Companion' ||
  manifest.action?.default_icon?.['16'] !== 'icons/icon16.png' ||
  manifest.action?.default_icon?.['32'] !== 'icons/icon32.png'
) {
  throw new Error('Store manifest does not contain the reviewed colored toolbar action.');
}
if (manifest.homepage_url !== `${expectedOrigin}/loom.js/`) {
  throw new Error('Store manifest homepage was not configured.');
}

const privacy = execFileSync('unzip', ['-p', archive, 'privacy.html'], { encoding: 'utf8' });
if (privacy.includes('__LOOM_') || privacy.includes('example.invalid')) {
  throw new Error('Store privacy disclosure contains an unresolved placeholder.');
}
if (!privacy.includes('sideproject@mgravey.com')) {
  throw new Error('Store privacy disclosure is missing the configured support email.');
}
if (!/^[a-f0-9]{64}$/u.test(metadata.archiveSha256)) {
  throw new Error('Store metadata is missing the archive SHA-256 digest.');
}

console.log(`Verified Chrome Web Store archive: ${archive}`);
await rm(artifacts, { recursive: true, force: true });
