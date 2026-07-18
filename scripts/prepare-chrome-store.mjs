import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extensionRoot = join(root, 'packages', 'extension-codex-experimental');
const dist = join(extensionRoot, 'dist');
const staging = join(extensionRoot, '.chrome-store-staging');
const artifacts = join(root, 'store-artifacts');

function requiredHttpsUrl(name, options = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is required.`);
  const value = new URL(raw);
  if (value.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`);
  if (value.username || value.password || value.hash) {
    throw new Error(`${name} must not contain credentials or a fragment.`);
  }
  if (options.originOnly && (value.pathname !== '/' || value.search)) {
    throw new Error(`${name} must be an exact origin without a path or query.`);
  }
  return value;
}

const site = requiredHttpsUrl('LOOM_SITE_ORIGIN', { originOnly: true });
if (site.port !== '') throw new Error('LOOM_SITE_ORIGIN must use the standard HTTPS port.');
const privacy = requiredHttpsUrl('LOOM_PRIVACY_URL');
const support = requiredHttpsUrl('LOOM_SUPPORT_URL');
const configuredId = process.env.LOOM_CHROME_EXTENSION_ID?.trim() ?? '';
if (configuredId !== '' && !/^[a-p]{32}$/u.test(configuredId)) {
  throw new Error('LOOM_CHROME_EXTENSION_ID must be a 32-character Chrome extension ID.');
}

const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Store package must use Manifest V3.');
if (typeof manifest.description !== 'string' || manifest.description.length > 132) {
  throw new Error('Manifest description must be present and no longer than 132 characters.');
}
if (manifest.icons?.['128'] !== 'icons/icon128.png') {
  throw new Error('Manifest must include the required 128px icon.');
}
manifest.externally_connectable = { matches: [`${site.origin}/*`] };
manifest.homepage_url = site.origin;

const runtimeFiles = [
  'brand-animation.js',
  'callback.html',
  'callback.js',
  'manifest.json',
  'options.html',
  'options.js',
  'privacy.html',
  'service-worker.js',
];

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const file of runtimeFiles) {
  if (file === 'manifest.json') continue;
  await cp(join(dist, file), join(staging, file));
}
await cp(join(dist, 'icons'), join(staging, 'icons'), { recursive: true });
await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const privacyPath = join(staging, 'privacy.html');
const privacyPage = await readFile(privacyPath, 'utf8');
await writeFile(
  privacyPath,
  privacyPage
    .replaceAll('__LOOM_PUBLIC_PRIVACY_URL__', privacy.href)
    .replaceAll('__LOOM_PUBLIC_SUPPORT_URL__', support.href),
);

for (const file of runtimeFiles.filter(
  (value) => value.endsWith('.js') || value.endsWith('.html'),
)) {
  const source = await readFile(join(staging, file), 'utf8');
  if (source.includes('__LOOM_') || source.includes('example.invalid')) {
    throw new Error(`${file} contains an unresolved publication placeholder.`);
  }
  if (file.endsWith('.js') && /\b(?:eval|new Function)\s*\(/u.test(source)) {
    throw new Error(`${file} contains a remote-code-sensitive evaluation primitive.`);
  }
  if (file.endsWith('.html') && /<script[^>]+(?:src=["']https?:|https?:[^>]*src=)/iu.test(source)) {
    throw new Error(`${file} contains a remotely hosted script.`);
  }
  if (file.endsWith('.html') && /<script(?![^>]*\bsrc=)[^>]*>/iu.test(source)) {
    throw new Error(`${file} contains an inline script.`);
  }
}

await mkdir(artifacts, { recursive: true });
const archive = join(artifacts, `loom-secure-model-bridge-${manifest.version}.zip`);
await rm(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, ...runtimeFiles, 'icons'], { cwd: staging });
await writeFile(
  join(artifacts, 'submission-metadata.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      archive: basename(archive),
      version: manifest.version,
      siteOrigin: site.origin,
      privacyPolicyUrl: privacy.href,
      supportUrl: support.href,
      chromeExtensionId: configuredId || 'PENDING_FIRST_STORE_UPLOAD',
      externallyConnectable: manifest.externally_connectable.matches,
    },
    null,
    2,
  )}\n`,
);
await rm(staging, { recursive: true, force: true });

console.log(`Chrome Web Store package: ${archive}`);
