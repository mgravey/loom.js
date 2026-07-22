import {
  ExtensionBrokerError,
  messageSenderOrigin,
  type ChromeExternalMessageListener,
  type ChromeMessageSender,
  type ChromeStorageArea,
  type OriginAuthorizer,
} from '@mgravey/loom-extension';

export const CODEX_ORIGIN_ACCESS_PROTOCOL = 'loom/codex-origin-access-experimental' as const;
export const CODEX_ORIGIN_ACCESS_VERSION = 1 as const;
export const CODEX_APPROVED_ORIGINS_KEY = 'loom.codex-experimental.approved-origins' as const;
export const CODEX_PENDING_ORIGINS_KEY = 'loom.codex-experimental.pending-origins' as const;

type OriginAccessRequestType = 'requestOriginAccess' | 'getOriginAccessStatus';

interface OriginAccessRequest {
  readonly protocol: typeof CODEX_ORIGIN_ACCESS_PROTOCOL;
  readonly version: typeof CODEX_ORIGIN_ACCESS_VERSION;
  readonly type: OriginAccessRequestType;
  readonly requestId: string;
}

export interface CodexOriginAccessStore {
  initialize(): Promise<void>;
  isApproved(origin: string): Promise<boolean>;
  listApproved(): Promise<readonly string[]>;
  listPending(): Promise<readonly string[]>;
  approve(origin: string): Promise<void>;
  deny(origin: string): Promise<void>;
  revoke(origin: string): Promise<void>;
  request(origin: string): Promise<void>;
  clear(): Promise<void>;
}

export interface CreateCodexOriginAccessListenerOptions {
  readonly manifestAuthorizer: OriginAuthorizer;
  readonly store: CodexOriginAccessStore;
  readonly openOptionsPage: () => Promise<void>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCodexOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Website access requires an exact HTTP(S) origin.');
  }
  return url.origin;
}

function parseStoredOrigins(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const origins = value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    try {
      return [normalizeCodexOrigin(entry)];
    } catch {
      return [];
    }
  });
  return Object.freeze([...new Set(origins)].sort());
}

async function readOrigins(storage: ChromeStorageArea, key: string): Promise<readonly string[]> {
  const result = await storage.get(key);
  return parseStoredOrigins(result[key]);
}

export function createCodexOriginAccessStore(options: {
  readonly localStorage: ChromeStorageArea;
  readonly sessionStorage: ChromeStorageArea;
}): CodexOriginAccessStore {
  const ready = Promise.all([
    options.localStorage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    options.sessionStorage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).then(() => undefined);
  let mutation = Promise.resolve();

  async function writeOrigins(
    storage: ChromeStorageArea,
    key: string,
    origins: readonly string[],
  ): Promise<void> {
    if (origins.length === 0) await storage.remove(key);
    else await storage.set({ [key]: [...origins].sort() });
  }

  function mutate(
    storage: ChromeStorageArea,
    key: string,
    operation: (origins: Set<string>) => void,
  ): Promise<void> {
    const next = mutation.then(async () => {
      await ready;
      const origins = new Set(await readOrigins(storage, key));
      operation(origins);
      await writeOrigins(storage, key, [...origins]);
    });
    mutation = next.catch(() => undefined);
    return next;
  }

  async function stableRead(storage: ChromeStorageArea, key: string): Promise<readonly string[]> {
    await ready;
    await mutation;
    return readOrigins(storage, key);
  }

  return Object.freeze({
    async initialize() {
      await ready;
      const [approved, pending] = await Promise.all([
        readOrigins(options.localStorage, CODEX_APPROVED_ORIGINS_KEY),
        readOrigins(options.sessionStorage, CODEX_PENDING_ORIGINS_KEY),
      ]);
      await Promise.all([
        writeOrigins(options.localStorage, CODEX_APPROVED_ORIGINS_KEY, approved),
        writeOrigins(options.sessionStorage, CODEX_PENDING_ORIGINS_KEY, pending),
      ]);
    },
    async isApproved(origin: string) {
      const normalized = normalizeCodexOrigin(origin);
      return (await stableRead(options.localStorage, CODEX_APPROVED_ORIGINS_KEY)).includes(
        normalized,
      );
    },
    listApproved: () => stableRead(options.localStorage, CODEX_APPROVED_ORIGINS_KEY),
    listPending: () => stableRead(options.sessionStorage, CODEX_PENDING_ORIGINS_KEY),
    async approve(origin: string) {
      const normalized = normalizeCodexOrigin(origin);
      await mutate(options.localStorage, CODEX_APPROVED_ORIGINS_KEY, (origins) => {
        origins.add(normalized);
      });
      await mutate(options.sessionStorage, CODEX_PENDING_ORIGINS_KEY, (origins) => {
        origins.delete(normalized);
      });
    },
    async deny(origin: string) {
      const normalized = normalizeCodexOrigin(origin);
      await mutate(options.sessionStorage, CODEX_PENDING_ORIGINS_KEY, (origins) => {
        origins.delete(normalized);
      });
    },
    async revoke(origin: string) {
      const normalized = normalizeCodexOrigin(origin);
      await mutate(options.localStorage, CODEX_APPROVED_ORIGINS_KEY, (origins) => {
        origins.delete(normalized);
      });
    },
    async request(origin: string) {
      const normalized = normalizeCodexOrigin(origin);
      await mutate(options.sessionStorage, CODEX_PENDING_ORIGINS_KEY, (origins) => {
        origins.add(normalized);
      });
    },
    async clear() {
      await ready;
      await mutation;
      await Promise.all([
        options.localStorage.remove(CODEX_APPROVED_ORIGINS_KEY),
        options.sessionStorage.remove(CODEX_PENDING_ORIGINS_KEY),
      ]);
    },
  });
}

export function createGrantedOriginAuthorizer(
  manifestAuthorizer: OriginAuthorizer,
  store: CodexOriginAccessStore,
): OriginAuthorizer {
  return Object.freeze({
    async assertAuthorized(sender: ChromeMessageSender) {
      await manifestAuthorizer.assertAuthorized(sender);
      const origin = messageSenderOrigin(sender);
      if (origin === undefined || !(await store.isApproved(origin))) {
        throw new ExtensionBrokerError(
          'UNAUTHORIZED_ORIGIN',
          'The requesting website has not been approved by the extension user.',
        );
      }
    },
  });
}

function parseRequest(value: unknown): OriginAccessRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['protocol', 'version', 'type', 'requestId'].includes(key)) ||
    value.protocol !== CODEX_ORIGIN_ACCESS_PROTOCOL ||
    value.version !== CODEX_ORIGIN_ACCESS_VERSION ||
    (value.type !== 'requestOriginAccess' && value.type !== 'getOriginAccessStatus') ||
    typeof value.requestId !== 'string' ||
    !/^[a-zA-Z0-9._:-]{1,256}$/u.test(value.requestId)
  ) {
    throw new Error('Invalid origin-access request.');
  }
  return value as unknown as OriginAccessRequest;
}

function fallbackRequestId(value: unknown): string {
  if (!isRecord(value)) return 'invalid-request';
  return typeof value.requestId === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/u.test(value.requestId)
    ? value.requestId
    : 'invalid-request';
}

export function isCodexOriginAccessRequest(value: unknown): boolean {
  return isRecord(value) && value.protocol === CODEX_ORIGIN_ACCESS_PROTOCOL;
}

export function createCodexOriginAccessListener(
  options: CreateCodexOriginAccessListenerOptions,
): ChromeExternalMessageListener {
  return (message, sender, sendResponse) => {
    void (async () => {
      const requestId = fallbackRequestId(message);
      try {
        await options.manifestAuthorizer.assertAuthorized(sender);
        const request = parseRequest(message);
        const origin = messageSenderOrigin(sender);
        if (origin === undefined) {
          throw new ExtensionBrokerError('UNAUTHORIZED_ORIGIN', 'Invalid website origin.');
        }
        const approved = await options.store.isApproved(origin);
        if (!approved && request.type === 'requestOriginAccess') {
          await options.store.request(origin);
          await options.openOptionsPage();
        }
        sendResponse(
          Object.freeze({
            protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
            version: CODEX_ORIGIN_ACCESS_VERSION,
            type: 'originAccessResult',
            requestId: request.requestId,
            ok: true,
            approved,
          }),
        );
      } catch (error) {
        sendResponse(
          Object.freeze({
            protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
            version: CODEX_ORIGIN_ACCESS_VERSION,
            type: 'originAccessResult',
            requestId,
            ok: false,
            error: Object.freeze({
              code:
                error instanceof ExtensionBrokerError && error.code === 'UNAUTHORIZED_ORIGIN'
                  ? 'UNAUTHORIZED_REQUEST'
                  : 'INVALID_REQUEST',
            }),
          }),
        );
      }
    })();
    return true;
  };
}
