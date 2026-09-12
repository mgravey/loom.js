export type WorkbenchModelProvider = 'codex-experimental' | 'openai-compatible-responses';

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1' as const;
export const WORKBENCH_PROVIDER_STORAGE_KEY = 'loom.model-provider';
export const LOCAL_MODEL_BASE_URL_STORAGE_KEY = 'loom.local-model.base-url';
export const LOCAL_MODEL_ID_STORAGE_KEY = 'loom.local-model.model';
export const LOCAL_MODEL_API_KEY_STORAGE_KEY = 'loom.local-model.api-key';

const MAXIMUM_MODELS = 500;
const MAXIMUM_MODEL_ID_CHARACTERS = 200;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalModelConnectionSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

export function openAICompatibleBaseUrl(value: string): string {
  const source = value.trim();
  if (source === '') throw new TypeError('API base URL is required.');
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new TypeError('API base URL must be a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('API base URL must use HTTP or HTTPS.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('API base URL must not contain credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('API base URL must not contain a query or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (url.pathname === '') url.pathname = '/';
  return url.toString().replace(/\/$/u, '');
}

export function openAICompatibleEndpoint(
  baseUrl: string,
  resource: 'models' | 'responses',
): string {
  return `${openAICompatibleBaseUrl(baseUrl)}/${resource}`;
}

export function openAICompatibleModelIds(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Model discovery returned an invalid response.');
  }
  const data = (value as Readonly<Record<string, unknown>>).data;
  if (!Array.isArray(data) || data.length > MAXIMUM_MODELS) {
    throw new TypeError('Model discovery returned an invalid or oversized model list.');
  }
  const models: string[] = [];
  for (const candidate of data) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TypeError('Model discovery returned an invalid model entry.');
    }
    const id = (candidate as Readonly<Record<string, unknown>>).id;
    if (typeof id !== 'string' || id.trim() === '' || id.length > MAXIMUM_MODEL_ID_CHARACTERS) {
      throw new TypeError('Model discovery returned an invalid model ID.');
    }
    if (!models.includes(id)) models.push(id);
  }
  return Object.freeze(models);
}

export function loadWorkbenchProvider(storage: KeyValueStorage): WorkbenchModelProvider {
  return storage.getItem(WORKBENCH_PROVIDER_STORAGE_KEY) === 'openai-compatible-responses'
    ? 'openai-compatible-responses'
    : 'codex-experimental';
}

export function saveWorkbenchProvider(
  storage: KeyValueStorage,
  provider: WorkbenchModelProvider,
): void {
  storage.setItem(WORKBENCH_PROVIDER_STORAGE_KEY, provider);
}

export function loadLocalModelConnection(storage: KeyValueStorage): LocalModelConnectionSettings {
  const storedBaseUrl = storage.getItem(LOCAL_MODEL_BASE_URL_STORAGE_KEY);
  let baseUrl = DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
  if (storedBaseUrl !== null) {
    try {
      baseUrl = openAICompatibleBaseUrl(storedBaseUrl) as typeof DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
    } catch {
      // Ignore invalid legacy or manually edited storage values.
    }
  }
  return Object.freeze({
    baseUrl,
    model: storage.getItem(LOCAL_MODEL_ID_STORAGE_KEY) ?? '',
    apiKey: storage.getItem(LOCAL_MODEL_API_KEY_STORAGE_KEY) ?? '',
  });
}

export function saveLocalModelConnection(
  storage: KeyValueStorage,
  settings: LocalModelConnectionSettings,
): void {
  storage.setItem(LOCAL_MODEL_BASE_URL_STORAGE_KEY, openAICompatibleBaseUrl(settings.baseUrl));
  storage.setItem(LOCAL_MODEL_ID_STORAGE_KEY, settings.model.trim());
  if (settings.apiKey === '') storage.removeItem(LOCAL_MODEL_API_KEY_STORAGE_KEY);
  else storage.setItem(LOCAL_MODEL_API_KEY_STORAGE_KEY, settings.apiKey);
}

export function clearLocalModelApiKey(storage: KeyValueStorage): void {
  storage.removeItem(LOCAL_MODEL_API_KEY_STORAGE_KEY);
}
