# Loom Secure Model Bridge

This Manifest V3 extension has one purpose: authenticate a user-initiated Loom session and relay
that session's model requests without exposing provider credentials to the website. External
messages can query status or log out, but cannot request an access token.

It remains an unsupported ChatGPT/Codex compatibility experiment. Chrome Web Store packaging does
not make the provider integration supported or authorized. Do not submit it publicly until the
provider/client-registration blocker in `docs/chrome-web-store-submission.md` is resolved.

## Current development ID

The unpacked extension ID observed for this repository checkout on 18 July 2026 is:

```text
foofdcgdelahbdgdfgocoeajdodhjbjo
```

This value is prefilled in `packages/example-codex-experimental/deployment-config.js`. It is
development metadata, not a credential and not the future Chrome Web Store ID.

Chrome can assign a different unpacked ID if the path, package, profile, or key changes. Always copy
the authoritative current value from `chrome://extensions`. The workbench field is editable and
remembers a valid ID locally.

## Build and install unpacked

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @loom/extension-codex-experimental build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `packages/extension-codex-experimental/dist`.
5. Copy the extension ID shown by Chrome.
6. Open **Details → Extension options**.
7. Read the data disclosure, explicitly enable the bridge, and authenticate.

The build copies only local extension HTML, JavaScript, manifest, privacy disclosure, and icon
assets. The extension package contains no remotely hosted scripts, `eval`, or dynamic code loader.
Provider HTTPS requests carry data; they do not supply executable extension logic.

The manifest icons use a compact square crop of the standalone Direction 08 Loom mark. Shortening
the long input tails lets the weave and endpoint rings occupy almost the full height of Chrome's
16px UI while preserving their proportions. The options and bundled privacy-page headings play the
full self-contained Lottie weave once, then hold on its final frame. Reduced-motion preferences and
rendering failures retain the compact 128px PNG fallback.

## Connect the local workbench

```sh
pnpm build
python3 -m http.server 4173 --directory packages
```

Open:

```text
http://localhost:4173/example-codex-experimental/workbench.html
```

The development ID is supplied in three descending-priority ways:

1. `?extensionId=<32-character-id>` query parameter;
2. the last valid ID stored by the site; or
3. `chromeExtensionId` in `deployment-config.js`.

No authentication credential is placed in any of those locations.

## Switch to the permanent Store ID

The permanent ID becomes available after the first ZIP is uploaded as a Chrome Web Store draft; it
does not need to be publicly published first.

1. Upload the first draft package and copy the item/extension ID.
2. Update `chromeExtensionId` in `packages/example-codex-experimental/deployment-config.js`.
3. Set `chromeWebStoreUrl` to
   `https://chromewebstore.google.com/detail/<listing-slug>/<extension-id>` after the listing URL is
   available.
4. Replace every legal/contact placeholder in `deployment-config.js`.
5. Deploy the website to its final HTTPS origin.
6. Build a production Store package for that exact origin.
7. Retest the Store-installed build before submitting or publishing.

Google recommends making application code insensitive to an extension manifest `key`. Loom follows
that model: internal extension pages use `chrome.runtime.getURL()`, while the separate website keeps
the install-specific extension ID in deployment configuration.

## Create the production Store ZIP

Build with exact, public HTTPS URLs:

```sh
LOOM_SITE_ORIGIN=https://loom.example \
LOOM_PRIVACY_URL=https://loom.example/privacy.html \
LOOM_SUPPORT_URL=https://loom.example/support.html \
LOOM_CHROME_EXTENSION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
pnpm chrome:store:package
```

Replace every example value. `LOOM_CHROME_EXTENSION_ID` may be omitted for the first draft upload.
The site, privacy, and support values configure the packaged manifest/disclosure. The extension ID
is recorded in submission metadata only because Chrome assigns and owns that ID; the companion
website's `deployment-config.js` is the place that must consume it. The packager:

- requires HTTPS public URLs;
- replaces `externally_connectable.matches` with the exact production origin;
- verifies Manifest V3, description length, and the required 128px icon;
- excludes declarations, maps, build metadata, and library-only entrypoints;
- checks the runtime bundle for common dynamic-code primitives;
- writes `store-artifacts/loom-secure-model-bridge-<version>.zip`; and
- writes non-secret submission metadata beside the ZIP.

`manifest.json` is placed at the ZIP root as required by the Store.

## Permissions and hosts

| Declaration                               | Why it exists                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                 | Persist explicit opt-in locally; keep refresh, routing, and pending transaction state only in trusted session storage.         |
| `declarativeNetRequest`                   | Install one exact, temporary, tab-scoped redirect from the registered localhost OAuth callback to the extension callback page. |
| `http://localhost:1455/*`                 | Match only the provider's registered loopback callback target. No localhost server is contacted.                               |
| `https://auth.openai.com/*`               | User-initiated authorization, device-code exchange, and token refresh.                                                         |
| `https://chatgpt.com/backend-api/codex/*` | Relay the user-requested Codex model stream from the trusted extension boundary.                                               |
| `externally_connectable`                  | Accept the versioned broker/model protocol only from the exact development or production Loom website origin.                  |

The extension does not request `history`, `cookies`, `scripting`, `activeTab`, broad website access,
or background analytics.

## Publication documents

- `docs/chrome-web-store-submission.md` — submission dossier, draft listing, reviewer instructions,
  permission justifications, data disclosure, assets, blockers, and release checklist.
- `packages/example-codex-experimental/privacy.html` — public privacy-policy template.
- `packages/example-codex-experimental/terms.html` — public terms template.
- `packages/example-codex-experimental/legal.html` — publisher/imprint template.
- `packages/example-codex-experimental/support.html` — support and data-deletion instructions.
- `privacy.html` — disclosure bundled inside the extension.

All public legal templates contain visible placeholders and are intentionally not publication-ready
until the actual publisher and counsel approve them.

## Official Chrome references

- [Prepare an extension](https://developer.chrome.com/docs/webstore/prepare)
- [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Supplying images](https://developer.chrome.com/docs/webstore/images)
- [Publishing workflow](https://developer.chrome.com/docs/webstore/publish)
