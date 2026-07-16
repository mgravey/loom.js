import {
  createChromeRefreshCredentialStore,
  initializeTrustedCredentialStorage,
} from '@loom/extension';

import type { BrowserCrypto, CodexChromeExtensionApi, OAuthFetch } from './chrome-contracts.js';
import { createCodexAccountRoutingStore } from './account-routing.js';
import { CODEX_EXPERIMENTAL_CONFIGURATION } from './composition.js';
import { runManualDeviceAuthorization } from './manual-authorization.js';
import { createCodexExperimentSettings } from './settings.js';

function requiredElement<T extends Element>(root: Document, id: string): T {
  const element = root.querySelector(`#${id}`);
  if (element === null) throw new Error(`Options page is missing #${id}.`);
  return element as T;
}

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi;
  readonly crypto: BrowserCrypto;
  readonly document: Document;
  readonly fetch: OAuthFetch;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
};
const storage = host.chrome.storage.local;
const settings = createCodexExperimentSettings(storage);
const credentialStore = createChromeRefreshCredentialStore(storage);
const accountRoutingStore = createCodexAccountRoutingStore(storage);
const ready = initializeTrustedCredentialStorage(storage, () => Promise.resolve());
const enabled = requiredElement<HTMLInputElement>(host.document, 'enabled');
const authorize = requiredElement<HTMLButtonElement>(host.document, 'authorize');
const logout = requiredElement<HTMLButtonElement>(host.document, 'logout');
const challenge = requiredElement<HTMLElement>(host.document, 'challenge');
const verificationUrl = requiredElement<HTMLAnchorElement>(host.document, 'verification-url');
const userCode = requiredElement<HTMLElement>(host.document, 'user-code');
const credentialStatus = requiredElement<HTMLElement>(host.document, 'credential-status');
const status = requiredElement<HTMLElement>(host.document, 'status');

function clearChallenge(): void {
  challenge.hidden = true;
  verificationUrl.removeAttribute('href');
  verificationUrl.textContent = '';
  userCode.textContent = '';
}

async function refreshCredentialStatus(): Promise<void> {
  const credential = await credentialStore.get(CODEX_EXPERIMENTAL_CONFIGURATION.providerId);
  const authenticated = credential !== undefined;
  logout.disabled = !authenticated;
  credentialStatus.textContent = authenticated
    ? 'Authenticated. A refresh credential is stored inside the extension.'
    : 'Not authenticated. No refresh credential is stored.';
}

async function initialize(): Promise<void> {
  await ready;
  enabled.checked = await settings.isDeviceAuthorizationEnabled();
  authorize.disabled = !enabled.checked;
  await refreshCredentialStatus();
  status.textContent = enabled.checked
    ? 'The experiment is enabled. Authorization still requires the button below.'
    : 'The experiment is disabled.';
}

enabled.addEventListener('change', () => {
  void (async () => {
    await settings.setDeviceAuthorizationEnabled(enabled.checked);
    authorize.disabled = !enabled.checked;
    clearChallenge();
    if (!enabled.checked) {
      await credentialStore.delete(CODEX_EXPERIMENTAL_CONFIGURATION.providerId);
      await accountRoutingStore.delete();
      await refreshCredentialStatus();
      status.textContent = 'The experiment is disabled and its refresh credential was removed.';
    } else {
      status.textContent = 'Enabled. Select Start device authorization to continue.';
    }
  })().catch(() => {
    enabled.checked = false;
    authorize.disabled = true;
    status.textContent = 'The trusted extension settings could not be updated.';
  });
});

logout.addEventListener('click', () => {
  logout.disabled = true;
  void credentialStore
    .delete(CODEX_EXPERIMENTAL_CONFIGURATION.providerId)
    .then(() => accountRoutingStore.delete())
    .then(refreshCredentialStatus)
    .then(() => {
      status.textContent = 'Stored authorization was removed.';
    })
    .catch(() => {
      status.textContent = 'Stored authorization could not be removed.';
    });
});

authorize.addEventListener('click', () => {
  authorize.disabled = true;
  clearChallenge();
  status.textContent = 'Requesting a device authorization code…';
  void runManualDeviceAuthorization({
    settings,
    credentialStore,
    accountRoutingStore,
    host: {
      fetchRequest: host.fetch.bind(globalThis),
      cryptoApi: host.crypto,
      schedule: host.setTimeout.bind(globalThis),
      presentChallenge(prompt) {
        challenge.hidden = false;
        verificationUrl.href = prompt.verificationUrl;
        verificationUrl.textContent = prompt.verificationUrl;
        userCode.textContent = prompt.userCode;
        status.textContent = 'Open the linked provider page and complete sign-in.';
        return Promise.resolve();
      },
    },
  })
    .then(() => {
      clearChallenge();
      return refreshCredentialStatus();
    })
    .then(() => {
      status.textContent =
        'Authorization complete. The temporary access token was discarded; Loom will refresh on demand.';
    })
    .catch(() => {
      clearChallenge();
      status.textContent =
        'Authorization did not complete. No provider response details or credentials were logged.';
    })
    .finally(() => {
      authorize.disabled = !enabled.checked;
    });
});

void initialize().catch(() => {
  enabled.checked = false;
  enabled.disabled = true;
  authorize.disabled = true;
  status.textContent = 'Trusted credential storage could not be initialized.';
});
