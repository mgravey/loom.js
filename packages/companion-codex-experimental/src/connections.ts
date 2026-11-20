import type { CreateCodexExtensionTransportOptions } from './contracts.js';
import { CodexCompanionError } from './errors.js';
import {
  LOOM_COMPANION_EXTENSION_ID,
  resolveIdentifier,
  resolveRuntime,
  isRecord,
} from './shared.js';

export interface ExtensionResponsesConnectionInfo {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
}
/** Checks a saved connection grant. Keys and private profile data never leave the extension. */
export function getExtensionResponsesConnection(
  options: CreateCodexExtensionTransportOptions & { readonly connectionId: string },
): Promise<ExtensionResponsesConnectionInfo> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(options.connectionId))
    throw new CodexCompanionError('INVALID_CONFIGURATION', 'Invalid Responses connection ID.');
  const runtime = resolveRuntime(options.runtime);
  const extensionId = resolveIdentifier(
    options.extensionId ?? LOOM_COMPANION_EXTENSION_ID,
    'extension ID',
  );
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new CodexCompanionError(
          'EXTENSION_REQUEST_FAILED',
          'Configure this connection and approve this website in Companion settings.',
        ),
      );
    const timer = setTimeout(fail, 10_000);
    try {
      runtime.sendMessage(
        extensionId,
        {
          protocol: 'loom/responses-connections',
          version: 1,
          type: 'get',
          connectionId: options.connectionId,
        },
        undefined,
        (value: unknown) => {
          clearTimeout(timer);
          if (
            runtime.lastError !== undefined ||
            !isRecord(value) ||
            value.ok !== true ||
            !isRecord(value.connection) ||
            value.connection.id !== options.connectionId ||
            typeof value.connection.label !== 'string' ||
            value.connection.label.length > 128 ||
            typeof value.connection.endpoint !== 'string' ||
            value.connection.endpoint.length > 2048
          ) {
            fail();
            return;
          }
          resolve(
            Object.freeze({
              id: options.connectionId,
              label: value.connection.label,
              endpoint: value.connection.endpoint,
            }),
          );
        },
      );
    } catch {
      clearTimeout(timer);
      fail();
    }
  });
}

export interface ExtensionResponsesModel {
  /** Stable, server-qualified selector value. The raw model is sent upstream. */
  readonly id: string;
  readonly model: string;
  readonly connectionId: string;
  readonly serverLabel: string;
}
export interface ExtensionResponsesModelCatalogue {
  readonly models: readonly ExtensionResponsesModel[];
  readonly unavailableConnections: readonly { readonly id: string; readonly label: string }[];
}

/** Discover every server approved for this website, without exposing endpoints or keys. */
export function listExtensionResponsesModels(
  options: CreateCodexExtensionTransportOptions,
): Promise<ExtensionResponsesModelCatalogue> {
  const runtime = resolveRuntime(options.runtime);
  const extensionId = resolveIdentifier(
    options.extensionId ?? LOOM_COMPANION_EXTENSION_ID,
    'extension ID',
  );
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new CodexCompanionError(
          'EXTENSION_REQUEST_FAILED',
          'Companion model discovery is unavailable. Check the extension and website grants.',
        ),
      );
    const timer = setTimeout(fail, 10_000);
    try {
      runtime.sendMessage(
        extensionId,
        { protocol: 'loom/responses-connections', version: 1, type: 'catalogue' },
        undefined,
        (value: unknown) => {
          clearTimeout(timer);
          if (
            runtime.lastError !== undefined ||
            !isRecord(value) ||
            value.ok !== true ||
            !Array.isArray(value.servers) ||
            value.servers.length > 32
          ) {
            fail();
            return;
          }
          const models: ExtensionResponsesModel[] = [];
          const unavailableConnections: { id: string; label: string }[] = [];
          const ids = new Set<string>();
          for (const server of value.servers as unknown[]) {
            if (
              !isRecord(server) ||
              typeof server.id !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,64}$/u.test(server.id) ||
              ids.has(server.id) ||
              typeof server.label !== 'string' ||
              server.label.length > 128 ||
              typeof server.unavailable !== 'boolean' ||
              !Array.isArray(server.models) ||
              server.models.length > 500
            ) {
              fail();
              return;
            }
            ids.add(server.id);
            if (server.unavailable) {
              unavailableConnections.push({ id: server.id, label: server.label });
              continue;
            }
            const seen = new Set<string>();
            for (const model of server.models as unknown[]) {
              if (typeof model !== 'string' || model.trim() === '' || model.length > 200) {
                fail();
                return;
              }
              if (seen.has(model)) continue;
              seen.add(model);
              models.push(
                Object.freeze({
                  id: `responses:${server.id}/${model}`,
                  model,
                  connectionId: server.id,
                  serverLabel: server.label,
                }),
              );
            }
          }
          resolve(
            Object.freeze({
              models: Object.freeze(models),
              unavailableConnections: Object.freeze(unavailableConnections),
            }),
          );
        },
      );
    } catch {
      clearTimeout(timer);
      fail();
    }
  });
}
