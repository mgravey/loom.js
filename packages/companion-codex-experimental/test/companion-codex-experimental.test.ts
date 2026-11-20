import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_COMPANION_PROVIDER_ID,
  CODEX_MODEL_PORT_NAME,
  CODEX_MODEL_TRANSPORT_PROTOCOL,
  CODEX_ORIGIN_ACCESS_PROTOCOL,
  CodexCompanionError,
  LOOM_COMPANION_EXTENSION_ID,
  createCodexCompanion,
  createCodexExtensionTransport,
  createExtensionResponsesTransport,
  getExtensionResponsesConnection,
  listExtensionResponsesModels,
  requestCodexOriginAccess,
  type CodexCompanionPort,
  type CodexCompanionRuntime,
} from '../src/index.js';

interface PortHarness {
  readonly port: CodexCompanionPort;
  readonly posted: unknown[];
  readonly disconnectSpy: ReturnType<typeof vi.fn>;
  listenerCount(): number;
  message(value: unknown): void;
  disconnect(): void;
}

function createPortHarness(): PortHarness {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const posted: unknown[] = [];
  let disconnected = false;
  const disconnectSpy = vi.fn();
  const remove = <Listener>(listeners: Listener[], listener: Listener): void => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
  return {
    posted,
    disconnectSpy,
    port: {
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        },
        removeListener(listener) {
          remove(messageListeners, listener);
        },
      },
      onDisconnect: {
        addListener(listener) {
          disconnectListeners.push(listener);
        },
        removeListener(listener) {
          remove(disconnectListeners, listener);
        },
      },
      postMessage(message) {
        posted.push(message);
      },
      disconnect() {
        disconnectSpy();
        if (disconnected) return;
        disconnected = true;
        for (const listener of [...disconnectListeners]) listener();
      },
    },
    listenerCount: () => messageListeners.length + disconnectListeners.length,
    message(value) {
      for (const listener of [...messageListeners]) listener(value);
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const listener of [...disconnectListeners]) listener();
    },
  };
}

async function collect(values: AsyncIterable<string>): Promise<readonly string[]> {
  const collected: string[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

function createTestCancellationSource(): {
  readonly signal: {
    readonly cancelled: boolean;
    readonly reason: unknown;
    throwIfCancelled(): void;
    onCancel(listener: (reason: unknown) => void): () => void;
  };
  cancel(reason: unknown): void;
} {
  const listeners = new Set<(reason: unknown) => void>();
  let cancelled = false;
  let cancellationReason: unknown;
  return {
    signal: {
      get cancelled() {
        return cancelled;
      },
      get reason() {
        return cancellationReason;
      },
      throwIfCancelled() {
        if (cancelled) throw new Error('cancelled');
      },
      onCancel(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      cancellationReason = reason;
      for (const listener of [...listeners]) listener(reason);
      listeners.clear();
    },
  };
}

describe('experimental Loom.js Companion client', () => {
  it('requests explicit origin approval through the published extension ID', async () => {
    const sendMessage = vi.fn(
      (
        extensionId: string,
        message: unknown,
        _options: undefined,
        callback: (response: unknown) => void,
      ) => {
        expect(extensionId).toBe(LOOM_COMPANION_EXTENSION_ID);
        expect(message).toMatchObject({
          protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
          type: 'requestOriginAccess',
        });
        const requestId = (message as { readonly requestId: string }).requestId;
        callback({
          protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
          version: 1,
          type: 'originAccessResult',
          requestId,
          ok: true,
          approved: false,
        });
      },
    );
    const runtime = {
      sendMessage,
      connect: vi.fn(),
    } as unknown as CodexCompanionRuntime;

    await expect(requestCodexOriginAccess({ runtime })).resolves.toEqual({ approved: false });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('completes once, acknowledges end, and ignores a delayed disconnect', async () => {
    const harness = createPortHarness();
    const diagnostics: unknown[] = [];
    const connect = vi.fn((extensionId: string, options: { readonly name: string }) => {
      expect(extensionId).toBe(LOOM_COMPANION_EXTENSION_ID);
      expect(options.name).toBe(CODEX_MODEL_PORT_NAME);
      return harness.port;
    });
    const runtime = { connect, sendMessage: vi.fn() } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestIdFactory: () => 'request-1',
      diagnosticSink: (event) => diagnostics.push(event),
    });

    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
    });
    expect(harness.posted).toEqual([
      {
        protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
        version: 1,
        type: 'generate',
        requestId: 'request-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
        body: '{"model":"gpt-5.6-sol","input":[]}',
        wireProtocol: 'responses-lite',
      },
    ]);

    harness.message({ type: 'start', requestId: 'request-1', status: 200 });
    const response = await responsePromise;
    harness.message({ type: 'chunk', requestId: 'request-1', chunk: 'data: first\n\n' });
    harness.message({ type: 'chunk', requestId: 'request-1', chunk: 'data: second\n\n' });
    harness.message({ type: 'end', requestId: 'request-1' });
    harness.message({ type: 'end', requestId: 'request-1' });
    harness.message({ type: 'error', requestId: 'request-1', code: 'late-error' });
    harness.disconnect();

    await expect(collect(response.body)).resolves.toEqual(['data: first\n\n', 'data: second\n\n']);
    expect(response.status).toBe(200);
    expect(harness.posted).toContainEqual({ type: 'end-ack', requestId: 'request-1' });
    expect(
      harness.posted.filter(
        (message) =>
          (message as Readonly<Record<string, unknown>>).type === 'end-ack' &&
          (message as Readonly<Record<string, unknown>>).requestId === 'request-1',
      ),
    ).toHaveLength(1);
    expect(harness.disconnectSpy).not.toHaveBeenCalled();
    expect(harness.listenerCount()).toBe(0);
    expect(
      diagnostics.filter(
        (event) =>
          (event as Readonly<Record<string, unknown>>).event === 'model.response.completed',
      ),
    ).toHaveLength(1);
  });

  it('routes compaction as an explicit credential-free operation', async () => {
    const harness = createPortHarness();
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-compact',
      requestIdFactory: () => 'request-compact',
    });

    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[],"instructions":""}',
      operation: 'compact',
      wireProtocol: 'responses-lite',
    });
    expect(harness.posted).toContainEqual(
      expect.objectContaining({
        type: 'compact',
        requestId: 'request-compact',
        sessionId: 'session-compact',
      }),
    );
    harness.message({ type: 'start', requestId: 'request-compact', status: 200 });
    const response = await responsePromise;
    harness.message({
      type: 'chunk',
      requestId: 'request-compact',
      chunk: '{"output":[{"type":"compaction","encrypted_content":"opaque"}]}',
    });
    harness.message({ type: 'end', requestId: 'request-compact' });

    await expect(collect(response.body)).resolves.toEqual([
      '{"output":[{"type":"compaction","encrypted_content":"opaque"}]}',
    ]);
  });

  it('maps extension failures to sanitized transport errors', async () => {
    const harness = createPortHarness();
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'request-2',
    });
    const response = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
    });

    harness.message({
      type: 'error',
      requestId: 'request-2',
      code: 'UNAUTHORIZED_ORIGIN',
      message: 'secret provider detail',
    });

    await expect(response).rejects.toMatchObject({
      name: 'CodexCompanionError',
      code: 'EXTENSION_REQUEST_FAILED',
      remoteCode: 'UNAUTHORIZED_ORIGIN',
    });
    await expect(response).rejects.not.toThrow('secret provider detail');
  });

  it('keeps remote failure stages and does not report an authentication rejection as disconnection', async () => {
    const harness = createPortHarness();
    const diagnostics: unknown[] = [];
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'compact-auth',
      diagnosticSink: (event) => diagnostics.push(event),
    });
    const pending = transport.send({
      operation: 'compact',
      wireProtocol: 'responses-lite',
      body: '{}',
    });
    harness.message({
      type: 'error',
      requestId: 'compact-auth',
      code: 'AUTHENTICATION_FAILED',
      stage: 'authentication',
      message: 'prompt encrypted_content private-token',
    });
    await expect(pending).rejects.toMatchObject({
      code: 'EXTENSION_REQUEST_FAILED',
      remoteCode: 'AUTHENTICATION_FAILED',
      requestId: 'compact-auth',
      operation: 'compact',
      stage: 'authentication',
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        event: 'model.connection.closed',
        operation: 'compact',
        code: 'FAILED',
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain('DISCONNECTED');
    expect(JSON.stringify(diagnostics)).not.toContain('private-token');
    expect(harness.listenerCount()).toBe(0);
  });

  it('validates and exposes only bounded provider failure metadata', async () => {
    const harness = createPortHarness();
    const diagnostics: unknown[] = [];
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'request-provider-error',
      diagnosticSink: (event) => diagnostics.push(event),
    });
    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
    });

    harness.message({
      type: 'start',
      requestId: 'request-provider-error',
      status: 429,
    });
    harness.message({
      type: 'provider-error',
      requestId: 'request-provider-error',
      status: 429,
      providerCode: 'rate_limit_exceeded',
      providerMessage: 'Rate limited. cookie=session-secret',
      retryable: true,
      retryAfterMs: 15_000,
      headers: { authorization: 'private' },
      error: { body: 'private response body' },
    });
    harness.message({ type: 'end', requestId: 'request-provider-error' });
    harness.message({ type: 'provider-error', requestId: 'request-provider-error', status: 429 });

    await expect(responsePromise).resolves.toMatchObject({
      status: 429,
      providerCode: 'rate_limit_exceeded',
      providerMessage: 'Rate limited. cookie: [REDACTED]',
      retryable: true,
      retryAfterMs: 15_000,
    });
    const response = await responsePromise;
    expect(response).not.toHaveProperty('headers');
    expect(response).not.toHaveProperty('error');
    expect(JSON.stringify(response)).not.toContain('private response body');
    expect(JSON.stringify(diagnostics)).not.toContain('session-secret');
    expect(harness.posted).toContainEqual({
      type: 'end-ack',
      requestId: 'request-provider-error',
    });
    expect(harness.listenerCount()).toBe(0);
    expect(
      diagnostics.filter(
        (event) => (event as Readonly<Record<string, unknown>>).event === 'model.provider.rejected',
      ),
    ).toHaveLength(1);
  });

  it('falls back safely when extension provider metadata fails validation', async () => {
    const harness = createPortHarness();
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'request-invalid-provider-error',
    });
    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
    });
    harness.message({
      type: 'start',
      requestId: 'request-invalid-provider-error',
      status: 503,
    });
    harness.message({
      type: 'provider-error',
      requestId: 'request-invalid-provider-error',
      status: 503,
      providerCode: 'invalid code with spaces',
      providerMessage: 'x'.repeat(513),
      retryable: 'yes',
      retryAfterMs: Number.MAX_SAFE_INTEGER,
    });
    harness.message({ type: 'end', requestId: 'request-invalid-provider-error' });

    await expect(responsePromise).resolves.toMatchObject({
      status: 503,
      providerMessage: 'The provider rejected the request.',
      retryable: false,
    });
    const response = await responsePromise;
    expect(response.providerCode).toBeUndefined();
    expect(response.retryAfterMs).toBeUndefined();
  });

  it('fails a started stream when the extension disconnects early', async () => {
    const harness = createPortHarness();
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'request-3',
    });
    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
    });
    harness.message({ type: 'start', requestId: 'request-3', status: 200 });
    const response = await responsePromise;
    harness.disconnect();

    await expect(collect(response.body)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
    expect(harness.listenerCount()).toBe(0);
  });

  it('rejects malformed terminal messages instead of completing an incomplete response', async () => {
    const harness = createPortHarness();
    const diagnostics: unknown[] = [];
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'request-malformed-end',
      diagnosticSink: (event) => diagnostics.push(event),
    });
    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
    });
    harness.message({ type: 'start', requestId: 'request-malformed-end', status: 200 });
    const response = await responsePromise;
    harness.message({
      type: 'end',
      requestId: 'request-malformed-end',
      unexpected: true,
    });

    await expect(collect(response.body)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(harness.posted).not.toContainEqual({
      type: 'end-ack',
      requestId: 'request-malformed-end',
    });
    expect(harness.disconnectSpy).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
    expect(
      diagnostics.filter(
        (event) =>
          (event as Readonly<Record<string, unknown>>).event === 'model.response.completed',
      ),
    ).toHaveLength(0);
  });

  it('preserves cancellation and removes its abort handler exactly once', async () => {
    const harness = createPortHarness();
    const diagnostics: unknown[] = [];
    const cancellation = createTestCancellationSource();
    const unsubscribe = vi.fn();
    const signal = {
      ...cancellation.signal,
      onCancel(listener: (reason: unknown) => void) {
        const remove = cancellation.signal.onCancel(listener);
        return () => {
          unsubscribe();
          remove();
        };
      },
    };
    const runtime = {
      connect: () => harness.port,
      sendMessage: vi.fn(),
    } as unknown as CodexCompanionRuntime;
    const transport = createCodexExtensionTransport({
      runtime,
      sessionId: 'session-1',
      requestIdFactory: () => 'request-cancelled',
      diagnosticSink: (event) => diagnostics.push(event),
    });
    const responsePromise = transport.send({
      body: '{"model":"gpt-5.6-sol","input":[]}',
      wireProtocol: 'responses-lite',
      signal,
    });

    cancellation.cancel(new Error('cancelled by user'));
    cancellation.cancel(new Error('duplicate cancellation'));

    await expect(responsePromise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(harness.disconnectSpy).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(
      diagnostics.filter(
        (event) => (event as Readonly<Record<string, unknown>>).event === 'model.request.cancelled',
      ),
    ).toHaveLength(1);
  });

  it('composes origin approval, extension authentication, and model transport', async () => {
    const harness = createPortHarness();
    const runtime: CodexCompanionRuntime = {
      connect: () => harness.port,
      sendMessage(_extensionId, message, _options, callback) {
        const request = message as Readonly<Record<string, unknown>>;
        if (request.protocol === CODEX_ORIGIN_ACCESS_PROTOCOL) {
          callback({
            protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
            version: 1,
            type: 'originAccessResult',
            requestId: request.requestId,
            ok: true,
            approved: true,
          });
          return;
        }
        callback({
          protocol: 'loom/credential-broker',
          version: 1,
          type: 'getCredentialStatusResult',
          requestId: request.requestId,
          ok: true,
          authenticated: true,
        });
      },
    };
    const companion = createCodexCompanion({
      runtime,
      sessionId: 'session-1',
    });

    expect(companion.configuration).toEqual({
      extensionId: LOOM_COMPANION_EXTENSION_ID,
      providerId: CODEX_COMPANION_PROVIDER_ID,
    });
    await expect(companion.ensureOriginAccess()).resolves.toBeUndefined();
    await expect(companion.auth.isAuthenticated()).resolves.toBe(true);
    expect(companion.transport).toHaveProperty('send');
    expect(companion.fetch).toBeTypeOf('function');
    expect(companion.authPlugin.manifest.id).toBe('loom/auth-extension');
  });

  it('rejects missing Chrome runtime configuration', () => {
    expect(() =>
      createCodexExtensionTransport({
        runtime: undefined as unknown as CodexCompanionRuntime,
        sessionId: 'session-1',
      }),
    ).toThrow(CodexCompanionError);
  });
});

describe('custom Responses Companion transport', () => {
  it('sends only a saved connection ID, preserves JSON content type and cleans up an early consumer', async () => {
    const harness = createPortHarness();
    const connect = vi.fn(() => harness.port);
    const runtime = { connect, sendMessage: vi.fn() } as unknown as CodexCompanionRuntime;
    const transport = createExtensionResponsesTransport({
      runtime,
      sessionId: 'session',
      connectionId: 'local',
      requestIdFactory: () => 'custom-1',
    });
    const pending = transport.send({ body: '{"model":"local","input":[]}' });
    expect(connect).toHaveBeenCalledWith(expect.any(String), { name: 'loom/responses/v1' });
    expect(harness.posted[0]).toMatchObject({
      protocol: 'loom/responses',
      connectionId: 'local',
      type: 'generate',
      wireProtocol: 'classic',
    });
    expect(harness.posted[0]).not.toHaveProperty('endpoint');
    expect(harness.posted[0]).not.toHaveProperty('headers');
    harness.message({
      type: 'start',
      requestId: 'custom-1',
      status: 200,
      contentType: 'application/json',
    });
    const response = await pending;
    expect(response.contentType).toBe('application/json');
    harness.message({ type: 'chunk', requestId: 'custom-1', chunk: '{}' });
    for await (const chunk of response.body) {
      expect(chunk).toBe('{}');
      break;
    }
    expect(harness.disconnectSpy).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
  });
  it('cancels a pending custom request without retrying or leaving listeners', async () => {
    const harness = createPortHarness();
    const cancellation = createTestCancellationSource();
    const connect = vi.fn(() => harness.port);
    const transport = createExtensionResponsesTransport({
      runtime: { connect, sendMessage: vi.fn() } as unknown as CodexCompanionRuntime,
      sessionId: 'session',
      connectionId: 'local',
    });
    const pending = transport.send({
      body: '{"model":"local","input":[]}',
      signal: cancellation.signal,
    });
    cancellation.cancel('stop');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(connect).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
  });
  it('returns only connection metadata, never keys or extra remote fields', async () => {
    const runtime: CodexCompanionRuntime = {
      connect: vi.fn(),
      sendMessage(_id, message, _options, callback) {
        expect(message).toEqual({
          protocol: 'loom/responses-connections',
          version: 1,
          type: 'get',
          connectionId: 'local',
        });
        callback({
          ok: true,
          connection: {
            id: 'local',
            label: 'Local',
            endpoint: 'http://localhost:11434/v1/responses',
            apiKey: 'must-not-escape',
          },
        });
      },
    };
    await expect(
      getExtensionResponsesConnection({ runtime, connectionId: 'local', sessionId: 'session' }),
    ).resolves.toEqual({
      id: 'local',
      label: 'Local',
      endpoint: 'http://localhost:11434/v1/responses',
    });
  });
});

it('merges model IDs with collision-free server prefixes while preserving raw slash/colon model names', async () => {
  const runtime: CodexCompanionRuntime = {
    connect: vi.fn(),
    sendMessage(_id, message, _options, callback) {
      expect(message).toEqual({
        protocol: 'loom/responses-connections',
        version: 1,
        type: 'catalogue',
      });
      callback({
        ok: true,
        servers: [
          {
            id: 'a',
            label: 'Same label',
            models: ['org/model:latest', 'org/model:latest'],
            unavailable: false,
            apiKey: 'secret',
          },
          { id: 'b', label: 'Same label', models: ['org/model:latest'], unavailable: false },
          { id: 'offline', label: 'Offline', models: [], unavailable: true },
        ],
      });
    },
  };
  const result = await listExtensionResponsesModels({ runtime, sessionId: 'session' });
  expect(result.models).toEqual([
    {
      id: 'responses:a/org/model:latest',
      model: 'org/model:latest',
      connectionId: 'a',
      serverLabel: 'Same label',
    },
    {
      id: 'responses:b/org/model:latest',
      model: 'org/model:latest',
      connectionId: 'b',
      serverLabel: 'Same label',
    },
  ]);
  expect(result.unavailableConnections).toEqual([{ id: 'offline', label: 'Offline' }]);
  expect(JSON.stringify(result)).not.toContain('secret');
});
