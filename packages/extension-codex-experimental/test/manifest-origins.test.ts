import { describe, expect, it } from 'vitest';

import { externallyConnectableOrigins } from '../src/manifest-origins.js';

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

  it.each([
    undefined,
    { externally_connectable: { matches: [] } },
    { externally_connectable: { matches: ['https://*.example/*'] } },
    { externally_connectable: { matches: ['https://loom.example/path/*'] } },
  ])('rejects missing, wildcard, or non-origin matches', (manifest) => {
    expect(() => externallyConnectableOrigins(manifest)).toThrow();
  });
});
