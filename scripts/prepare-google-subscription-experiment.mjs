import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const clientId = process.env.LOOM_GOOGLE_OAUTH_CLIENT_ID?.trim();
const publicKey = process.env.LOOM_GOOGLE_EXTENSION_PUBLIC_KEY?.replace(/\s+/gu, '');
if (!clientId || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/u.test(clientId))
  throw new Error('Set LOOM_GOOGLE_OAUTH_CLIENT_ID to your own Chrome Extension OAuth client ID.');
if (!publicKey || !/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKey))
  throw new Error(
    'Set LOOM_GOOGLE_EXTENSION_PUBLIC_KEY to the base64 public key for that extension.',
  );
const key = Buffer.from(publicKey, 'base64');
createPublicKey({ key, format: 'der', type: 'spki' }); // Public key only, never a PEM/private credential.
const extensionId = [...createHash('sha256').update(key).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
  .join('');
const source = join(root, 'packages/extension-codex-experimental/dist');
const destination = join(root, 'store-artifacts/loom-google-subscription-experiment');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
manifest.name = 'Loom.js Companion — Google subscription experiment';
manifest.key = publicKey;
manifest.permissions = [...new Set([...manifest.permissions, 'identity'])];
manifest.oauth2 = {
  client_id: clientId,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
};
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(
  join(destination, 'EXPERIMENT.txt'),
  'Developer-only OAuth experiment. Backend acceptance of independent clients is unverified. Do not publish as supported subscription access.\n',
);
process.stdout.write(
  `Unpacked experiment: ${destination}\nExtension ID: ${extensionId}\nRegister this exact ID with your Google Chrome Extension OAuth client.\n`,
);
