import type { ChromeExtensionApi, ChromeStorageArea } from '@loom/extension';

export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: {
    readonly url: string;
    readonly interactive: boolean;
  }): Promise<string | undefined>;
}

export interface CodexChromeExtensionApi extends ChromeExtensionApi {
  readonly identity: ChromeIdentityApi;
  readonly storage: {
    readonly local: ChromeStorageArea;
    readonly session: ChromeStorageArea;
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

export interface BrowserCrypto {
  getRandomValues<T extends Uint8Array>(array: T): T;
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
  };
}
