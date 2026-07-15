import { namespacedId } from '@loom/types';
import { describe, expect, it, vi } from 'vitest';

import {
  INDEXEDDB_STORAGE_CAPABILITY_ID,
  INDEXEDDB_STORAGE_KEY,
  INDEXEDDB_STORAGE_PLUGIN_ID,
  IndexedDbStorageError,
  createIndexedDbStorage,
  createIndexedDbStoragePlugin,
} from '../src/index.js';

interface FakeEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: ArrayBuffer;
}

type Failure = 'request' | 'transaction' | 'abort' | undefined;
type OpenOutcome = 'success' | 'error' | 'blocked';

class FakeIndexedDb {
  readonly records = new Map<string, FakeEntry>();
  readonly indexes = new Set<string>();
  readonly stores = new Set<string>();
  readonly close = vi.fn();
  openCount = 0;
  failure: Failure;
  skipUpgrade = false;
  openOutcome: OpenOutcome = 'success';
  transactionThrows = false;
  requestCreationThrows = false;
  leakIndex = false;

  private recordKey(key: IDBValidKey | IDBKeyRange): string {
    const [namespace, entry] = key as [string, string];
    return `${namespace}\u0000${entry}`;
  }

  private transaction(): IDBTransaction {
    if (this.transactionThrows) throw new Error('transaction creation failed');
    const transaction = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort: vi.fn(),
      objectStore: () => this.store(transaction as unknown as IDBTransaction),
    } as unknown as IDBTransaction;
    return transaction;
  }

  private request<Result>(
    transaction: IDBTransaction,
    result: () => Result,
    mutation?: () => void,
  ): IDBRequest<Result> {
    const request = {
      result: undefined as Result,
      error: null,
      onsuccess: null,
      onerror: null,
    } as unknown as IDBRequest<Result>;
    queueMicrotask(() => {
      if (this.failure === 'request') {
        this.failure = undefined;
        Object.defineProperty(request, 'error', { value: new Error('request failed') });
        request.onerror?.(new Event('error'));
        transaction.onerror?.(new Event('error'));
        return;
      }
      mutation?.();
      Object.defineProperty(request, 'result', { value: result() });
      request.onsuccess?.(new Event('success'));
      queueMicrotask(() => {
        if (this.failure === 'transaction' || this.failure === 'abort') {
          const failure = this.failure;
          this.failure = undefined;
          Object.defineProperty(transaction, 'error', {
            value: new Error('transaction failed'),
          });
          if (failure === 'abort') transaction.onabort?.(new Event('abort'));
          else transaction.onerror?.(new Event('error'));
        } else {
          transaction.oncomplete?.(new Event('complete'));
        }
      });
    });
    return request;
  }

  private store(transaction: IDBTransaction): IDBObjectStore {
    return {
      indexNames: { contains: (name: string) => this.indexes.has(name) },
      createIndex: (name: string) => {
        this.indexes.add(name);
        return {} as IDBIndex;
      },
      get: (key: IDBValidKey | IDBKeyRange) =>
        this.requestCreationThrows
          ? (() => {
              throw new Error('request creation failed');
            })()
          : this.request(transaction, () => this.records.get(this.recordKey(key))),
      put: (value: FakeEntry) =>
        this.request(
          transaction,
          () => [value.namespace, value.key] as IDBValidKey,
          () => this.records.set(this.recordKey([value.namespace, value.key]), value),
        ),
      delete: (key: IDBValidKey | IDBKeyRange) =>
        this.request(
          transaction,
          () => undefined,
          () => void this.records.delete(this.recordKey(key)),
        ),
      index: () =>
        ({
          getAll: (namespace: string) =>
            this.request(transaction, () =>
              [...this.records.values()].filter(
                (entry) => this.leakIndex || entry.namespace === namespace,
              ),
            ),
        }) as unknown as IDBIndex,
    } as unknown as IDBObjectStore;
  }

  readonly factory = {
    open: (name: string, version?: number) => {
      void name;
      void version;
      this.openCount += 1;
      const database = {
        objectStoreNames: { contains: (name: string) => this.stores.has(name) },
        createObjectStore: (name: string) => {
          this.stores.add(name);
          return this.store(this.transaction());
        },
        transaction: () => this.transaction(),
        close: this.close,
      } as unknown as IDBDatabase;
      const request = {
        result: database,
        error: null,
        transaction: this.transaction(),
        onupgradeneeded: null,
        onblocked: null,
        onerror: null,
        onsuccess: null,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (!this.skipUpgrade) request.onupgradeneeded?.(new Event('upgradeneeded') as never);
        if (this.openOutcome === 'error') {
          Object.defineProperty(request, 'error', { value: new Error('async open failed') });
          request.onerror?.(new Event('error'));
        } else if (this.openOutcome === 'blocked') {
          request.onblocked?.(new Event('blocked') as never);
          request.onsuccess?.(new Event('success'));
        } else {
          request.onsuccess?.(new Event('success'));
        }
      });
      return request;
    },
  } as IDBFactory;
}

describe('IndexedDB storage', () => {
  it('clones bytes, isolates namespaces, sorts keys, and deletes deterministically', async () => {
    const fake = new FakeIndexedDb();
    const storage = createIndexedDbStorage({ indexedDB: fake.factory, databaseName: 'loom-test' });
    const first = namespacedId('test/first');
    const second = namespacedId('test/second');
    const input = new Uint8Array([1, 2, 3]);

    await storage.set(first, 'zeta', input);
    input[0] = 9;
    await storage.set(first, 'alpha', new Uint8Array([4]));
    await storage.set(second, 'other', new Uint8Array([5]));

    const output = await storage.get(first, 'zeta');
    expect(output).toEqual(new Uint8Array([1, 2, 3]));
    if (output !== undefined) output[1] = 8;
    expect(await storage.get(first, 'zeta')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.get(first, 'missing')).toBeUndefined();
    expect(await storage.list(first)).toEqual(['alpha', 'zeta']);
    expect(await storage.list(second)).toEqual(['other']);
    expect(await storage.delete(first, 'zeta')).toBe(true);
    expect(await storage.delete(first, 'zeta')).toBe(false);
    expect(fake.openCount).toBe(1);
  });

  it('maps request, transaction, open, and schema failures', async () => {
    const namespace = namespacedId('test/errors');
    const requestFake = new FakeIndexedDb();
    const requestStorage = createIndexedDbStorage({
      indexedDB: requestFake.factory,
      databaseName: 'requests',
    });
    await requestStorage.set(namespace, 'ready', new Uint8Array());
    requestFake.failure = 'request';
    await expect(requestStorage.get(namespace, 'ready')).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      operation: 'get',
    });

    requestFake.failure = 'transaction';
    await expect(requestStorage.get(namespace, 'ready')).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      operation: 'get',
    });
    requestFake.failure = 'abort';
    await expect(requestStorage.get(namespace, 'ready')).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      operation: 'get',
    });
    requestFake.requestCreationThrows = true;
    await expect(requestStorage.get(namespace, 'ready')).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      operation: 'get',
    });
    requestFake.requestCreationThrows = false;
    requestFake.transactionThrows = true;
    await expect(requestStorage.get(namespace, 'ready')).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      operation: 'get',
    });

    const openCause = new Error('open failed');
    const failingFactory = {
      open: () => {
        throw openCause;
      },
    } as unknown as IDBFactory;
    const openStorage = createIndexedDbStorage({
      indexedDB: failingFactory,
      databaseName: 'open-error',
    });
    await expect(openStorage.list(namespace)).rejects.toMatchObject({
      code: 'OPEN_FAILED',
      cause: openCause,
    });

    const asyncOpenFake = new FakeIndexedDb();
    asyncOpenFake.openOutcome = 'error';
    await expect(
      createIndexedDbStorage({
        indexedDB: asyncOpenFake.factory,
        databaseName: 'async-open-error',
      }).list(namespace),
    ).rejects.toMatchObject({ code: 'OPEN_FAILED' });

    const blockedFake = new FakeIndexedDb();
    blockedFake.openOutcome = 'blocked';
    await expect(
      createIndexedDbStorage({
        indexedDB: blockedFake.factory,
        databaseName: 'blocked',
      }).list(namespace),
    ).rejects.toMatchObject({ code: 'OPEN_BLOCKED' });
    expect(blockedFake.close).toHaveBeenCalledOnce();

    const schemaFake = new FakeIndexedDb();
    schemaFake.skipUpgrade = true;
    const schemaStorage = createIndexedDbStorage({
      indexedDB: schemaFake.factory,
      databaseName: 'schema-error',
    });
    await expect(schemaStorage.list(namespace)).rejects.toMatchObject({
      code: 'SCHEMA_FAILED',
    });

    const missingIndexFake = new FakeIndexedDb();
    missingIndexFake.skipUpgrade = true;
    missingIndexFake.stores.add('entries');
    await expect(
      createIndexedDbStorage({
        indexedDB: missingIndexFake.factory,
        databaseName: 'missing-index',
      }).list(namespace),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAILED' });
  });

  it('rejects corrupt records and index results', async () => {
    const namespace = namespacedId('test/corrupt');
    const fake = new FakeIndexedDb();
    const storage = createIndexedDbStorage({ indexedDB: fake.factory, databaseName: 'corrupt' });
    await storage.set(namespace, 'value', new Uint8Array([1]));
    const recordKey = [...fake.records.keys()][0];
    if (recordKey === undefined) throw new Error('fixture failed');
    fake.records.set(recordKey, null as unknown as FakeEntry);
    await expect(storage.get(namespace, 'value')).rejects.toMatchObject({ code: 'INVALID_DATA' });

    fake.records.set(recordKey, {
      namespace,
      key: 'value',
      value: 'not-bytes' as unknown as ArrayBuffer,
    });
    await expect(storage.get(namespace, 'value')).rejects.toMatchObject({ code: 'INVALID_DATA' });

    fake.records.set(recordKey, {
      namespace: 'test/other',
      key: 'value',
      value: new ArrayBuffer(0),
    });
    fake.leakIndex = true;
    await expect(storage.list(namespace)).rejects.toMatchObject({ code: 'INVALID_DATA' });
  });

  it('registers only the fixed storage capability and closes idempotently', async () => {
    const fake = new FakeIndexedDb();
    const plugin = createIndexedDbStoragePlugin({
      indexedDB: fake.factory,
      databaseName: 'plugin-test',
    });
    const register = vi.fn();
    await plugin.initialize?.({ capabilities: { register } } as never);
    const storage = register.mock.calls[0]?.[1] as ReturnType<typeof createIndexedDbStorage>;
    await storage.list(namespacedId('test/plugin'));

    expect(plugin.manifest.id).toBe(INDEXEDDB_STORAGE_PLUGIN_ID);
    expect(INDEXEDDB_STORAGE_KEY.id).toBe(INDEXEDDB_STORAGE_CAPABILITY_ID);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toEqual(INDEXEDDB_STORAGE_KEY);
    await plugin.dispose?.({} as never);
    await plugin.dispose?.({} as never);
    expect(fake.close).toHaveBeenCalledOnce();
    await expect(storage.list(namespacedId('test/plugin'))).rejects.toBeInstanceOf(
      IndexedDbStorageError,
    );
  });

  it('validates explicit construction options without consulting globals', () => {
    expect(() =>
      createIndexedDbStorage({ indexedDB: {} as IDBFactory, databaseName: 'valid' }),
    ).toThrow(/IDBFactory/);
    expect(() =>
      createIndexedDbStorage({ indexedDB: new FakeIndexedDb().factory, databaseName: '   ' }),
    ).toThrow(/databaseName/);
  });

  it('shares a pending lazy open and closes safely while opening', async () => {
    const fake = new FakeIndexedDb();
    const storage = createIndexedDbStorage({ indexedDB: fake.factory, databaseName: 'pending' });
    const namespace = namespacedId('test/pending');
    const first = storage.list(namespace);
    const second = storage.list(namespace);
    await Promise.all([first, second]);
    expect(fake.openCount).toBe(1);

    const closingFake = new FakeIndexedDb();
    closingFake.close.mockImplementationOnce(() => {
      throw new Error('best effort close');
    });
    const closing = createIndexedDbStorage({
      indexedDB: closingFake.factory,
      databaseName: 'closing',
    });
    const pending = closing.list(namespace);
    await closing.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'STORAGE_CLOSED' });
    await expect(closing.dispose()).resolves.toBeUndefined();
  });
});
