const configuration = globalThis.LOOM_DEPLOYMENT_CONFIG ?? {};
const storeUrl =
  typeof configuration.chromeWebStoreUrl === 'string' ? configuration.chromeWebStoreUrl.trim() : '';

for (const link of document.querySelectorAll('[data-extension-install]')) {
  if (!(link instanceof HTMLAnchorElement)) continue;
  if (storeUrl !== '') {
    link.href = storeUrl;
    link.textContent = 'Install from Chrome Web Store';
    link.rel = 'noopener noreferrer';
  } else {
    link.href = './install.html';
    link.textContent = 'Install unpacked extension';
  }
}

const legalValues = {
  legalName: configuration.legalName,
  legalAddress: configuration.legalAddress,
  supportEmail: configuration.supportEmail,
  securityEmail: configuration.securityEmail,
};

for (const [name, value] of Object.entries(legalValues)) {
  if (typeof value !== 'string') continue;
  for (const element of document.querySelectorAll(`[data-legal-value="${name}"]`)) {
    element.textContent = value;
    if (element instanceof HTMLAnchorElement && name.endsWith('Email')) {
      element.href = `mailto:${value}`;
    }
  }
}

const hasPlaceholder = Object.values(legalValues).some(
  (value) => typeof value !== 'string' || value.includes('REPLACE_') || value.endsWith('.invalid'),
);
for (const notice of document.querySelectorAll('[data-legal-draft]')) {
  if (notice instanceof HTMLElement) notice.hidden = !hasPlaceholder;
}
