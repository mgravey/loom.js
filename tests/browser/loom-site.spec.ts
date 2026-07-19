import { expect, test } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness } from './built-esm-harness.js';

test('presents Loom as a library before linking to the experimental workbench', async ({
  page,
}) => {
  await openBuiltEsmHarness(page);
  await page.goto(`${browserOrigin}/example-codex-experimental/`);

  await expect(page).toHaveTitle(/Loom\.js/u);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', './assets/favicon.png');
  await expect(page.locator('#hero-brand-animation')).toHaveClass(/\bis-animated\b/u);
  await expect(page.locator('#hero-brand-animation svg')).toBeVisible();
  await expect(page.locator('.brand-mark').first()).toHaveCSS(
    'background-image',
    /loom-mark-compact\.png/u,
  );
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Weave coding agents into your application.',
  );
  await expect(page.getByText('The library', { exact: true })).toBeVisible();
  await expect(page.getByText('The example', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Install unpacked extension' })).toHaveAttribute(
    'href',
    './install.html',
  );

  await page.getByRole('link', { name: 'Start building' }).click();
  await expect(page).toHaveURL(/docs\.html#start$/u);
  await expect(page.getByRole('heading', { name: '1. Prepare the repository' })).toBeVisible();

  await page.getByRole('link', { name: 'Open workbench' }).click();
  await expect(page).toHaveURL(/workbench\.html$/u);
  await expect(page.getByRole('heading', { name: 'Coding conversation' })).toBeVisible();
  await expect(page.getByText('Experimental coding workbench', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Experimental extension ID')).toHaveValue(
    'foofdcgdelahbdgdfgocoeajdodhjbjo',
  );
});

test('serves installation, privacy, terms, legal, and support surfaces', async ({ page }) => {
  await openBuiltEsmHarness(page);

  for (const [path, heading] of [
    ['install.html', 'Install the secure model bridge'],
    ['privacy.html', 'Privacy policy'],
    ['terms.html', 'Terms of use'],
    ['legal.html', 'Legal notice'],
    ['support.html', 'Support'],
  ] as const) {
    await page.goto(`${browserOrigin}/example-codex-experimental/${path}`);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('.brand-mark').first()).toHaveCSS(
      'background-image',
      /loom-mark-compact\.png/u,
    );
  }

  await page.goto(`${browserOrigin}/example-codex-experimental/privacy.html`);
  await expect(page.getByText('Draft—not ready for public submission')).toBeVisible();
  await expect(page.getByText('Chrome Web Store Limited Use')).toBeVisible();
});
