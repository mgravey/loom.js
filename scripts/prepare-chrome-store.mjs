import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extensionRoot = join(root, 'packages', 'extension-codex-experimental');
const dist = join(extensionRoot, 'dist');
const staging = join(extensionRoot, '.chrome-store-staging');
const artifacts = resolve(
  process.env.LOOM_STORE_ARTIFACTS_DIR?.trim() || join(root, 'store-artifacts'),
);
const defaultSiteOrigin = 'https://mgravey.com';
const defaultSiteBasePath = '/loom.js';
const externallyConnectableMatches = Object.freeze([
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
]);
const supportEmail = process.env.LOOM_SUPPORT_EMAIL?.trim() || 'sideproject@mgravey.com';
const testOriginAllowed = process.env.LOOM_ALLOW_TEST_ORIGIN === '1';

function isPlaceholderHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.invalid')
  );
}

function requiredHttpsUrl(name, options = {}) {
  const raw = process.env[name]?.trim() || options.defaultValue;
  if (!raw) throw new Error(`${name} is required.`);
  const value = new URL(raw);
  if (value.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`);
  if (value.username || value.password || value.hash) {
    throw new Error(`${name} must not contain credentials or a fragment.`);
  }
  if (options.originOnly && (value.pathname !== '/' || value.search)) {
    throw new Error(`${name} must be an exact origin without a path or query.`);
  }
  if (!testOriginAllowed && isPlaceholderHostname(value.hostname)) {
    throw new Error(`${name} must use a deployed public hostname.`);
  }
  return value;
}

function siteBasePath() {
  const raw = process.env.LOOM_SITE_BASE_PATH?.trim() || defaultSiteBasePath;
  const value = `/${raw.replace(/^\/+|\/+$/gu, '')}`;
  if (value === '/' || !/^\/[a-zA-Z0-9._~/-]+$/u.test(value)) {
    throw new Error('LOOM_SITE_BASE_PATH must be a non-root URL path such as /loom.js.');
  }
  return value;
}

function assertEmail(value) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) || value.endsWith('.invalid')) {
    throw new Error('LOOM_SUPPORT_EMAIL must be a deliverable email address.');
  }
}

function pngDimensions(source) {
  const signature = '89504e470d0a1a0a';
  if (
    source.subarray(0, 8).toString('hex') !== signature ||
    source.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('Store icon is not a valid PNG file.');
  }
  return Object.freeze({ width: source.readUInt32BE(16), height: source.readUInt32BE(20) });
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function assertExactStringSet(label, actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== 'string') ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error(`${label} must contain only: ${expected.join(', ')}.`);
  }
}

const site = requiredHttpsUrl('LOOM_SITE_ORIGIN', {
  defaultValue: defaultSiteOrigin,
  originOnly: true,
});
if (site.port !== '') throw new Error('LOOM_SITE_ORIGIN must use the standard HTTPS port.');
const basePath = siteBasePath();
const homepage = requiredHttpsUrl('LOOM_HOMEPAGE_URL', {
  defaultValue: `${site.origin}${basePath}/`,
});
const privacy = requiredHttpsUrl('LOOM_PRIVACY_URL', {
  defaultValue: `${site.origin}${basePath}/privacy.html`,
});
const support = requiredHttpsUrl('LOOM_SUPPORT_URL', {
  defaultValue: `${site.origin}${basePath}/support.html`,
});
if (
  homepage.origin !== site.origin ||
  privacy.origin !== site.origin ||
  support.origin !== site.origin
) {
  throw new Error('Homepage, privacy, and support URLs must use the declared Loom site origin.');
}
assertEmail(supportEmail);
const configuredId = process.env.LOOM_CHROME_EXTENSION_ID?.trim() ?? '';
if (configuredId !== '' && !/^[a-p]{32}$/u.test(configuredId)) {
  throw new Error('LOOM_CHROME_EXTENSION_ID must be a 32-character Chrome extension ID.');
}

const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Store package must use Manifest V3.');
if (manifest.name !== 'Loom.js Companion') {
  throw new Error('Store package must use the reviewed Loom.js Companion name.');
}
if (!/^\d{1,5}(?:\.\d{1,5}){0,3}$/u.test(manifest.version)) {
  throw new Error('Manifest version must contain one to four numeric components.');
}
if (typeof manifest.description !== 'string' || manifest.description.length > 132) {
  throw new Error('Manifest description must be present and no longer than 132 characters.');
}
if (manifest.minimum_chrome_version !== '116') {
  throw new Error('Store package must retain the reviewed minimum Chrome version.');
}
if (manifest.incognito !== 'not_allowed') {
  throw new Error('Store package must remain unavailable in incognito profiles.');
}
assertExactStringSet('Manifest permissions', manifest.permissions, [
  'declarativeNetRequest',
  'storage',
]);
assertExactStringSet('Manifest host permissions', manifest.host_permissions, [
  'http://localhost:1455/*',
  'https://auth.openai.com/*',
  'https://chatgpt.com/backend-api/codex/*',
]);
if (manifest.key !== undefined || manifest.update_url !== undefined) {
  throw new Error('Store package must not embed a development key or custom update URL.');
}
assertExactStringSet(
  'Manifest externally connectable matches',
  manifest.externally_connectable?.matches,
  externallyConnectableMatches,
);
if (
  manifest.background?.service_worker !== 'service-worker.js' ||
  manifest.background?.type !== 'module'
) {
  throw new Error('Store package must use the reviewed module service worker.');
}
const accessible = manifest.web_accessible_resources;
if (
  !Array.isArray(accessible) ||
  accessible.length !== 1 ||
  JSON.stringify(accessible[0]) !==
    JSON.stringify({
      resources: ['callback.html'],
      matches: ['http://localhost:1455/*', 'https://auth.openai.com/*'],
    })
) {
  throw new Error('Store package must expose only the reviewed callback resource and origins.');
}
if (manifest.icons?.['128'] !== 'icons/icon128.png') {
  throw new Error('Manifest must include the required 128px icon.');
}
if (
  manifest.action?.default_title !== 'Loom.js Companion' ||
  JSON.stringify(manifest.action?.default_icon) !==
    JSON.stringify({
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
    })
) {
  throw new Error('Manifest must keep the reviewed always-colored toolbar action.');
}
const requiredIcons = Object.freeze({ 16: 16, 32: 32, 48: 48, 128: 128 });
for (const [key, size] of Object.entries(requiredIcons)) {
  const iconPath = manifest.icons?.[key];
  if (iconPath !== `icons/icon${key}.png`) {
    throw new Error(`Manifest must declare the ${key}px icon at icons/icon${key}.png.`);
  }
  const dimensions = pngDimensions(await readFile(join(dist, iconPath)));
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(`${iconPath} must be exactly ${key}x${key} pixels.`);
  }
}
manifest.homepage_url = homepage.href;

const runtimeFiles = [
  'brand-animation.js',
  'callback.html',
  'callback.js',
  'manifest.json',
  'options.html',
  'options.js',
  'privacy.html',
  'service-worker.js',
  'THIRD_PARTY_NOTICES.txt',
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
    .replaceAll('__LOOM_PUBLIC_SUPPORT_URL__', support.href)
    .replaceAll('__LOOM_SUPPORT_EMAIL__', supportEmail),
);

for (const file of runtimeFiles) {
  const source = await readFile(join(staging, file), 'utf8');
  if (
    source.includes('__LOOM_') ||
    source.includes('REPLACE_') ||
    source.includes('example.invalid')
  ) {
    throw new Error(`${file} contains an unresolved publication placeholder.`);
  }
  if (file.endsWith('.js') && /\b(?:eval|new Function)\s*\(/u.test(source)) {
    throw new Error(`${file} contains a remote-code-sensitive evaluation primitive.`);
  }
  if (
    file.endsWith('.js') &&
    /(?:\bimport\s*\(\s*|\bnew\s+(?:Shared)?Worker\s*\(\s*)["']https?:/u.test(source)
  ) {
    throw new Error(`${file} attempts to load remotely hosted executable code.`);
  }
  if (file.endsWith('.html') && /<script[^>]+(?:src=["']https?:|https?:[^>]*src=)/iu.test(source)) {
    throw new Error(`${file} contains a remotely hosted script.`);
  }
  if (file.endsWith('.html') && /<script(?![^>]*\bsrc=)[^>]*>/iu.test(source)) {
    throw new Error(`${file} contains an inline script.`);
  }
  if (
    (file.endsWith('.js') || file.endsWith('.html')) &&
    /sourceMappingURL|\.map(?:["'?#]|$)/u.test(source)
  ) {
    throw new Error(`${file} contains source-map metadata.`);
  }
}

await mkdir(artifacts, { recursive: true });
const archive = join(artifacts, `loom-js-companion-${manifest.version}.zip`);
await rm(archive, { force: true });
const archiveFiles = [
  ...runtimeFiles,
  ...Object.keys(requiredIcons).map((size) => `icons/icon${size}.png`),
].sort();
// ZIP timestamps are normalized so identical source files and configuration produce identical
// archives. 1980-01-01 is the earliest timestamp representable by the ZIP format.
const zipEpoch = new Date('1980-01-01T00:00:00.000Z');
for (const file of archiveFiles) await utimes(join(staging, file), zipEpoch, zipEpoch);
try {
  execFileSync('zip', ['-X', '-q', archive, ...archiveFiles], {
    cwd: staging,
    env: { ...process.env, TZ: 'UTC' },
  });
} catch (error) {
  throw new Error('Could not create the Store ZIP. Install the standard `zip` command and retry.', {
    cause: error,
  });
}
const archiveInfo = await stat(archive);
if (archiveInfo.size >= 2_000_000_000) throw new Error("Store ZIP exceeds Chrome's 2 GB limit.");
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .sort();
if (JSON.stringify(entries) !== JSON.stringify(archiveFiles)) {
  throw new Error(`Store ZIP inventory mismatch: ${entries.join(', ')}`);
}
const archiveDigest = sha256(await readFile(archive));
await writeFile(
  join(artifacts, 'submission-metadata.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      archive: basename(archive),
      archiveBytes: archiveInfo.size,
      archiveSha256: archiveDigest,
      version: manifest.version,
      siteOrigin: site.origin,
      siteBasePath: basePath,
      homepageUrl: homepage.href,
      privacyPolicyUrl: privacy.href,
      supportUrl: support.href,
      supportEmail,
      chromeExtensionId: configuredId || 'PENDING_FIRST_STORE_UPLOAD',
      externallyConnectable: manifest.externally_connectable.matches,
      files: archiveFiles,
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  join(artifacts, `${basename(archive)}.sha256`),
  `${archiveDigest}  ${basename(archive)}\n`,
);
await rm(staging, { recursive: true, force: true });

console.log(`Chrome Web Store package: ${archive}`);
console.log(`SHA-256: ${archiveDigest}`);
