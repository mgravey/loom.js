import {
  createGoogleSubscriptionAuth,
  googleSubscriptionConfigured,
  GoogleSubscriptionError,
  GOOGLE_SUBSCRIPTION_ENDPOINT,
} from './google-subscription.js';
import { readModels, type ResponsesModelsFetch } from './responses-models.js';
import type { CodexChromeExtensionApi, CodexModelFetch } from './chrome-contracts.js';
import {
  createResponsesConnectionStore,
  responsesEndpoint,
  normalizeResponsesConnection,
  type ServerProvider,
  responsesHostPattern,
} from './responses-connections.js';

/** Runs only on the trusted extension options page. No website API can configure connections. */
export function initializeResponsesOptions(
  document: Document,
  chrome: CodexChromeExtensionApi,
  fetchRequest: ResponsesModelsFetch & CodexModelFetch,
): void {
  const googleAuth = createGoogleSubscriptionAuth(chrome, fetchRequest);
  const store = createResponsesConnectionStore(chrome.storage.local, chrome.permissions);
  const element = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (value === null) throw new Error('Missing Responses settings control.');
    return value as T;
  };
  const form = element<HTMLFormElement>('responses-connection-form');
  const id = element<HTMLInputElement>('responses-connection-id');
  const label = element<HTMLInputElement>('responses-connection-label');
  const endpoint = element<HTMLInputElement>('responses-endpoint');
  const provider = element<HTMLSelectElement>('server-provider');
  const subscriptionFields = element<HTMLElement>('google-subscription-fields');
  const project = element<HTMLInputElement>('google-subscription-project');
  const models = element<HTMLInputElement>('google-subscription-models');
  const googleOption = element<HTMLOptionElement>('google-subscription-option');
  googleOption.disabled = !googleSubscriptionConfigured(chrome);
  if (!googleOption.disabled)
    googleOption.textContent = 'Google account / Code Assist (experimental)';
  const updateProvider = (): void => {
    const chatgpt = provider.value === 'chatgpt';
    element<HTMLElement>('chatgpt-account-fields').hidden = !chatgpt;
    element<HTMLElement>('server-connection-fields').hidden = chatgpt;
    element<HTMLElement>('responses-status').hidden = chatgpt;
    const subscription = provider.value === 'gemini-subscription';
    subscriptionFields.hidden = !subscription;
    element<HTMLElement>('claude-account-fields').hidden = provider.value !== 'claude-code';
    element<HTMLElement>('server-key-label').textContent =
      provider.value === 'claude-code' ? 'Helper pairing token' : 'API key (optional)';
    endpoint.readOnly = subscription;
    key.disabled = subscription;
    models.required = subscription;
  };
  element<HTMLButtonElement>('google-subscription-logout').addEventListener('click', () => {
    void googleAuth
      .logout()
      .then(() => {
        status.textContent = 'Google sign-in cleared. Subscription profiles require sign-in again.';
      })
      .catch(() => {
        status.textContent = 'Google access disabled locally; Chrome token cache cleanup failed.';
      });
  });
  provider.addEventListener('change', () => {
    endpoint.value =
      provider.value === 'claude-code'
        ? 'http://127.0.0.1:43187/v1/'
        : provider.value === 'gemini-subscription'
          ? GOOGLE_SUBSCRIPTION_ENDPOINT
          : provider.value === 'anthropic'
            ? 'https://api.anthropic.com/v1/'
            : provider.value === 'gemini'
              ? 'https://generativelanguage.googleapis.com/v1beta/'
              : 'http://localhost:11434/v1/';
    key.value = '';
    updateProvider();
  });
  const key = element<HTMLInputElement>('responses-api-key');
  const status = element<HTMLElement>('responses-status');
  const list = element<HTMLElement>('responses-connections');
  const save = element<HTMLButtonElement>('responses-save');
  for (const action of ['login', 'logout'] as const) {
    const button = element<HTMLButtonElement>('claude-account-' + action);
    button.addEventListener('click', () => {
      if (provider.value !== 'claude-code') return;
      try {
        const target = responsesEndpoint(endpoint.value, 'claude-code');
        if (!/^[a-zA-Z0-9_-]{32,}$/u.test(key.value)) throw new Error('Missing pairing token.');
        const pairingToken = key.value;
        const granted = chrome.permissions?.request({ origins: [responsesHostPattern(target)] });
        button.disabled = true;
        status.textContent =
          action === 'login' ? 'Opening Claude Code sign-in…' : 'Signing out of Claude Code…';
        void (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 190000);
          try {
            if (!(await granted)) throw new Error('Permission denied.');
            const response = await fetchRequest(target.replace(/responses$/u, 'auth/' + action), {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + pairingToken,
                'Content-Type': 'application/json',
              },
              body: '{}',
              credentials: 'omit',
              redirect: 'error',
              cache: 'no-store',
              signal: controller.signal,
            });
            await response.body?.cancel().catch(() => undefined);
            if (response.status !== 200) throw new Error('Helper failed.');
            status.textContent =
              action === 'login'
                ? 'Claude Code signed in. Save this connection to add its models.'
                : 'Claude Code signed out.';
          } catch {
            status.textContent =
              'Claude Code action failed. Check that the helper is running, its pairing token is current, and the official Claude Code client is installed. You can also run claude auth login in a terminal.';
          } finally {
            clearTimeout(timer);
            button.disabled = false;
          }
        })();
      } catch {
        status.textContent = 'Enter the local helper address and its pairing token first.';
      }
    });
  }
  async function refresh(): Promise<void> {
    const connections = await store.list();
    list.replaceChildren(
      ...connections.map((connection) => {
        const row = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = `${connection.label} (${connection.id}) — ${connection.endpoint.replace(/(?:responses|messages)$/u, '')} — ${connection.hasApiKey ? 'key saved' : 'no key'}`;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => {
          provider.value = connection.provider ?? 'responses';
          project.value = connection.projectId ?? '';
          models.value = connection.subscriptionModels?.join(', ') ?? '';
          updateProvider();
          id.value = connection.id;
          label.value = connection.label;
          endpoint.value = connection.endpoint.replace(/(?:responses|messages)$/u, '');
          key.value = '';
          status.textContent =
            'Re-enter the key when updating this connection. Leaving it blank removes the saved key.';
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          void store
            .remove(connection.id)
            .then(refresh)
            .then(() => {
              status.textContent = 'Connection and its key removed.';
            })
            .catch(() => {
              status.textContent = 'Could not remove the connection.';
            });
        });
        row.append(text, edit, remove);
        return row;
      }),
    );
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    let stage: 'address' | 'fields' | 'permission' | 'check' | 'storage' | 'refresh' = 'address';
    const failure = (error?: unknown): void => {
      if (error instanceof GoogleSubscriptionError) {
        status.textContent =
          error.message + (error.status === undefined ? '' : ` (HTTP ${String(error.status)})`);
        return;
      }
      const messages = {
        address:
          'Invalid base URL. Use an HTTP(S) URL such as http://127.0.0.1:10001/v1 without credentials, query or fragment.',
        fields:
          'Invalid connection fields. Use an ID containing only letters, digits, underscores or hyphens, a nonempty name, and a key without line breaks.',
        permission:
          'Connection was not saved: Chrome did not grant server access. Allow access in the Chrome prompt. If no prompt appeared, reload the updated extension at chrome://extensions, reopen settings and try again.',
        check: 'Connection was not saved: server availability check could not finish. Try again.',
        storage:
          'Connection was not saved: extension storage or saved server permissions could not be updated. Check extension access, reload Companion and retry. Existing connections were not replaced.',
        refresh:
          'Connection was saved, but the saved-server list could not be refreshed. Reopen settings.',
      };
      status.textContent = messages[stage];
    };
    try {
      const target = responsesEndpoint(endpoint.value, provider.value as ServerProvider);
      stage = 'fields';
      const connection = normalizeResponsesConnection({
        provider: provider.value as ServerProvider,
        id: id.value.trim(),
        label: label.value.trim(),
        endpoint: target,
        apiKey: provider.value === 'gemini-subscription' ? '' : key.value,
        ...(provider.value !== 'gemini-subscription'
          ? {}
          : {
              ...(project.value.trim() === '' ? {} : { projectId: project.value.trim() }),
              subscriptionModels: models.value
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            }),
      });
      // Must be called within the user gesture, before storage awaits.
      stage = 'permission';
      status.textContent = 'Waiting for Chrome server permission…';
      const granted = chrome.permissions?.request({ origins: [responsesHostPattern(target)] });
      key.value = '';
      save.disabled = true;
      void Promise.resolve(granted)
        .then(async (allowed) => {
          if (!allowed) throw new Error('Server access was not granted.');
          stage = 'check';
          status.textContent = 'Checking server model availability…';
          let availability: string;
          if (connection.provider === 'gemini-subscription') {
            status.textContent = 'Signing in with Google, then checking Code Assist access…';
            await googleAuth.login();
            await googleAuth.authorize(connection);
            availability =
              'Code Assist access checked. Model IDs are manually configured; availability is confirmed when used.';
          } else
            try {
              const models = await readModels(connection, fetchRequest);
              availability = `Server available: ${String(models.length)} models.`;
            } catch {
              availability =
                'Warning: model discovery unavailable. Check the address, key and server; you can retry by saving again.';
            }
          stage = 'storage';
          await store.save(connection);
          stage = 'refresh';
          await refresh();
          status.textContent = `Saved ${connection.id}. ${availability}`;
        })
        .catch(failure)
        .finally(() => {
          save.disabled = false;
        });
    } catch {
      failure();
    }
  });
  void refresh().catch(() => {
    status.textContent = 'Trusted connection storage is unavailable.';
  });
}
