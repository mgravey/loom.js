import {
  ExtensionBrokerError,
  messageSenderOrigin,
  type ChromeMessageSender,
  type OriginAuthorizer,
} from '@loom/extension';

export const ALL_HTTPS_EXTERNALLY_CONNECTABLE_MATCH = 'https://*/*' as const;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    (value as unknown[]).every((entry): entry is string => typeof entry === 'string')
  );
}

function manifestMatches(manifest: unknown): readonly string[] {
  const matches = record(record(manifest)?.externally_connectable)?.matches;
  if (!isStringArray(matches) || matches.length === 0) {
    throw new Error('The extension manifest has no valid externally connectable match patterns.');
  }
  return matches;
}

function exactOriginFromMatch(match: string): string {
  if (!match.endsWith('/*')) {
    throw new Error('Externally connectable matches must end in /*.');
  }
  const value = match.slice(0, -2);
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.hostname.includes('*') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Externally connectable matches must use exact HTTP(S) origins.');
  }
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    // Chrome match patterns cannot encode ports. The unpacked manifest intentionally maps the
    // two loopback host patterns to the repository's fixed development server port.
    return `${url.origin}:4173`;
  }
  return url.origin;
}

/** Derives the runtime allowlist from the same exact origins Chrome enforces in the manifest. */
export function externallyConnectableOrigins(manifest: unknown): readonly string[] {
  const origins = manifestMatches(manifest).map(exactOriginFromMatch);
  return Object.freeze([...new Set(origins)]);
}

/**
 * Recreates the manifest's routing policy at the service-worker boundary. The broad HTTPS routing
 * pattern only permits an origin to request approval; privileged operations still pass through the
 * separate exact-origin grant authorizer.
 */
export function createExternallyConnectableAuthorizer(manifest: unknown): OriginAuthorizer {
  const matches = manifestMatches(manifest);
  const allowAllHttps = matches.includes(ALL_HTTPS_EXTERNALLY_CONNECTABLE_MATCH);
  const exactOrigins = new Set(
    matches
      .filter((match) => match !== ALL_HTTPS_EXTERNALLY_CONNECTABLE_MATCH)
      .map(exactOriginFromMatch),
  );

  return Object.freeze({
    assertAuthorized(sender: ChromeMessageSender): void {
      const origin = messageSenderOrigin(sender);
      if (
        origin !== undefined &&
        ((allowAllHttps && new URL(origin).protocol === 'https:') || exactOrigins.has(origin))
      ) {
        return;
      }
      throw new ExtensionBrokerError(
        'UNAUTHORIZED_ORIGIN',
        'The requesting application origin is not authorized by the extension manifest.',
      );
    },
  });
}
