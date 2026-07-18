import { expect, test } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness } from './built-esm-harness.js';

test('runs the interactive browser example with an application-owned directory picker', async ({
  page,
}) => {
  const directoryName = `loom-example-browser-${String(Date.now())}`;
  await page.addInitScript((name) => {
    Object.defineProperty(globalThis, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        try {
          await root.removeEntry(name, { recursive: true });
        } catch {
          // A clean origin has no previous fixture directory.
        }
        const directory = await root.getDirectoryHandle(name, { create: true });
        const source = await directory.getFileHandle('source.txt', { create: true });
        const writable = await source.createWritable();
        await writable.write('hello Loom');
        await writable.close();
        return directory;
      },
    });
  }, directoryName);

  await openBuiltEsmHarness(page);
  await page.goto(`${browserOrigin}/example-browser/index.html`);
  await expect(page.locator('.brand-heading img')).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', './assets/favicon.png');
  await page.getByRole('button', { name: 'Choose directory and run' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Complete. The selected directory now contains result.txt.',
  );
  await expect(page.getByLabel('Agent event log')).toContainText('Agent completed after 4 turns.');

  const result = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name);
    const file = await directory.getFileHandle('result.txt');
    const text = await (await file.getFile()).text();
    await root.removeEntry(name, { recursive: true });
    return text;
  }, directoryName);
  expect(result).toBe('Processed: hello Loom');
});
