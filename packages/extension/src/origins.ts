import type { ChromeMessageSender } from './chrome-contracts.js';
import { ExtensionBrokerError } from './contracts.js';

export interface OriginAuthorizer {
  assertAuthorized(sender: ChromeMessageSender): void | Promise<void>;
}

function parseOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

export function messageSenderOrigin(sender: ChromeMessageSender): string | undefined {
  const parsedDeclaredOrigin = sender.origin === undefined ? undefined : parseOrigin(sender.origin);
  const declaredOrigin = parsedDeclaredOrigin === sender.origin ? parsedDeclaredOrigin : undefined;
  const urlOrigin = sender.url === undefined ? undefined : parseOrigin(sender.url);
  if (
    (sender.origin !== undefined && declaredOrigin === undefined) ||
    (declaredOrigin !== undefined && urlOrigin !== undefined && declaredOrigin !== urlOrigin)
  ) {
    return undefined;
  }
  return declaredOrigin ?? urlOrigin;
}

function normalizeAllowedOrigin(value: string): string {
  const origin = parseOrigin(value);
  if (origin === undefined) throw new TypeError(`Invalid allowed origin "${value}".`);
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new TypeError(`Allowed origin must be an exact HTTP(S) origin: "${value}".`);
  }
  return origin;
}

export function createOriginAuthorizer(allowedOrigins: readonly string[]): OriginAuthorizer {
  if (allowedOrigins.length === 0) {
    throw new TypeError('At least one allowed application origin is required.');
  }
  const allowed = new Set(allowedOrigins.map(normalizeAllowedOrigin));

  return Object.freeze({
    assertAuthorized(sender: ChromeMessageSender): void {
      const origin = messageSenderOrigin(sender);
      if (origin === undefined || !allowed.has(origin)) {
        throw new ExtensionBrokerError(
          'UNAUTHORIZED_ORIGIN',
          'The requesting application origin is not authorized.',
        );
      }
    },
  });
}
