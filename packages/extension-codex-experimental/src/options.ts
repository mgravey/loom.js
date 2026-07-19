import type { BrowserCrypto, CodexChromeExtensionApi, OAuthFetch } from './chrome-contracts.js';
import {
  clearBrowserAuthorization,
  CODEX_EXTENSION_CALLBACK_PATH,
  createBrowserAuthorizationBridgeStore,
  startBrowserAuthorization,
} from './browser-authorization.js';
import { CODEX_EXPERIMENTAL_CONFIGURATION } from './composition.js';
import { createCodexCredentialPersistence } from './credential-persistence.js';
import { runManualDeviceAuthorization } from './manual-authorization.js';
import { createCodexExperimentSettings, type CodexCredentialPersistenceMode } from './settings.js';

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
  readonly confirm: (message: string) => boolean;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
};
const settings = createCodexExperimentSettings(host.chrome.storage.local);
const credentialPersistence = createCodexCredentialPersistence({
  settings,
  localStorage: host.chrome.storage.local,
  sessionStorage: host.chrome.storage.session,
  providerId: CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
});
const bridgeStore = createBrowserAuthorizationBridgeStore(host.chrome.storage.session);
const ready = credentialPersistence.initialize();
const enabled = requiredElement<HTMLInputElement>(host.document, 'enabled');
const remember = requiredElement<HTMLButtonElement>(host.document, 'remember');
const browserAuthorize = requiredElement<HTMLButtonElement>(host.document, 'browser-authorize');
const deviceAuthorize = requiredElement<HTMLButtonElement>(host.document, 'device-authorize');
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
  const [authorization, mode] = await Promise.all([
    credentialPersistence.getAuthorization(),
    settings.getCredentialPersistenceMode(),
  ]);
  logout.disabled = authorization === undefined;
  credentialStatus.textContent =
    authorization === undefined
      ? 'Not authenticated. No authorization state is stored.'
      : mode === 'local'
        ? 'Authenticated and remembered on this Chrome profile. Refresh and routing state remain inside the extension.'
        : 'Authenticated for this browser session. Refresh and routing state remain inside the extension.';
}

function updateRememberButton(mode: CodexCredentialPersistenceMode): void {
  const persistent = mode === 'local';
  remember.setAttribute('aria-pressed', String(persistent));
  remember.textContent = persistent
    ? 'Stop remembering after Chrome closes'
    : 'Remember sign-in on this Chrome profile';
}

async function initialize(): Promise<void> {
  await ready;
  const [experimentEnabled, mode] = await Promise.all([
    settings.isDeviceAuthorizationEnabled(),
    settings.getCredentialPersistenceMode(),
  ]);
  enabled.checked = experimentEnabled;
  updateRememberButton(mode);
  remember.disabled = !enabled.checked;
  browserAuthorize.disabled = !enabled.checked;
  deviceAuthorize.disabled = !enabled.checked;
  await refreshCredentialStatus();
  status.textContent = enabled.checked
    ? 'The experiment is enabled. Authorization still requires the button below.'
    : 'The experiment is disabled.';
}

enabled.addEventListener('change', () => {
  void (async () => {
    await settings.setDeviceAuthorizationEnabled(enabled.checked);
    browserAuthorize.disabled = !enabled.checked;
    deviceAuthorize.disabled = !enabled.checked;
    remember.disabled = !enabled.checked;
    clearChallenge();
    if (!enabled.checked) {
      await Promise.all([
        clearBrowserAuthorization({
          bridgeStore,
          transactionStorage: host.chrome.storage.session,
          declarativeNetRequest: host.chrome.declarativeNetRequest,
        }),
        credentialPersistence.clearAll(CODEX_EXPERIMENTAL_CONFIGURATION.providerId),
      ]);
      await settings.setCredentialPersistenceMode('session');
      updateRememberButton('session');
      await refreshCredentialStatus();
      status.textContent = 'The experiment is disabled and its refresh credential was removed.';
    } else {
      status.textContent = 'Enabled. Sign in with ChatGPT or use the device-code fallback.';
    }
  })().catch(() => {
    enabled.checked = false;
    browserAuthorize.disabled = true;
    deviceAuthorize.disabled = true;
    remember.disabled = true;
    status.textContent = 'The trusted extension settings could not be updated.';
  });
});

remember.addEventListener('click', () => {
  remember.disabled = true;
  void (async () => {
    const currentMode = await settings.getCredentialPersistenceMode();
    const nextMode: CodexCredentialPersistenceMode = currentMode === 'local' ? 'session' : 'local';
    if (
      nextMode === 'local' &&
      !host.confirm(
        'Keep this sign-in after Chrome closes? Use this only on a private computer. Anyone with access to this unlocked Chrome profile may be able to use the connected account.',
      )
    ) {
      return;
    }
    await credentialPersistence.setMode(nextMode);
    updateRememberButton(nextMode);
    await refreshCredentialStatus();
    status.textContent =
      nextMode === 'local'
        ? 'Future and current authorization will be remembered on this Chrome profile.'
        : 'Persistent authorization was removed. The current sign-in will end when Chrome closes.';
  })()
    .catch(() => {
      status.textContent = 'The credential storage preference could not be updated.';
    })
    .finally(() => {
      remember.disabled = !enabled.checked;
    });
});

logout.addEventListener('click', () => {
  logout.disabled = true;
  void Promise.all([
    clearBrowserAuthorization({
      bridgeStore,
      transactionStorage: host.chrome.storage.session,
      declarativeNetRequest: host.chrome.declarativeNetRequest,
    }),
    credentialPersistence.clearAll(CODEX_EXPERIMENTAL_CONFIGURATION.providerId),
  ])
    .then(refreshCredentialStatus)
    .then(() => {
      status.textContent = 'Stored authorization was removed.';
    })
    .catch(() => {
      status.textContent = 'Stored authorization could not be removed.';
    });
});

browserAuthorize.addEventListener('click', () => {
  browserAuthorize.disabled = true;
  clearChallenge();
  status.textContent = 'Opening ChatGPT sign-in…';
  void startBrowserAuthorization({
    settings,
    credentialPersistence,
    transactionStorage: host.chrome.storage.session,
    bridgeStore,
    declarativeNetRequest: host.chrome.declarativeNetRequest,
    tabs: host.chrome.tabs,
    fetchRequest: host.fetch.bind(globalThis),
    cryptoApi: host.crypto,
    callbackUrl: host.chrome.runtime.getURL(CODEX_EXTENSION_CALLBACK_PATH),
  })
    .then(() => {
      status.textContent =
        'Complete ChatGPT sign-in in the new tab. The localhost callback will return to this extension.';
    })
    .catch(() => {
      status.textContent = 'ChatGPT browser login could not be started.';
    })
    .finally(() => {
      browserAuthorize.disabled = !enabled.checked;
    });
});

deviceAuthorize.addEventListener('click', () => {
  deviceAuthorize.disabled = true;
  clearChallenge();
  status.textContent = 'Requesting a device authorization code…';
  void runManualDeviceAuthorization({
    settings,
    credentialPersistence,
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
    .then(() => settings.getCredentialPersistenceMode())
    .then((mode) => {
      status.textContent =
        mode === 'local'
          ? 'Authorization complete and remembered on this Chrome profile. The temporary access token was discarded; Loom will refresh on demand.'
          : 'Authorization complete for this browser session. The temporary access token was discarded; Loom will refresh on demand.';
    })
    .catch(() => {
      clearChallenge();
      status.textContent =
        'Authorization did not complete. No provider response details or credentials were logged.';
    })
    .finally(() => {
      deviceAuthorize.disabled = !enabled.checked;
    });
});

host.document.addEventListener('visibilitychange', () => {
  if (host.document.visibilityState === 'visible') void refreshCredentialStatus();
});

void initialize().catch(() => {
  enabled.checked = false;
  enabled.disabled = true;
  browserAuthorize.disabled = true;
  deviceAuthorize.disabled = true;
  remember.disabled = true;
  status.textContent = 'Trusted credential storage could not be initialized.';
});
