// This file is the only browser-site value that must change when the extension is published.
// Keep it external to the application bundle so deployment can replace IDs and URLs without a
// TypeScript rebuild. Never place credentials, OAuth codes, or API keys here.
globalThis.LOOM_DEPLOYMENT_CONFIG = Object.freeze({
  environment: 'development',
  chromeExtensionId: 'foofdcgdelahbdgdfgocoeajdodhjbjo',
  chromeWebStoreUrl: 'https://chrome.google.com/webstore/detail/gdcebopdllcifgleoefgbobdopiaholg',
  siteOrigin: 'http://localhost:4173',
  legalName: 'Mathieu Gravey',
  emailContacts: Object.freeze({
    support: 'c2lkZXByb2plY3RAbWdyYXZleS5jb20=',
    security: 'c2lkZXByb2plY3RAbWdyYXZleS5jb20=',
  }),
});
