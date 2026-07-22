import type {
  ChromeExtensionApi,
  ChromeMessageSender,
  ChromeStorageArea,
} from '@mgravey/loom-extension';

export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: {
    readonly url: string;
    readonly interactive: boolean;
  }): Promise<string | undefined>;
}

export interface ChromeTab {
  readonly id?: number;
}

export interface ChromeTabsApi {
  create(options: { readonly url: string; readonly active: boolean }): Promise<ChromeTab>;
  update(tabId: number, options: { readonly url: string }): Promise<ChromeTab>;
  getCurrent(): Promise<ChromeTab | undefined>;
  remove(tabId: number): Promise<void>;
}

export interface ChromeDeclarativeNetRequestRule {
  readonly id: number;
  readonly priority: number;
  readonly action: {
    readonly type: 'redirect';
    readonly redirect: { readonly regexSubstitution: string };
  };
  readonly condition: {
    readonly regexFilter: string;
    readonly resourceTypes: readonly ['main_frame'];
    readonly tabIds: readonly number[];
  };
}

export interface ChromeDeclarativeNetRequestApi {
  updateSessionRules(options: {
    readonly removeRuleIds?: readonly number[];
    readonly addRules?: readonly ChromeDeclarativeNetRequestRule[];
  }): Promise<void>;
}

export interface CodexExternalPort {
  readonly name: string;
  readonly sender?: ChromeMessageSender;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface CodexExternalConnectEvent {
  addListener(listener: (port: CodexExternalPort) => void): void;
}

export interface CodexChromeExtensionApi extends ChromeExtensionApi {
  readonly identity: ChromeIdentityApi;
  readonly declarativeNetRequest: ChromeDeclarativeNetRequestApi;
  readonly tabs: ChromeTabsApi;
  readonly storage: {
    readonly local: ChromeStorageArea;
    readonly session: ChromeStorageArea;
    readonly onChanged?: {
      addListener(
        listener: (changes: Readonly<Record<string, unknown>>, areaName: string) => void,
      ): void;
    };
  };
  readonly runtime: ChromeExtensionApi['runtime'] & {
    readonly id: string;
    getURL(path: string): string;
    getManifest?(): unknown;
    openOptionsPage(): Promise<void>;
    readonly onConnectExternal: CodexExternalConnectEvent;
  };
}

export interface OAuthFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type OAuthFetch = (
  input: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly cache: 'no-store';
    readonly credentials: 'omit';
    readonly redirect: 'error';
  },
) => Promise<OAuthFetchResponse>;

export interface CodexModelFetchResponse {
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type CodexModelFetch = (
  input: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly cache: 'no-store';
    readonly credentials: 'omit';
    readonly redirect: 'error';
    readonly signal: AbortSignal;
  },
) => Promise<CodexModelFetchResponse>;

export interface BrowserCrypto {
  getRandomValues<T extends Uint8Array>(array: T): T;
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
  };
}
