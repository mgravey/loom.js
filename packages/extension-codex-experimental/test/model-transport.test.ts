import type { ExtensionTokenService, OriginAuthorizer } from '@mgravey/loom-extension';
import { describe, expect, it, vi } from 'vitest';

import type { CodexAccountRoutingStore } from '../src/account-routing.js';
import type { CodexExternalPort, CodexModelFetch } from '../src/chrome-contracts.js';
import {
  CODEX_MODEL_END_ACK_TIMEOUT_MS,
  CODEX_MODEL_PORT_NAME,
  CODEX_MODEL_TRANSPORT_PROTOCOL,
  CODEX_MODEL_TRANSPORT_VERSION,
  CODEX_RESPONSES_COMPACT_ENDPOINT,
  CODEX_RESPONSES_ENDPOINT,
  createCodexModelPortListener,
  type CodexModelDiagnosticEvent,
} from '../src/model-transport.js';

function tokenService(): ExtensionTokenService {
  return {
    getAccessToken: vi.fn(() =>
      Promise.resolve({ accessToken: 'private-access-token', expiresAt: Date.now() + 60_000 }),
    ),
    getStatus: vi.fn(() => Promise.resolve({ authenticated: true })),
    logout: vi.fn(() => Promise.resolve()),
    acceptAuthorizationResult: vi.fn(),
    clearCachedAccessToken: vi.fn(),
  };
}

function routingStore(): CodexAccountRoutingStore {
  return {
    get: vi.fn(() => Promise.resolve('account-test')),
    set: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  };
}

function port(): {
  readonly value: CodexExternalPort;
  readonly messages: unknown[];
  readonly disconnect: ReturnType<typeof vi.fn>;
  listenerCount(): number;
  send(message: unknown): void;
  disconnectExternally(): void;
} {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const messages: unknown[] = [];
  const disconnect = vi.fn();
  return {
    messages,
    disconnect,
    value: {
      name: CODEX_MODEL_PORT_NAME,
      sender: { origin: 'http://localhost:4173', url: 'http://localhost:4173/app' },
      onMessage: {
        addListener: (listener) => messageListeners.push(listener),
        removeListener: (listener) => {
          const index = messageListeners.indexOf(listener);
          if (index >= 0) messageListeners.splice(index, 1);
        },
      },
      onDisconnect: {
        addListener: (listener) => disconnectListeners.push(listener),
        removeListener: (listener) => {
          const index = disconnectListeners.indexOf(listener);
          if (index >= 0) disconnectListeners.splice(index, 1);
        },
      },
      postMessage: (message) => messages.push(message),
      disconnect,
    },
    listenerCount: () => messageListeners.length + disconnectListeners.length,
    send(message) {
      for (const listener of [...messageListeners]) listener(message);
    },
    disconnectExternally() {
      for (const listener of [...disconnectListeners]) listener();
    },
  };
}

function request(
  wireProtocol: 'classic' | 'responses-lite' = 'classic',
): Readonly<Record<string, unknown>> {
  const tools: readonly unknown[] = [];
  const input =
    wireProtocol === 'classic'
      ? []
      : [
          { type: 'additional_tools', role: 'developer', tools },
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Use tools when needed.' }],
          },
        ];
  return Object.freeze({
    protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: 'generate',
    requestId: 'request-1',
    sessionId: 'session-1',
    threadId: 'thread-1',
    wireProtocol,
    body: JSON.stringify({
      model: 'gpt-test',
      ...(wireProtocol === 'classic' ? { instructions: 'Use tools when needed.', tools } : {}),
      input,
      tool_choice: 'auto',
      parallel_tool_calls: wireProtocol === 'classic',
      reasoning:
        wireProtocol === 'classic'
          ? { effort: 'medium' }
          : { effort: 'medium', context: 'all_turns' },
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'low' },
    }),
  });
}

function compactRequest(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: 'compact',
    requestId: 'request-compact',
    sessionId: 'session-1',
    threadId: 'thread-1',
    wireProtocol: 'responses-lite',
    body: JSON.stringify({
      model: 'gpt-test',
      input: [{ type: 'compaction', encrypted_content: 'opaque' }],
      instructions: 'Preserve decisions.',
      tools: [],
      parallel_tool_calls: false,
      reasoning: { effort: 'medium', context: 'all_turns' },
      text: { verbosity: 'low' },
    }),
  });
}

async function waitForMessage(
  messages: readonly unknown[],
  expected: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (messages.some((message) => JSON.stringify(message) === JSON.stringify(expected))) return;
    await Promise.resolve();
  }
  throw new Error(`Message was not posted: ${JSON.stringify(expected)}`);
}

describe('experimental Codex extension model transport', () => {
  it('keeps credentials extension-side and streams provider bytes over an authorized port', async () => {
    const diagnostics: CodexModelDiagnosticEvent[] = [];
    const encoder = new TextEncoder();
    const fetchRequest = vi.fn<CodexModelFetch>(() =>
      Promise.resolve({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
            controller.close();
          },
        }),
      }),
    );
    const externalPort = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest,
      authorizer: { assertAuthorized: vi.fn() },
      diagnosticSink: (event) => diagnostics.push(event),
    })(externalPort.value);

    externalPort.send(request());
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual({ type: 'end', requestId: 'request-1' }),
    );
    externalPort.send({ type: 'end-ack', requestId: 'request-other' });
    externalPort.send({ type: 'end-ack', requestId: 'request-1', unexpected: true });
    expect(externalPort.disconnect).not.toHaveBeenCalled();
    externalPort.send({ type: 'end-ack', requestId: 'request-1' });
    expect(externalPort.disconnect).toHaveBeenCalledOnce();
    expect(externalPort.listenerCount()).toBe(0);

    expect(fetchRequest).toHaveBeenCalledWith(
      CODEX_RESPONSES_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer private-access-token',
          'ChatGPT-Account-ID': 'account-test',
          originator: 'loom_extension_experiment',
          'session-id': 'session-1',
          'thread-id': 'thread-1',
        }),
      }),
    );
    const sentBody = JSON.parse(vi.mocked(fetchRequest).mock.calls[0]?.[1].body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(sentBody).toMatchObject({
      prompt_cache_key: 'session-1',
      client_metadata: { session_id: 'session-1', thread_id: 'thread-1' },
    });
    expect(JSON.stringify(externalPort.messages)).not.toContain('private-access-token');
    expect(JSON.stringify(diagnostics)).not.toContain('private-access-token');
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'request.validated', stage: 'validation' }),
        expect.objectContaining({ event: 'access-token.available', stage: 'authentication' }),
        expect.objectContaining({
          event: 'provider.fetch.started',
          stage: 'provider',
          method: 'POST',
          targetHost: 'chatgpt.com',
          targetPath: '/backend-api/codex/responses',
          model: 'gpt-test',
        }),
        expect.objectContaining({
          event: 'provider.response.completed',
          stage: 'stream',
          chunks: 2,
        }),
      ]),
    );
    expect(externalPort.messages).toContainEqual({
      type: 'start',
      requestId: 'request-1',
      status: 200,
    });
  });

  it('rejects unauthorized ports without contacting the provider', async () => {
    const fetchRequest = vi.fn<CodexModelFetch>();
    const externalPort = port();
    const authorizer: OriginAuthorizer = {
      assertAuthorized: vi.fn(() => {
        throw new Error('unauthorized');
      }),
    };
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest,
      authorizer,
    })(externalPort.value);

    externalPort.send(request());
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual({
        type: 'error',
        requestId: 'invalid-request',
        code: 'UNAUTHORIZED_ORIGIN',
        stage: 'authorization',
        message: 'Experimental Codex model transport failed.',
      }),
    );
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('validates Responses Lite input items and injects only its extension-owned header', async () => {
    const encoder = new TextEncoder();
    const fetchRequest = vi.fn<CodexModelFetch>(() =>
      Promise.resolve({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
            controller.close();
          },
        }),
      }),
    );
    const externalPort = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest,
      authorizer: { assertAuthorized: vi.fn() },
    })(externalPort.value);

    externalPort.send(request('responses-lite'));
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual({ type: 'end', requestId: 'request-1' }),
    );
    externalPort.send({ type: 'end-ack', requestId: 'request-1' });
    expect(fetchRequest).toHaveBeenCalledWith(
      CODEX_RESPONSES_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-openai-internal-codex-responses-lite': 'true',
        }),
      }),
    );
  });

  it('uses the isolated compact endpoint and a bounded JSON response stream', async () => {
    const encoder = new TextEncoder();
    const fetchRequest = vi.fn<CodexModelFetch>(() =>
      Promise.resolve({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                '{"output":[{"type":"compaction","encrypted_content":"replacement"}]}',
              ),
            );
            controller.close();
          },
        }),
      }),
    );
    const externalPort = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest,
      authorizer: { assertAuthorized: vi.fn() },
    })(externalPort.value);

    externalPort.send(compactRequest());
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual({
        type: 'end',
        requestId: 'request-compact',
      }),
    );
    externalPort.send({ type: 'end-ack', requestId: 'request-compact' });
    expect(fetchRequest).toHaveBeenCalledWith(
      CODEX_RESPONSES_COMPACT_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
    const sentBody = JSON.parse(vi.mocked(fetchRequest).mock.calls[0]?.[1].body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(sentBody).toMatchObject({ prompt_cache_key: 'session-1' });
    expect(sentBody).not.toHaveProperty('client_metadata');
    expect(externalPort.messages).toContainEqual({
      type: 'chunk',
      requestId: 'request-compact',
      chunk: '{"output":[{"type":"compaction","encrypted_content":"replacement"}]}',
    });
  });

  it('reports only sanitized provider metadata and Retry-After for rejected HTTP responses', async () => {
    const diagnostics: CodexModelDiagnosticEvent[] = [];
    const encoder = new TextEncoder();
    const externalPort = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest: vi.fn<CodexModelFetch>(() =>
        Promise.resolve({
          status: 429,
          headers: {
            get(name) {
              return name.toLowerCase() === 'retry-after' ? '15' : null;
            },
          },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    error: {
                      message: 'Rate limit reached for API key sk-private-secret.',
                      code: 'rate_limit_exceeded',
                      type: 'invalid_request_error',
                      param: 'model',
                    },
                  }),
                ),
              );
              controller.close();
            },
          }),
        }),
      ),
      authorizer: { assertAuthorized: vi.fn() },
      diagnosticSink: (event) => diagnostics.push(event),
    })(externalPort.value);

    externalPort.send(request());
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual({ type: 'end', requestId: 'request-1' }),
    );
    externalPort.send({ type: 'end-ack', requestId: 'request-1' });

    expect(externalPort.messages).toContainEqual({
      type: 'provider-error',
      requestId: 'request-1',
      status: 429,
      providerCode: 'rate_limit_exceeded',
      providerMessage: 'Rate limit reached for API key [REDACTED].',
      retryable: true,
      retryAfterMs: 15_000,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        event: 'provider.response.rejected',
        providerCode: 'rate_limit_exceeded',
        providerMessage: 'Rate limit reached for API key [REDACTED].',
        retryable: true,
        retryAfterMs: 15_000,
      }),
    );
    expect(JSON.stringify(externalPort.messages)).not.toContain('sk-private-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('sk-private-secret');
  });

  it('bounds cleanup when an older companion does not acknowledge a completed response', async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: CodexModelDiagnosticEvent[] = [];
      const encoder = new TextEncoder();
      const externalPort = port();
      createCodexModelPortListener({
        providerId: 'openai/codex-experimental',
        tokenService: tokenService(),
        accountRoutingStore: routingStore(),
        fetchRequest: vi.fn<CodexModelFetch>(() =>
          Promise.resolve({
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
                controller.close();
              },
            }),
          }),
        ),
        authorizer: { assertAuthorized: vi.fn() },
        diagnosticSink: (event) => diagnostics.push(event),
      })(externalPort.value);

      externalPort.send(request());
      await waitForMessage(externalPort.messages, { type: 'end', requestId: 'request-1' });
      expect(externalPort.disconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(CODEX_MODEL_END_ACK_TIMEOUT_MS - 1);
      expect(externalPort.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(externalPort.disconnect).toHaveBeenCalledOnce();
      expect(externalPort.listenerCount()).toBe(0);
      expect(
        diagnostics.filter((event) => event.event === 'provider.response.completed'),
      ).toHaveLength(1);
      externalPort.send({ type: 'end-ack', requestId: 'request-1' });
      expect(externalPort.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up provider-fetch failures once without waiting for an acknowledgement', async () => {
    const diagnostics: CodexModelDiagnosticEvent[] = [];
    const externalPort = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest: vi.fn<CodexModelFetch>(() => Promise.reject(new Error('provider unavailable'))),
      authorizer: { assertAuthorized: vi.fn() },
      diagnosticSink: (event) => diagnostics.push(event),
    })(externalPort.value);

    externalPort.send(request());
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual(
        expect.objectContaining({ type: 'error', requestId: 'request-1' }),
      ),
    );

    expect(externalPort.disconnect).toHaveBeenCalledOnce();
    expect(externalPort.listenerCount()).toBe(0);
    expect(diagnostics.filter((event) => event.event === 'request.failed')).toHaveLength(1);
  });

  it('aborts provider work and cleans up once when the caller disconnects', async () => {
    const diagnostics: CodexModelDiagnosticEvent[] = [];
    let providerSignal: AbortSignal | undefined;
    const externalPort = port();
    const fetchRequest = vi.fn<CodexModelFetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          providerSignal = init.signal;
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest,
      authorizer: { assertAuthorized: vi.fn() },
      diagnosticSink: (event) => diagnostics.push(event),
    })(externalPort.value);

    externalPort.send(request());
    await vi.waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce());
    externalPort.disconnectExternally();
    externalPort.disconnectExternally();
    await vi.waitFor(() =>
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ event: 'request.failed', code: 'CANCELLED' }),
      ),
    );

    expect(providerSignal?.aborted).toBe(true);
    expect(externalPort.disconnect).not.toHaveBeenCalled();
    expect(externalPort.listenerCount()).toBe(0);
    expect(diagnostics.filter((event) => event.event === 'port.disconnected')).toHaveLength(1);
    expect(diagnostics.filter((event) => event.event === 'request.failed')).toHaveLength(1);
  });

  it('rejects bodies that could retain a provider response', async () => {
    const fetchRequest = vi.fn<CodexModelFetch>();
    const externalPort = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: routingStore(),
      fetchRequest,
      authorizer: { assertAuthorized: vi.fn() },
    })(externalPort.value);

    externalPort.send({
      ...request(),
      body: JSON.stringify({
        model: 'gpt-test',
        instructions: '',
        input: [],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        stream: true,
        store: true,
        include: ['reasoning.encrypted_content'],
      }),
    });
    await vi.waitFor(() => expect(externalPort.messages).toHaveLength(1));
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(externalPort.messages[0]).toMatchObject({
      type: 'error',
      code: 'INVALID_REQUEST',
      stage: 'validation',
    });
  });

  it('reports missing routing and refresh failures without exposing sensitive values', async () => {
    const missingRouting = port();
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: tokenService(),
      accountRoutingStore: { ...routingStore(), get: vi.fn(() => Promise.resolve(undefined)) },
      fetchRequest: vi.fn<CodexModelFetch>(),
      authorizer: { assertAuthorized: vi.fn() },
    })(missingRouting.value);
    missingRouting.send(request());
    await vi.waitFor(() =>
      expect(missingRouting.messages).toContainEqual(
        expect.objectContaining({
          type: 'error',
          code: 'ACCOUNT_ROUTING_UNAVAILABLE',
          stage: 'routing',
        }),
      ),
    );

    const refreshFailure = port();
    const failingTokens = tokenService();
    vi.mocked(failingTokens.getAccessToken).mockRejectedValue(new Error('secret refresh detail'));
    createCodexModelPortListener({
      providerId: 'openai/codex-experimental',
      tokenService: failingTokens,
      accountRoutingStore: routingStore(),
      fetchRequest: vi.fn<CodexModelFetch>(),
      authorizer: { assertAuthorized: vi.fn() },
    })(refreshFailure.value);
    refreshFailure.send(request());
    await vi.waitFor(() =>
      expect(refreshFailure.messages).toContainEqual(
        expect.objectContaining({
          type: 'error',
          code: 'AUTHENTICATION_FAILED',
          stage: 'authentication',
        }),
      ),
    );
    expect(JSON.stringify(refreshFailure.messages)).not.toContain('secret refresh detail');
  });
});
