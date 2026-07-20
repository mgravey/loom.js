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
};

for (const [name, value] of Object.entries(legalValues)) {
  if (typeof value !== 'string') continue;
  for (const element of document.querySelectorAll(`[data-legal-value="${name}"]`)) {
    element.textContent = value;
  }
}

function decodedEmail(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const email = globalThis.atob(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

const encodedContacts = configuration.emailContacts;
for (const element of document.querySelectorAll('[data-email-contact]')) {
  if (!(element instanceof HTMLAnchorElement)) continue;
  const contact = element.dataset.emailContact;
  const encoded =
    typeof encodedContacts === 'object' && encodedContacts !== null && contact !== undefined
      ? encodedContacts[contact]
      : undefined;
  const email = decodedEmail(encoded);
  if (email === undefined) {
    element.removeAttribute('href');
    continue;
  }
  element.addEventListener(
    'click',
    () => {
      element.href = `mailto:${email}`;
    },
    { once: true },
  );
}
