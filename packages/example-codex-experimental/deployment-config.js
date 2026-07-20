// This file is the only browser-site value that must change when the extension is published.
// Keep it external to the application bundle so deployment can replace IDs and URLs without a
// TypeScript rebuild. Never place credentials, OAuth codes, or API keys here.
globalThis.LOOM_DEPLOYMENT_CONFIG = Object.freeze({
  environment: 'development',
  chromeExtensionId: 'foofdcgdelahbdgdfgocoeajdodhjbjo',
  chromeWebStoreUrl: '',
  siteOrigin: 'http://localhost:4173',
  legalName: 'Mathieu Gravey',
  supportEmail: 'sideproject@mgravey.com',
  securityEmail: 'sideproject@mgravey.com',
});
