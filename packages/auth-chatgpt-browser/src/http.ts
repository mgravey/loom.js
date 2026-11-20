import {
  chatgptError,
  isProviderErrorCode,
  providerError,
  type ChatGPTBrowserError,
  type ChatGPTBrowserErrorKind,
  type ChatGPTBrowserProviderErrorCode,
} from './errors.js';

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bounded(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

/** No provider bodies, OAuth codes, URLs, or underlying exceptions escape this function. */
export async function fetchSafe(
  fetch: FetchFunction,
  url: string,
  init: RequestInit,
  kind: ChatGPTBrowserErrorKind,
  message: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw chatgptError(kind, message);
  }
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* No response body is read or exposed. */
  }
}

export function requestId(response: Response): string | undefined {
  try {
    const value = response.headers.get('x-request-id');
    return value !== null && REQUEST_ID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads untrusted JSON with a size bound before parsing. */
export async function readJson(
  response: Response,
  message: string,
  maximum = 1024 * 1024,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw chatgptError('invalid-response', message);
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (text.length > maximum) throw new Error('oversized');
      if (chunk.done) break;
    }
    const value: unknown = JSON.parse(text);
    if (!record(value)) throw new Error('not an object');
    return value;
  } catch {
    throw chatgptError('invalid-response', message);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* No provider errors escape. */
    }
    reader.releaseLock();
  }
}

/** Requires a 2xx JSON response; non-2xx bodies are discarded unread. */
export async function jsonSafe(
  response: Response,
  message: string,
  kind: ChatGPTBrowserErrorKind = 'request-failed',
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await discardBody(response);
    throw chatgptError(kind, `${message} (HTTP ${String(response.status)}).`, {
      status: response.status,
    });
  }
  return readJson(response, message);
}

/** Extracts only an allowlisted documented code from a structured provider error object. */
export function providerCodeFrom(value: unknown): ChatGPTBrowserProviderErrorCode | undefined {
  if (!record(value)) return undefined;
  const candidates: unknown[] = [value.code];
  if (record(value.error)) candidates.push(value.error.code);
  if (record(value.response) && record(value.response.error))
    candidates.push(value.response.error.code);
  return candidates.find(isProviderErrorCode);
}

/** Classifies a non-2xx resource response from a small bounded body, never exposing it. */
export async function resourceFailure(
  response: Response,
  fallback: string,
): Promise<ChatGPTBrowserError> {
  let code: ChatGPTBrowserProviderErrorCode | undefined;
  try {
    code = providerCodeFrom(await readJson(response, fallback, 16_384));
  } catch {
    /* Non-JSON or oversized errors remain unclassified. */
  }
  return providerError(code, response.status, requestId(response), fallback);
}
