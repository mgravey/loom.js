# Loom.js Companion

This Manifest V3 extension authenticates a user-initiated Loom session. External messages can query
status or log out. A separate provider-specific message lets the exact authorized experimental
workbench request a short-lived access token and account-routing ID for direct non-auth provider
requests; refresh and ID tokens remain extension-only. A page must match the manifest and receive a
one-time exact-origin approval from trusted extension UI before any auth message is accepted. Model
requests are direct-first. A pre-response browser failure retries the credential-free request body
through the same origin-authorized extension, which then handles the prompt and response stream.
Rejected provider responses are reduced to a bounded code, sanitized 512-character message,
retryability classification, and a capped millisecond delay parsed from `Retry-After`; complete
bodies and response headers never cross the extension port.

After forwarding the complete response, the extension sends a request-scoped `end` and waits for a
strictly matching Companion `end-ack` before disconnecting the Port. A one-second fallback closes
the Port for compatibility with older Companion versions. Disconnect before `end` still cancels the
provider request; the fallback runs only after the response has already been delivered as complete.

The current Chrome extension release version is `0.2.0`.

It remains an unsupported ChatGPT/Codex compatibility experiment. Chrome Web Store packaging does
not make the provider integration supported or authorized. Do not submit it publicly until the
provider/client-registration blocker in `docs/chrome-web-store-submission.md` is resolved.

## Current development ID

The unpacked extension ID observed for this repository checkout on 20 July 2026 is:

```text
foofdcgdelahbdgdfgocoeajdodhjbjo
```

This value is prefilled in `packages/example-codex-experimental/deployment-config.js`. It is
development metadata, not a credential, and is separate from the assigned Chrome Web Store ID
`gdcebopdllcifgleoefgbobdopiaholg`.

Chrome can assign a different unpacked ID if the path, package, profile, or key changes. Always copy
the authoritative current value from `chrome://extensions`. The workbench field is editable and
remembers a valid ID locally.

## Build and install unpacked

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @mgravey/loom-extension-codex-experimental build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `packages/extension-codex-experimental/dist`.
5. Copy the extension ID shown by Chrome.
6. Open **Details → Extension options**.
7. Read the data disclosure, explicitly enable the bridge, and authenticate.

The manifest routes external messages from HTTPS websites to the service worker so a site can ask to
appear in **Waiting for approval**. That routing is not authorization: credential, status, logout,
and model-relay operations remain blocked until the user approves the sender's exact origin in
trusted extension UI. For local development, only `localhost:4173` and `127.0.0.1:4173` pass the
service-worker check. After rebuilding, select **Reload** on the extension card so Chrome applies
manifest changes.

Authorization uses trusted session storage by default and is lost when Chrome closes. On a private
computer, select **Remember sign-in on this Chrome profile** and confirm the warning to migrate the
refresh credential and account-routing ID to trusted local extension storage. The setting is tied to
the current Chrome profile, not a Loom website login or operating-system unlock. Turning it off
moves a current sign-in back to session storage; logout and disabling the bridge clear both areas.
Access tokens remain memory-only, ID tokens are not retained, and login transaction state always
remains session-only.

The build copies only local extension HTML, JavaScript, manifest, privacy disclosure, and icon
assets. The extension package contains no remotely hosted scripts, `eval`, or dynamic code loader.
Authentication HTTPS requests carry data; they do not supply executable extension logic.

The manifest icons use a compact square crop of the standalone Direction 08 Loom mark. Shortening
the long input tails lets the weave and endpoint rings occupy almost the full height of Chrome's
16px UI while preserving their proportions. The same colored artwork is declared as an enabled
toolbar action on every site. This is presentation only: it adds no page permission, content script,
or active-tab access. The options and bundled privacy-page headings play the full self-contained
Lottie weave once, then hold on its final frame. Reduced-motion preferences and rendering failures
retain the compact 128px PNG fallback.

## Connect the local workbench

```sh
pnpm build
python3 -m http.server 4173 --directory packages
```

Open:

```text
http://localhost:4173/example-codex-experimental/workbench.html
```

Enter the extension ID. The page checks it automatically; select **Reconnect** only when needed. The
extension opens its options page on first contact; approve the displayed exact origin, return to the
workbench, and reload. The approval is remembered in trusted local extension storage until revoked
or the bridge is disabled.

If the page logs `origin.access.request` but the extension logs no `message.received` event and no
origin appears under **Waiting for approval**, Chrome rejected the message before the service worker
received it. Rebuild the extension, reload it at `chrome://extensions`, confirm that
`dist/manifest.json` includes `https://*/*` under `externally_connectable.matches`, and retry using
the ID displayed on that same extension card.

The development ID is supplied in three descending-priority ways:

1. `?extensionId=<32-character-id>` query parameter;
2. the last valid ID stored by the site; or
3. `chromeExtensionId` in `deployment-config.js`.

No authentication credential is placed in any of those locations. On the production site only, the
configured Store ID replaces the known legacy unpacked ID retained by an earlier visit; deliberate
query-string and other manually stored IDs remain valid overrides.

## Production Store ID

The Chrome Web Store assigned `gdcebopdllcifgleoefgbobdopiaholg`. Production Pages artifacts use it
by default, and the workbench checks that extension automatically on load.

1. Override `LOOM_CHROME_EXTENSION_ID` only when building for another Store item.
2. Set `chromeWebStoreUrl` to
   `https://chromewebstore.google.com/detail/<listing-slug>/<extension-id>` after the listing URL is
   available.
3. Replace every legal/contact placeholder in `deployment-config.js`.
4. Deploy the website to its final HTTPS origin.
5. Build a production Store package for that exact origin.
6. Retest the Store-installed build before submitting or publishing.

Google recommends making application code insensitive to an extension manifest `key`. Loom follows
that model: internal extension pages use `chrome.runtime.getURL()`, while the separate website keeps
the install-specific extension ID in deployment configuration.

## Create the production Store release files

After <https://mgravey.com/loom.js/> is deployed, build the exact submission ZIP, checksum,
metadata, and mandatory listing media with:

```sh
pnpm chrome:store:release
```

The command defaults to the `https://mgravey.com` origin, `/loom.js` base path,
`https://mgravey.com/loom.js/privacy.html`, `https://mgravey.com/loom.js/support.html`, and
`sideproject@mgravey.com`. `LOOM_CHROME_EXTENSION_ID` may be omitted for the first draft upload. The
extension ID is recorded in submission metadata only because Chrome assigns and owns it; the
companion website's generated deployment configuration now defaults to the assigned Store ID.
Environment variables can override the defaults for another deployment. The release commands:

- require a real public HTTPS origin rather than localhost or reserved example domains;
- retain broad HTTPS message routing while enforcing the separately approved exact origin in the
  service worker;
- verify Manifest V3, description length, every declared icon dimension, and public contact links;
- excludes declarations, maps, build metadata, and library-only entrypoints;
- includes the required `lottie-web` MIT copyright and license notice;
- checks the runtime bundle for common dynamic-code primitives;
- writes a deterministic `store-artifacts/loom-js-companion-<version>.zip` with a root
  `manifest.json`, exact allowlisted inventory, SHA-256 file, and non-secret submission metadata;
  and
- renders the required 440×280 promotional image and a 1280×800 screenshot of the actual packaged
  options page under `store-listing/`.

Store media is uploaded separately and is intentionally excluded from the extension ZIP. Review the
ZIP inventory, checksum, promotional image, and screenshot before every dashboard upload.

## Permissions and hosts

| Declaration                               | Why it exists                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                 | Keep refresh/routing state in trusted session storage by default; persist it locally only after explicit private-computer confirmation. Store approved exact origins locally and pending login/origin requests only for the session. |
| `declarativeNetRequest`                   | Install one exact, temporary, tab-scoped redirect from the registered localhost OAuth callback to the extension callback page.                                                                                                       |
| `http://localhost:1455/*`                 | Match only the provider's registered loopback callback target. No localhost server is contacted.                                                                                                                                     |
| `https://auth.openai.com/*`               | User-initiated authorization, device-code exchange, and token refresh.                                                                                                                                                               |
| `https://chatgpt.com/backend-api/codex/*` | Direct-first fallback only: relay a model request when the page receives no HTTP response.                                                                                                                                           |
| `externally_connectable`                  | Let HTTPS websites request connection approval. The service worker separately requires the user-approved exact origin before auth or model operations; only the fixed local development origins are routed over HTTP.                |

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

The public templates use `sideproject@mgravey.com` for support and security. Publisher identity and
postal-address placeholders remain visible until the actual publisher and counsel approve them.

## Official Chrome references

- [Prepare an extension](https://developer.chrome.com/docs/webstore/prepare)
- [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Supplying images](https://developer.chrome.com/docs/webstore/images)
- [Publishing workflow](https://developer.chrome.com/docs/webstore/publish)
