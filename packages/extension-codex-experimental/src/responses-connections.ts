import { GOOGLE_SUBSCRIPTION_ENDPOINT } from './google-subscription.js';
import { discoverResponsesModels, type ResponsesModelsFetch } from './responses-models.js';
import {
  type ChromeStorageArea,
  type ChromeMessageSender,
  type ChromeExternalMessageListener,
  type OriginAuthorizer,
} from '@mgravey/loom-extension';

export const RESPONSES_CONNECTIONS_KEY = 'loom.responses-connections.v1';
export const RESPONSES_CONNECTION_PROTOCOL = 'loom/responses-connections';
export interface ResponsesHostPermissions {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
}
export type ServerProvider =
  'responses' | 'anthropic' | 'gemini' | 'gemini-subscription' | 'claude-code';
export interface ResponsesConnection {
  readonly provider?: ServerProvider;
  readonly projectId?: string;
  readonly subscriptionModels?: readonly string[];
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly apiKey: string;
}
export interface ResponsesConnectionInfo {
  readonly provider?: ServerProvider;
  readonly projectId?: string;
  readonly subscriptionModels?: readonly string[];
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly hasApiKey: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function responsesEndpoint(value: string, provider: ServerProvider = 'responses'): string {
  if (provider === 'gemini-subscription') {
    if (value.trim() !== GOOGLE_SUBSCRIPTION_ENDPOINT)
      throw new Error('Subscription endpoint is fixed.');
    return GOOGLE_SUBSCRIPTION_ENDPOINT;
  }
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error('Use an HTTP(S) endpoint without credentials, query or fragment.');
  if (
    provider === 'claude-code' &&
    (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('Claude helper must use HTTP on loopback.');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (provider === 'gemini') {
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1beta';
    if (!/\/v1(?:beta)?$/u.test(url.pathname)) throw new Error('Use a Gemini /v1beta/ base URL.');
    return url.toString() + '/';
  }
  if (provider === 'anthropic') {
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1';
    if (url.pathname.endsWith('/v1')) url.pathname += '/messages';
    if (!url.pathname.endsWith('/v1/messages')) throw new Error('Use an Anthropic /v1/ base URL.');
    return url.toString();
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1/responses';
  if (url.pathname.endsWith('/v1')) url.pathname += '/responses';
  if (!url.pathname.endsWith('/v1/responses')) throw new Error('The base URL must end with /v1/.');
  return url.toString();
}
export function responsesHostPattern(endpoint: string): string {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid server host.');
  // Chrome host permissions ignore ports. The relay still uses the exact saved endpoint/port.
  return `${url.protocol}//${url.hostname}/*`;
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
  }
  return false;
}
export function normalizeResponsesConnection(value: unknown): ResponsesConnection {
  if (
    !record(value) ||
    (value.provider !== undefined &&
      (typeof value.provider !== 'string' ||
        !['responses', 'anthropic', 'gemini', 'gemini-subscription', 'claude-code'].includes(
          value.provider,
        ))) ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/u.test(value.id) ||
    typeof value.label !== 'string' ||
    value.label.trim().length === 0 ||
    value.label.length > 128 ||
    typeof value.endpoint !== 'string' ||
    value.endpoint.length > 2048 ||
    typeof value.apiKey !== 'string' ||
    value.apiKey.length > 16_384 ||
    hasControlCharacters(value.apiKey)
  )
    throw new Error('Invalid Responses connection.');
  if (
    value.provider === 'gemini-subscription' &&
    (value.apiKey !== '' ||
      (value.projectId !== undefined &&
        (typeof value.projectId !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9:._-]{2,199}$/u.test(value.projectId))) ||
      !Array.isArray(value.subscriptionModels) ||
      value.subscriptionModels.length === 0 ||
      value.subscriptionModels.length > 32 ||
      value.subscriptionModels.some(
        (model: unknown) =>
          typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(model),
      ))
  )
    throw new Error('Invalid Google subscription configuration.');
  return Object.freeze({
    ...(value.provider === undefined ? {} : { provider: value.provider as ServerProvider }),
    id: value.id,
    label: value.label.trim(),
    endpoint: responsesEndpoint(value.endpoint, value.provider as ServerProvider | undefined),
    apiKey: value.apiKey.trim(),
    ...(value.provider !== 'gemini-subscription'
      ? {}
      : {
          ...(value.projectId === undefined ? {} : { projectId: value.projectId as string }),
          subscriptionModels: Object.freeze([...(value.subscriptionModels as string[])]),
        }),
  });
}
function info(value: ResponsesConnection): ResponsesConnectionInfo {
  return Object.freeze({
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    id: value.id,
    label: value.label,
    endpoint: value.endpoint,
    hasApiKey: value.apiKey !== '',
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    ...(value.subscriptionModels === undefined
      ? {}
      : { subscriptionModels: value.subscriptionModels }),
  });
}
export function createResponsesConnectionStore(
  storage: ChromeStorageArea,
  permissions: ResponsesHostPermissions | undefined,
  authorizer?: OriginAuthorizer,
  resolveSubscription?: (connection: ResponsesConnection) => Promise<ResponsesConnection>,
) {
  const ready = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  async function read(): Promise<ResponsesConnection[]> {
    await ready;
    const value = (await storage.get(RESPONSES_CONNECTIONS_KEY))[RESPONSES_CONNECTIONS_KEY];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 32)
      throw new Error('Invalid Responses connection storage.');
    return value.map(normalizeResponsesConnection);
  }
  return Object.freeze({
    async list(): Promise<readonly ResponsesConnectionInfo[]> {
      return (await read()).map(info);
    },
    async save(value: ResponsesConnection): Promise<void> {
      const connection = normalizeResponsesConnection(value);
      if (!(await permissions?.contains({ origins: [responsesHostPattern(connection.endpoint)] })))
        throw new Error('Grant access to this server before saving.');
      const values = (await read()).filter((entry) => entry.id !== connection.id);
      if (values.length >= 32) throw new Error('At most 32 connections can be saved.');
      await storage.set({ [RESPONSES_CONNECTIONS_KEY]: [...values, connection] });
    },
    async remove(id: string): Promise<void> {
      await storage.set({
        [RESPONSES_CONNECTIONS_KEY]: (await read()).filter((entry) => entry.id !== id),
      });
    },
    async authorized(id: string, sender: ChromeMessageSender): Promise<ResponsesConnection> {
      // Website access is a Companion-wide grant, shared by every server.
      if (authorizer === undefined) throw new Error('Website approval is unavailable.');
      await authorizer.assertAuthorized(sender);
      const value = (await read()).find((entry) => entry.id === id);
      if (value === undefined) throw new Error('Connection unavailable or website not approved.');
      if (!(await permissions?.contains({ origins: [responsesHostPattern(value.endpoint)] })))
        throw new Error('Server host access is not granted.');
      if (value.provider === 'gemini-subscription') {
        if (!resolveSubscription) throw new Error('Google subscription login unavailable.');
        return resolveSubscription(value);
      }
      return value;
    },
  });
}
export type ResponsesConnectionStore = ReturnType<typeof createResponsesConnectionStore>;
export function isResponsesConnectionRequest(value: unknown): boolean {
  return record(value) && value.protocol === RESPONSES_CONNECTION_PROTOCOL;
}
export function createResponsesConnectionListener(
  store: ResponsesConnectionStore,
  authorizer: OriginAuthorizer,
  fetchModels?: ResponsesModelsFetch,
): ChromeExternalMessageListener {
  return (value, sender, respond) => {
    void (async () => {
      try {
        await authorizer.assertAuthorized(sender);
        if (
          record(value) &&
          value.protocol === RESPONSES_CONNECTION_PROTOCOL &&
          value.version === 1 &&
          value.type === 'catalogue' &&
          Object.keys(value).every((key) => ['protocol', 'version', 'type'].includes(key))
        ) {
          if (fetchModels === undefined) throw new Error('Model discovery unavailable.');
          respond({ ok: true, servers: await discoverResponsesModels(store, sender, fetchModels) });
          return;
        }
        if (
          !record(value) ||
          value.protocol !== RESPONSES_CONNECTION_PROTOCOL ||
          value.version !== 1 ||
          value.type !== 'get' ||
          typeof value.connectionId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,64}$/u.test(value.connectionId) ||
          Object.keys(value).some(
            (key) => !['protocol', 'version', 'type', 'connectionId'].includes(key),
          )
        )
          throw new Error('Invalid request.');
        const connection = await store.authorized(value.connectionId, sender);
        // This is the only externally exposed profile representation. Never return its key.
        respond({
          ok: true,
          connection: { id: connection.id, label: connection.label, endpoint: connection.endpoint },
        });
      } catch {
        respond({
          ok: false,
          error: {
            code: 'CONNECTION_UNAVAILABLE',
            message: 'Configure this connection and approve this website in Companion settings.',
          },
        });
      }
    })();
    return true;
  };
}
