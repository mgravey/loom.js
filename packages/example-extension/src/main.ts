import {
  EXTENSION_AUTH_KEY,
  createExtensionAuthPlugin,
  createExternalCredentialBroker,
  type ExternalMessageRuntime,
} from '@mgravey/loom-auth-extension';
import { createLoomRuntime } from '@mgravey/loom-core';

interface ChromeHost {
  readonly chrome?: {
    readonly runtime?: ExternalMessageRuntime;
  };
}

function requiredElement<ElementType extends HTMLElement>(
  selector: string,
  constructor: new () => ElementType,
): ElementType {
  const element = globalThis.document.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Credential broker example is missing required element "${selector}".`);
  }
  return element;
}

const extensionIdInput = requiredElement('#extension-id', HTMLInputElement);
const requestButton = requiredElement('#request-token', HTMLButtonElement);
const statusElement = requiredElement('#status', HTMLParagraphElement);
const outputElement = requiredElement('#output', HTMLPreElement);

function extensionRuntime(): ExternalMessageRuntime {
  const runtime = (globalThis as typeof globalThis & ChromeHost).chrome?.runtime;
  if (runtime === undefined || typeof runtime.sendMessage !== 'function') {
    throw new Error(
      'The Loom credential broker extension is unavailable to this page. Load the unpacked extension and use an allowed origin.',
    );
  }
  return runtime;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestAccessToken(): Promise<void> {
  requestButton.disabled = true;
  statusElement.textContent = 'Requesting a short-lived token…';
  outputElement.textContent = '';
  let runtime: ReturnType<typeof createLoomRuntime> | undefined;

  try {
    const extensionId = extensionIdInput.value.trim();
    const broker = createExternalCredentialBroker({
      extensionId,
      runtime: extensionRuntime(),
    });
    runtime = createLoomRuntime({
      plugins: [createExtensionAuthPlugin({ broker, providerId: 'loom/mock' })],
    });
    await runtime.initialize();
    await runtime.start();

    const token = await runtime.capabilities.get(EXTENSION_AUTH_KEY).getAccessToken();
    outputElement.textContent = token;
    statusElement.textContent = 'Token received through Loom AuthProvider.';
  } catch (error) {
    outputElement.textContent = errorMessage(error);
    statusElement.textContent = 'Token request failed.';
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.dispose();
      } catch (error) {
        outputElement.textContent = `${outputElement.textContent}\nCleanup: ${errorMessage(error)}`;
        statusElement.textContent = 'Token request ended with a cleanup error.';
      }
    }
    requestButton.disabled = false;
  }
}

requestButton.addEventListener('click', () => {
  void requestAccessToken();
});
