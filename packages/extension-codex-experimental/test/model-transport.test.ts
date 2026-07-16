import type { ExtensionTokenService, OriginAuthorizer } from '@loom/extension';
import { describe, expect, it, vi } from 'vitest';

import type { CodexAccountRoutingStore } from '../src/account-routing.js';
import type { CodexExternalPort, CodexModelFetch } from '../src/chrome-contracts.js';
import {
  CODEX_MODEL_PORT_NAME,
  CODEX_MODEL_TRANSPORT_PROTOCOL,
  CODEX_MODEL_TRANSPORT_VERSION,
  CODEX_RESPONSES_ENDPOINT,
  createCodexModelPortListener,
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
  send(message: unknown): void;
} {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const messages: unknown[] = [];
  return {
    messages,
    value: {
      name: CODEX_MODEL_PORT_NAME,
      sender: { origin: 'http://localhost:4173', url: 'http://localhost:4173/app' },
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
      postMessage: (message) => messages.push(message),
      disconnect: () => undefined,
    },
    send(message) {
      for (const listener of messageListeners) listener(message);
    },
  };
}

function request(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: 'generate',
    requestId: 'request-1',
    sessionId: 'session-1',
    threadId: 'thread-1',
    body: JSON.stringify({
      model: 'gpt-test',
      instructions: 'Use tools when needed.',
      input: [],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
    }),
  });
}

describe('experimental Codex extension model transport', () => {
  it('keeps credentials extension-side and streams provider bytes over an authorized port', async () => {
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
    })(externalPort.value);

    externalPort.send(request());
    await vi.waitFor(() =>
      expect(externalPort.messages).toContainEqual({ type: 'end', requestId: 'request-1' }),
    );

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
    expect(JSON.stringify(externalPort.messages)).not.toContain('private-access-token');
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
        code: 'MODEL_REQUEST_FAILED',
        message: 'Experimental Codex model transport failed.',
      }),
    );
    expect(fetchRequest).not.toHaveBeenCalled();
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
      code: 'MODEL_REQUEST_FAILED',
    });
  });
});
