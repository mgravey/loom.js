import { serverHeaders, serverBaseUrl } from './server-provider.js';
import type { ChromeMessageSender } from '@mgravey/loom-extension';
import type { CodexModelFetchResponse } from './chrome-contracts.js';
import type { ResponsesConnection, ResponsesConnectionStore } from './responses-connections.js';

export type ResponsesModelsFetch = (
  url: string,
  init: {
    readonly method: 'GET';
    readonly headers: Readonly<Record<string, string>>;
    readonly credentials: 'omit';
    readonly redirect: 'error';
    readonly cache: 'no-store';
    readonly signal: AbortSignal;
  },
) => Promise<CodexModelFetchResponse>;

export interface ResponsesServerModels {
  readonly id: string;
  readonly label: string;
  readonly models: readonly string[];
  readonly unavailable: boolean;
}

export async function readModels(
  connection: ResponsesConnection,
  fetchRequest: ResponsesModelsFetch,
): Promise<readonly string[]> {
  if (connection.provider === 'gemini-subscription') {
    // authorize() has freshly checked Code Assist access. These are explicitly configured IDs,
    // not an invented provider catalogue: the upstream client exposes no verified listModels API.
    return Object.freeze([...(connection.subscriptionModels ?? [])]);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Catalogue deadline exceeded.'));
    }, 8_000);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const base = serverBaseUrl(connection) + 'models';
        const ids: string[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let totalBytes = 0;
        for (let page = 0; page < 10; page += 1) {
          const url = new URL(base);
          if (cursor !== undefined)
            url.searchParams.set(
              connection.provider === 'gemini' ? 'pageToken' : 'after_id',
              cursor,
            );
          const response = await fetchRequest(url.toString(), {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              ...serverHeaders(connection),
            },
          });
          if (response.status !== 200 || response.body === null)
            throw new Error('Catalogue unavailable.');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let body = '';
          let bytes = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              totalBytes += chunk.value.byteLength;
              if (bytes > 256 * 1024 || totalBytes > 256 * 1024)
                throw new Error('Catalogue too large.');
              body += decoder.decode(chunk.value, { stream: true });
            }
            body += decoder.decode();
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          const value: unknown = JSON.parse(body);
          if (typeof value !== 'object' || value === null || Array.isArray(value))
            throw new Error('Invalid catalogue.');
          const catalogue = value as Record<string, unknown>;
          const entries =
            connection.provider === 'gemini' ? (catalogue.models ?? []) : catalogue.data;
          if (!Array.isArray(entries) || entries.length > 500)
            throw new Error('Invalid catalogue.');
          for (const raw of entries as unknown[]) {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
              throw new Error('Invalid model.');
            const item = raw as Record<string, unknown>;
            const id = connection.provider === 'gemini' ? item.name : item.id;
            if (
              typeof id !== 'string' ||
              id.trim() === '' ||
              id.length > 200 ||
              (connection.apiKey !== '' && id.includes(connection.apiKey))
            )
              throw new Error('Invalid model ID.');
            if (
              connection.provider === 'gemini' &&
              (!Array.isArray(item.supportedGenerationMethods) ||
                !item.supportedGenerationMethods.includes('generateContent'))
            )
              continue;
            if (!ids.includes(id)) ids.push(id);
            if (ids.length > 500) throw new Error('Too many models.');
          }
          const next =
            connection.provider === 'gemini'
              ? catalogue.nextPageToken
              : connection.provider === 'anthropic' && catalogue.has_more === true
                ? catalogue.last_id
                : undefined;
          if (
            connection.provider === 'anthropic' &&
            catalogue.has_more === true &&
            (typeof next !== 'string' || next === '')
          )
            throw new Error('Missing catalogue cursor.');
          if (next === undefined || next === '') return Object.freeze(ids);
          if (typeof next !== 'string' || next.length > 2048 || cursors.has(next))
            throw new Error('Invalid catalogue cursor.');
          cursors.add(next);
          cursor = next;
        }
        throw new Error('Catalogue pagination limit exceeded.');
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** A failed server cannot erase another server's models. Unapproved profiles are never exposed. */
export async function discoverResponsesModels(
  store: ResponsesConnectionStore,
  sender: ChromeMessageSender,
  fetchRequest: ResponsesModelsFetch,
): Promise<readonly ResponsesServerModels[]> {
  const profiles = await store.list(); // Store bounds this list to 32 servers.
  const results = await Promise.all(
    profiles.map(async ({ id }) => {
      let connection: ResponsesConnection;
      try {
        connection = await store.authorized(id, sender);
      } catch {
        return undefined;
      }
      try {
        return {
          id,
          label: connection.label,
          models: await readModels(connection, fetchRequest),
          unavailable: false,
        };
      } catch {
        return { id, label: connection.label, models: [], unavailable: true };
      }
    }),
  );
  return Object.freeze(
    results.filter((result): result is ResponsesServerModels => result !== undefined),
  );
}
