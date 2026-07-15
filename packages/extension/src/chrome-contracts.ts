export interface ChromeStorageArea {
  setAccessLevel(options: { readonly accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

export interface ChromeMessageSender {
  readonly id?: string;
  readonly origin?: string;
  readonly url?: string;
}

export type ChromeSendResponse = (response: unknown) => void;

export type ChromeExternalMessageListener = (
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: ChromeSendResponse,
) => true;

export interface ChromeExternalMessageEvent {
  addListener(listener: ChromeExternalMessageListener): void;
}

export interface ChromeRuntimeApi {
  readonly onMessageExternal: ChromeExternalMessageEvent;
}

export interface ChromeExtensionApi {
  readonly runtime: ChromeRuntimeApi;
  readonly storage: {
    readonly local: ChromeStorageArea;
  };
}
