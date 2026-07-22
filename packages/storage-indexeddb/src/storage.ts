import type { Storage } from '@mgravey/loom-plugin-api';
import type { NamespacedId } from '@mgravey/loom-types';

import { IndexedDbStorageError } from './errors.js';

const DATABASE_VERSION = 1;
const ENTRY_STORE = 'entries';
const NAMESPACE_INDEX = 'by-namespace';

interface StoredEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: ArrayBuffer;
}

export interface IndexedDbStorage extends Storage {
  dispose(): Promise<void>;
}

export interface CreateIndexedDbStorageOptions {
  readonly indexedDB: IDBFactory;
  readonly databaseName: string;
}

function errorCause(value: { readonly error: unknown }): unknown {
  return value.error ?? undefined;
}

function requestResult<Result>(request: IDBRequest<Result>, operation: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new IndexedDbStorageError(
          'REQUEST_FAILED',
          operation,
          `IndexedDB request failed during '${operation}'.`,
          { cause: errorCause(request) },
        ),
      );
  });
}

function transactionCompletion(transaction: IDBTransaction, operation: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        new IndexedDbStorageError(
          'TRANSACTION_FAILED',
          operation,
          `IndexedDB transaction failed during '${operation}'.`,
          { cause: errorCause(transaction) },
        ),
      );
    transaction.onabort = () =>
      reject(
        new IndexedDbStorageError(
          'TRANSACTION_FAILED',
          operation,
          `IndexedDB transaction aborted during '${operation}'.`,
          { cause: errorCause(transaction) },
        ),
      );
  });
}

function entryKey(namespace: NamespacedId, key: string): [string, string] {
  return [namespace, key];
}

function cloneBytes(value: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(value.byteLength);
  clone.set(value);
  return clone.buffer;
}

function storedEntry(value: unknown, operation: string): StoredEntry {
  if (typeof value !== 'object' || value === null) {
    throw new IndexedDbStorageError(
      'INVALID_DATA',
      operation,
      'IndexedDB returned an invalid storage entry.',
    );
  }
  const entry = value as Partial<StoredEntry>;
  if (
    typeof entry.namespace !== 'string' ||
    typeof entry.key !== 'string' ||
    !(entry.value instanceof ArrayBuffer)
  ) {
    throw new IndexedDbStorageError(
      'INVALID_DATA',
      operation,
      'IndexedDB returned a malformed storage entry.',
    );
  }
  return entry as StoredEntry;
}

function assertFactory(value: unknown): void {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    !('open' in value) ||
    typeof value.open !== 'function'
  ) {
    throw new TypeError('createIndexedDbStorage requires an IDBFactory.');
  }
}

function assertDatabaseName(value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('IndexedDB databaseName must be a non-empty string.');
  }
}

/** Creates a lazily opened, runtime-local IndexedDB storage capability. */
export function createIndexedDbStorage(options: CreateIndexedDbStorageOptions): IndexedDbStorage {
  assertFactory(options.indexedDB);
  assertDatabaseName(options.databaseName);

  let database: IDBDatabase | undefined;
  let pendingOpen: Promise<IDBDatabase> | undefined;
  let disposed = false;

  function closeDatabase(value: IDBDatabase): void {
    try {
      value.close();
    } catch {
      // Connection cleanup is intentionally best-effort and idempotent.
    }
  }

  function closed(operation: string): IndexedDbStorageError {
    return new IndexedDbStorageError(
      'STORAGE_CLOSED',
      operation,
      'IndexedDB storage has been disposed.',
    );
  }

  function assertActive(operation: string): void {
    if (disposed) throw closed(operation);
  }

  function validateSchema(value: IDBDatabase): void {
    if (!value.objectStoreNames.contains(ENTRY_STORE)) {
      throw new IndexedDbStorageError(
        'SCHEMA_FAILED',
        'open',
        `IndexedDB database is missing the '${ENTRY_STORE}' object store.`,
      );
    }
    const transaction = value.transaction(ENTRY_STORE, 'readonly');
    const store = transaction.objectStore(ENTRY_STORE);
    if (!store.indexNames.contains(NAMESPACE_INDEX)) {
      transaction.abort();
      throw new IndexedDbStorageError(
        'SCHEMA_FAILED',
        'open',
        `IndexedDB object store is missing the '${NAMESPACE_INDEX}' index.`,
      );
    }
  }

  async function openDatabase(): Promise<IDBDatabase> {
    if (disposed) throw closed('open');
    if (database !== undefined) return database;
    if (pendingOpen !== undefined) return pendingOpen;

    let request: IDBOpenDBRequest;
    try {
      request = options.indexedDB.open(options.databaseName, DATABASE_VERSION);
    } catch (error) {
      throw new IndexedDbStorageError(
        'OPEN_FAILED',
        'open',
        `Unable to open IndexedDB database '${options.databaseName}'.`,
        { cause: error },
      );
    }
    let upgradeFailure: unknown;
    let blocked = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        try {
          const nextDatabase = request.result;
          if (!nextDatabase.objectStoreNames.contains(ENTRY_STORE)) {
            const store = nextDatabase.createObjectStore(ENTRY_STORE, {
              keyPath: ['namespace', 'key'],
            });
            store.createIndex(NAMESPACE_INDEX, 'namespace', { unique: false });
          }
        } catch (error) {
          upgradeFailure = error;
          request.transaction?.abort();
        }
      };
      request.onblocked = () => {
        blocked = true;
        reject(
          new IndexedDbStorageError(
            'OPEN_BLOCKED',
            'open',
            `Opening IndexedDB database '${options.databaseName}' was blocked.`,
          ),
        );
      };
      request.onerror = () =>
        reject(
          new IndexedDbStorageError(
            upgradeFailure === undefined ? 'OPEN_FAILED' : 'SCHEMA_FAILED',
            'open',
            `Unable to open IndexedDB database '${options.databaseName}'.`,
            { cause: upgradeFailure ?? errorCause(request) },
          ),
        );
      request.onsuccess = () => {
        const opened = request.result;
        if (blocked || disposed) {
          closeDatabase(opened);
          if (disposed) reject(closed('open'));
          return;
        }
        try {
          validateSchema(opened);
          database = opened;
          resolve(opened);
        } catch (error) {
          closeDatabase(opened);
          reject(
            error instanceof IndexedDbStorageError
              ? error
              : new IndexedDbStorageError(
                  'SCHEMA_FAILED',
                  'open',
                  'Unable to validate the IndexedDB storage schema.',
                  { cause: error },
                ),
          );
        }
      };
    });
    pendingOpen = opening;
    try {
      return await opening;
    } finally {
      if (pendingOpen === opening) pendingOpen = undefined;
    }
  }

  async function operation<Result>(
    name: string,
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<Result>,
  ): Promise<Result> {
    assertActive(name);
    const currentDatabase = await openDatabase();
    assertActive(name);
    let transaction: IDBTransaction;
    try {
      transaction = currentDatabase.transaction(ENTRY_STORE, mode);
    } catch (error) {
      throw new IndexedDbStorageError(
        'TRANSACTION_FAILED',
        name,
        `Unable to create IndexedDB transaction for '${name}'.`,
        { cause: error },
      );
    }
    const completion = transactionCompletion(transaction, name);
    let request: IDBRequest<Result>;
    try {
      request = createRequest(transaction.objectStore(ENTRY_STORE));
    } catch (error) {
      transaction.abort();
      void completion.catch(() => undefined);
      throw new IndexedDbStorageError(
        'REQUEST_FAILED',
        name,
        `Unable to create IndexedDB request for '${name}'.`,
        { cause: error },
      );
    }
    const [result] = await Promise.all([requestResult(request, name), completion]);
    return result;
  }

  return Object.freeze({
    async get(namespace: NamespacedId, key: string): Promise<Uint8Array | undefined> {
      const result = await operation<unknown>('get', 'readonly', (store) =>
        store.get(entryKey(namespace, key)),
      );
      if (result === undefined) return undefined;
      const entry = storedEntry(result, 'get');
      return new Uint8Array(entry.value.slice(0));
    },

    async set(namespace: NamespacedId, key: string, value: Uint8Array): Promise<void> {
      const entry: StoredEntry = Object.freeze({
        namespace,
        key,
        value: cloneBytes(value),
      });
      await operation<IDBValidKey>('set', 'readwrite', (store) => store.put(entry));
    },

    async delete(namespace: NamespacedId, key: string): Promise<boolean> {
      const keyValue = entryKey(namespace, key);
      const existing = await operation<unknown>('delete-check', 'readonly', (store) =>
        store.get(keyValue),
      );
      if (existing === undefined) return false;
      await operation<undefined>('delete', 'readwrite', (store) => store.delete(keyValue));
      return true;
    },

    async list(namespace: NamespacedId): Promise<readonly string[]> {
      const values = await operation<unknown[]>('list', 'readonly', (store) =>
        store.index(NAMESPACE_INDEX).getAll(namespace),
      );
      const keys = values.map((value) => {
        const entry = storedEntry(value, 'list');
        if (entry.namespace !== namespace) {
          throw new IndexedDbStorageError(
            'INVALID_DATA',
            'list',
            'IndexedDB namespace index returned an entry from another namespace.',
          );
        }
        return entry.key;
      });
      keys.sort();
      return Object.freeze(keys);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const current = database;
      database = undefined;
      if (current !== undefined) {
        closeDatabase(current);
        return;
      }
      if (pendingOpen !== undefined) {
        try {
          const opened = await pendingOpen;
          closeDatabase(opened);
        } catch {
          // Opening failures require no additional cleanup.
        }
      }
    },
  });
}
