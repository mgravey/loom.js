import { describe, expect, it } from 'vitest';

import {
  createExternallyConnectableAuthorizer,
  externallyConnectableOrigins,
} from '../src/manifest-origins.js';

describe('externallyConnectableOrigins', () => {
  it('derives the runtime allowlist from the packaged manifest', () => {
    expect(
      externallyConnectableOrigins({
        externally_connectable: { matches: ['https://loom.example/*'] },
      }),
    ).toEqual(['https://loom.example']);
  });

  it('maps Chrome loopback host patterns to the fixed development port', () => {
    expect(
      externallyConnectableOrigins({
        externally_connectable: {
          matches: ['http://localhost/*', 'http://127.0.0.1/*'],
        },
      }),
    ).toEqual(['http://localhost:4173', 'http://127.0.0.1:4173']);
  });

  it('routes every HTTPS origin to the exact-origin approval gate', () => {
    const authorizer = createExternallyConnectableAuthorizer({
      externally_connectable: {
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
      },
    });

    expect(() =>
      authorizer.assertAuthorized({
        origin: 'https://first.example',
        url: 'https://first.example/workbench',
      }),
    ).not.toThrow();
    expect(() =>
      authorizer.assertAuthorized({
        origin: 'https://another.example:8443',
        url: 'https://another.example:8443/',
      }),
    ).not.toThrow();
    expect(() =>
      authorizer.assertAuthorized({
        origin: 'http://localhost:4173',
        url: 'http://localhost:4173/workbench.html',
      }),
    ).not.toThrow();
  });

  it('does not route arbitrary HTTP, the wrong local port, or inconsistent senders', () => {
    const authorizer = createExternallyConnectableAuthorizer({
      externally_connectable: {
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
      },
    });

    for (const sender of [
      { origin: 'http://insecure.example', url: 'http://insecure.example/' },
      { origin: 'http://localhost:9999', url: 'http://localhost:9999/' },
      { origin: 'https://first.example', url: 'https://different.example/' },
      { origin: 'null' },
    ]) {
      expect(() => authorizer.assertAuthorized(sender)).toThrowError(
        expect.objectContaining({ code: 'UNAUTHORIZED_ORIGIN' }),
      );
    }
  });

  it.each([
    undefined,
    { externally_connectable: { matches: [] } },
    { externally_connectable: { matches: ['https://*/*'] } },
    { externally_connectable: { matches: ['https://*.example/*'] } },
    { externally_connectable: { matches: ['https://loom.example/path/*'] } },
  ])('rejects missing, wildcard, or non-origin matches', (manifest) => {
    expect(() => externallyConnectableOrigins(manifest)).toThrow();
  });
});
