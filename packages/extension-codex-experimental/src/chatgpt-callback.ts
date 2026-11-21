import { CHATGPT_HELPER_CALLBACK_PROTOCOL, CHATGPT_HELPER_VERSION } from './chatgpt-helper.js';

interface CallbackRuntime {
  sendMessage(message: unknown): Promise<unknown>;
}

const host = globalThis as unknown as {
  readonly chrome: { readonly runtime: CallbackRuntime };
  readonly document: Document;
  readonly history: History;
  readonly location: Location;
};

const status = host.document.querySelector('#status');
if (!(status instanceof HTMLElement)) throw new Error('Callback page is missing its status.');

// Read the one-time callback query, then remove it from this history entry before anything else.
const search = host.location.search;
try {
  host.history.replaceState(null, '', host.location.pathname);
} catch {
  /* The code is single-use and PKCE-bound; a failed history update does not expose it further. */
}

// The service worker checks this tab, the attempt identifier, and the OAuth state, delivers the
// callback only to the website that started this sign-in, and closes this window. Nothing is
// stored or logged here.
void host.chrome.runtime
  .sendMessage({
    protocol: CHATGPT_HELPER_CALLBACK_PROTOCOL,
    version: CHATGPT_HELPER_VERSION,
    search,
  })
  .then((response) => {
    const ok =
      typeof response === 'object' &&
      response !== null &&
      (response as { readonly ok?: unknown }).ok === true;
    status.textContent = ok
      ? 'Sign-in returned to the website. You can close this window.'
      : 'This sign-in is no longer pending. Close this window and start again from the website.';
    status.className = ok ? 'success' : 'error';
  })
  .catch(() => {
    status.textContent =
      'This sign-in could not be returned to the website. Close this window and try again.';
    status.className = 'error';
  });
