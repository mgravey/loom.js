import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const extensionRoot = join(root, 'packages', 'extension-codex-experimental');
const extensionDist = join(extensionRoot, 'dist');
const output = join(extensionRoot, 'store-listing');

function pngDimensions(source) {
  if (
    source.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    source.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('Generated Store media is not a valid PNG file.');
  }
  return Object.freeze({ width: source.readUInt32BE(16), height: source.readUInt32BE(20) });
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

async function recordMedia(path, expectedWidth, expectedHeight, source) {
  const content = await readFile(path);
  const dimensions = pngDimensions(content);
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new Error(
      `${path} must be ${expectedWidth}x${expectedHeight}; received ${dimensions.width}x${dimensions.height}.`,
    );
  }
  return Object.freeze({
    file: path.slice(output.length + 1),
    width: dimensions.width,
    height: dimensions.height,
    sha256: sha256(content),
    source,
  });
}

await mkdir(output, { recursive: true });
const promoPath = join(output, 'promo-small-440x280.png');
const screenshotPath = join(output, 'screenshot-options-1280x800.png');
const logo = await readFile(join(root, 'docs', 'assets', 'brand', 'loom-mark-08.svg'), 'utf8');
const promoBrowser = await chromium.launch({ headless: true });
try {
  const page = await promoBrowser.newPage({ viewport: { width: 440, height: 280 } });
  await page.setContent(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      html, body { width: 440px; height: 280px; margin: 0; overflow: hidden; }
      body {
        position: relative;
        background:
          radial-gradient(circle at 72% 18%, rgba(92, 113, 255, .28), transparent 31%),
          radial-gradient(circle at 20% 82%, rgba(0, 208, 173, .18), transparent 34%),
          linear-gradient(145deg, #101218 0%, #181b25 52%, #101116 100%);
      }
      .grain { position: absolute; inset: 0; opacity: .18; background-image: radial-gradient(#fff 0.45px, transparent 0.45px); background-size: 9px 9px; }
      .orbit { position: absolute; border: 1px solid rgba(255,255,255,.1); border-radius: 999px; transform: rotate(-12deg); }
      .orbit.one { width: 420px; height: 150px; left: 58px; top: 66px; }
      .orbit.two { width: 340px; height: 106px; left: 105px; top: 93px; }
      .panel { position: absolute; width: 68px; height: 48px; right: 50px; top: 55px; border: 1px solid rgba(255,255,255,.14); border-radius: 13px; background: rgba(255,255,255,.055); box-shadow: 0 18px 40px rgba(0,0,0,.24); }
      .panel::before, .panel::after { content: ''; position: absolute; left: 13px; height: 5px; border-radius: 4px; background: rgba(255,255,255,.28); }
      .panel::before { width: 40px; top: 13px; } .panel::after { width: 27px; top: 27px; }
      .panel.second { right: 34px; top: 169px; transform: scale(.82); opacity: .74; }
      .mark { position: absolute; width: 205px; height: 205px; left: 36px; top: 37px; filter: drop-shadow(0 24px 30px rgba(0,0,0,.36)); }
      .mark svg { width: 100%; height: 100%; }
      .bridge { position: absolute; left: 213px; top: 137px; width: 160px; height: 2px; background: linear-gradient(90deg, rgba(121,111,255,.9), rgba(0,208,173,.8)); box-shadow: 0 0 14px rgba(83,136,255,.55); }
      .bridge::after { content: ''; position: absolute; right: -3px; top: -4px; width: 10px; height: 10px; border: 2px solid #49d6bd; border-radius: 50%; background: #131720; }
    </style></head><body>
      <div class="grain"></div><div class="orbit one"></div><div class="orbit two"></div>
      <div class="mark">${logo}</div><div class="bridge"></div><div class="panel"></div><div class="panel second"></div>
    </body></html>`);
  await page.screenshot({ path: promoPath, type: 'png' });
} finally {
  await promoBrowser.close();
}

const profile = await mkdtemp(join(tmpdir(), 'loom-store-media-'));
const extensionContext = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`],
});
try {
  const worker =
    extensionContext.serviceWorkers()[0] ??
    (await extensionContext.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).hostname;
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('#credential-status').waitFor();
  await page.locator('#brand-animation').waitFor();
  await page.screenshot({ path: screenshotPath, type: 'png' });
} finally {
  await extensionContext.close();
  await rm(profile, { recursive: true, force: true });
}

const media = [
  await recordMedia(
    promoPath,
    440,
    280,
    'Existing Loom Direction 08 mark and deterministic CSS composition.',
  ),
  await recordMedia(
    screenshotPath,
    1280,
    800,
    'Actual packaged extension options page rendered from packages/extension-codex-experimental/dist/options.html.',
  ),
];
await writeFile(
  join(output, 'media-manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), media }, null, 2)}\n`,
);
console.log(`Chrome Web Store media: ${output}`);
