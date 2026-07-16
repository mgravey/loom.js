import type { ChromeExtensionApi, ChromeMessageSender, ChromeStorageArea } from '@loom/extension';

export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: {
    readonly url: string;
    readonly interactive: boolean;
  }): Promise<string | undefined>;
}

export interface CodexExternalPort {
  readonly name: string;
  readonly sender?: ChromeMessageSender;
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface CodexExternalConnectEvent {
  addListener(listener: (port: CodexExternalPort) => void): void;
}

export interface CodexChromeExtensionApi extends ChromeExtensionApi {
  readonly identity: ChromeIdentityApi;
  readonly storage: {
    readonly local: ChromeStorageArea;
    readonly session: ChromeStorageArea;
  };
  readonly runtime: ChromeExtensionApi['runtime'] & {
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
