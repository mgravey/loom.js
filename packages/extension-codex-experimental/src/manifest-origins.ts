function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Derives the runtime allowlist from the same exact origins Chrome enforces in the manifest. */
export function externallyConnectableOrigins(manifest: unknown): readonly string[] {
  const matches = record(record(manifest)?.externally_connectable)?.matches;
  if (!Array.isArray(matches) || matches.length === 0) {
    throw new Error('The extension manifest has no externally connectable application origin.');
  }
  const origins = matches.map((match) => {
    if (typeof match !== 'string' || !match.endsWith('/*')) {
      throw new Error('Externally connectable matches must be exact HTTP(S) origins ending in /*.');
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
  });
  return Object.freeze([...new Set(origins)]);
}
