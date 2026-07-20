# Chrome Web Store submission dossier

- Status: **technical draft package ready; external release blockers remain**
- Prepared: 20 July 2026

Target package: `@loom/extension-codex-experimental` / **Loom.js Companion**

This dossier is the engineering, privacy, listing, testing, and reviewer handoff for a future Chrome
Web Store submission. It follows the official requirements reviewed on 20 July 2026. Chrome policy
and applicable law can change; re-audit the linked sources immediately before every submission.

## 1. Hard release blockers

Do not upload for public review until every item is resolved.

- [ ] Obtain a supported provider/client-registration path or written confirmation that this
      third-party extension may use the current ChatGPT/Codex authentication and inference
      contracts. The current paths are audited compatibility behavior, not a documented public
      OpenAI OAuth product.
- [x] Confirm the publishing person (`Mathieu Gravey`) and privacy contact.
- [ ] Confirm the software license and any jurisdiction-specific legal-notice requirements.
- [ ] Replace the remaining publisher/address `REPLACE_*` values in
      `packages/example-codex-experimental/deployment-config.js`.
- [ ] Have qualified counsel review privacy, terms, legal notice/imprint, consumer, data-transfer,
      and target-country obligations.
- [x] Configure support and security mail as `sideproject@mgravey.com` in the site, bundled
      disclosure, packaging metadata, and release instructions.
- [ ] Verify `sideproject@mgravey.com`, confirm the inherited `https://mgravey.com/loom.js/` Pages
      deployment is live over HTTPS, and complete publisher contact details in the Developer
      Dashboard.
- [ ] Complete a live end-to-end test with the release provider account and production origin.
- [x] Record the assigned Chrome Web Store extension ID (`gdcebopdllcifgleoefgbobdopiaholg`) and
      make it the website production default.
- [x] Produce the required 440×280 promotional image and one 1280×800 real extension screenshot.
- [ ] Manually review the generated media and upload it with the listing copy.
- [ ] Decide distribution: trusted testers/unlisted first is recommended; public only after the
      compatibility and legal blockers are closed.
- [ ] Confirm that the default session-only authorization and the separately confirmed
      private-computer persistence option meet the product requirement and Store disclosures.

Store packaging, privacy pages, and this dossier are readiness infrastructure. They do not resolve
the unsupported provider contract.

## 2. Proposed single purpose

Use this in the Developer Dashboard **Single purpose** field:

> Authenticate a user-initiated Loom coding session and provide its authorized workbench with a
> short-lived credential for a direct-first model request, with an extension relay only when the
> browser receives no HTTP response.

Every feature must remain subordinate to that purpose:

- explicit browser or device-code authentication;
- refresh and account-routing state inside extension storage;
- exact callback transformation;
- short-lived direct-auth delivery to the authorized Loom origin;
- origin-authorized model relay after a direct pre-response failure;
- status and logout; and
- secret-safe diagnostics.

Do not add unrelated browsing, content injection, advertising, analytics, general tab management, or
website automation.

## 3. Draft Store listing

### Name

`Loom.js Companion`

The name is neutral and does not suggest that Google or OpenAI publishes or endorses the extension.

### Manifest summary (132-character maximum)

`Authenticates Loom sessions and relays model requests only when direct browser access fails.`

### Category

Start with **Developer Tools** if available for the target listing; otherwise use the closest
productivity/developer category shown by the current dashboard.

### Detailed description

> Loom.js Companion connects the Loom.js browser coding workbench to a user-initiated ChatGPT
> sign-in while keeping long-lived authorization inside the extension.
>
> After you explicitly enable the extension and sign in, authorization is stored in trusted
> extension session storage until Chrome exits. On a private computer, you can separately choose to
> remember the sign-in on that Chrome profile.
>
> The extension lets you: • approve each workbench website by its exact origin; • check
> authentication status and sign out; • provide a short-lived access token and account-routing ID to
> an approved workbench; and • relay a model request only when the browser's direct request fails
> before receiving an HTTP response.
>
> Any HTTPS website can request to appear in the extension's approval list, but authentication and
> model operations remain blocked until you approve that exact origin from the trusted extension
> options page. Local HTTP access is restricted to the Loom.js development server.
>
> Loom.js Companion does not inspect unrelated tabs, browsing history, cookies, or page content. It
> contains no advertising or developer analytics. Refresh and ID credentials are not exposed to
> websites, project files, OPFS, QuickJS, WebContainer, or Pyodide.
>
> The approved Loom.js workbench sends prompts, selected project context, tool results,
> account-routing metadata, and short-lived provider authentication to OpenAI/ChatGPT only to
> produce the response you request.
>
> This is an experimental, independently developed integration. It is not affiliated with, endorsed
> by, or supported by Google or OpenAI. Provider account eligibility, availability, and terms still
> apply.

Do not call the integration “official,” “supported by OpenAI,” or “the Codex extension” unless the
relevant trademark owner has explicitly approved that representation.

## 4. Dashboard privacy answers

These answers must match the final code and public privacy policy exactly.

### Permissions justifications

| Dashboard permission/host                 | Reviewer justification                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                 | Stores explicit enablement, persistence preference, and user-approved exact origins in trusted local extension storage. Refresh/routing state uses trusted session storage by default and moves locally only after explicit confirmation. Pending login/origin requests remain session-only. The website cannot read either storage area.                |
| `declarativeNetRequest`                   | Creates one session rule scoped to the user-initiated login tab. It transforms only `http://localhost:1455/auth/callback` into the packaged callback and is removed after a completed callback, handled failure, retry, logout, disable, or browser shutdown.                                                                                            |
| `http://localhost:1455/*`                 | Required solely for the registered provider loopback callback. The rule intercepts the main-frame navigation before a localhost server is contacted.                                                                                                                                                                                                     |
| `https://auth.openai.com/*`               | Required for user-initiated authorization/device flows and token refresh.                                                                                                                                                                                                                                                                                |
| `https://chatgpt.com/backend-api/codex/*` | Required only for direct-first fallback. The extension contacts this path after the browser receives no HTTP response and streams the result back to the approved origin.                                                                                                                                                                                |
| `externally_connectable` HTTPS routing    | Routes HTTPS connection requests to the extension's approval gate. Before approval, only a validated origin-access request is accepted; credential, status, logout, direct-auth, and model-relay operations require the separately stored exact-origin grant. The HTTP entries are restricted by the service worker to the fixed local development port. |
| web-accessible `callback.html`            | The exact authentication callback transformation must reach the packaged callback page. No executable remote resource is loaded.                                                                                                                                                                                                                         |

### Remote code

Select **No, I am not using remote code**, but revalidate the submitted ZIP first.

- all extension JavaScript is bundled inside the package;
- no extension page includes an HTTP(S) script URL;
- no `eval`, `new Function`, or downloaded interpreter logic is used;
- HTTPS authorization/model responses are data, not executable extension logic; and
- browser workbench QuickJS/WebContainer/Pyodide runtimes are website code, not packaged extension
  code and have no extension API access.

### Data categories to disclose

Evaluate and disclose every applicable dashboard category, including:

- authentication information;
- account identifiers / personally identifiable information used for provider routing;
- website or project content included in prompts and tool results;
- personal communications if user conversations can contain them; and
- user-generated content.

Do not claim “no user data” merely because the credential is stored locally. Google treats login and
locally processed data as handled data.

### Data-use certifications

Certify only after verifying the final build:

- data is used only for the disclosed single purpose;
- data is not sold or transferred for advertising, credit, or unrelated purposes;
- human access is not permitted except with specific consent, security necessity, or legal duty;
- user data is transmitted over HTTPS;
- the public policy and in-product disclosure match the behavior; and
- the dedicated public policy contains the Chrome Web Store Limited Use affirmation.

## 5. Public URLs and legal package

Required before submission:

| Purpose              | Target                                     |
| -------------------- | ------------------------------------------ |
| Homepage             | `https://mgravey.com/loom.js/`             |
| Privacy policy       | `https://mgravey.com/loom.js/privacy.html` |
| Support              | `https://mgravey.com/loom.js/support.html` |
| Terms                | `https://mgravey.com/loom.js/terms.html`   |
| Legal notice/imprint | `https://mgravey.com/loom.js/legal.html`   |

The privacy policy in `packages/example-codex-experimental/` identifies Mathieu Gravey as publisher
and uses `sideproject@mgravey.com` for privacy and security contact. It intentionally discloses that
no user data is sent to publisher-operated servers. The separate terms and legal notice retain draft
warnings pending jurisdiction-specific review.

The privacy policy must describe collection, use, sharing/recipients, storage, retention, deletion,
security, user choices, applicable rights, international/provider processing, children, changes, and
contact. The options page also contains the prominent pre-enable disclosure required for handled
authentication and user content.

## 6. Store image inventory

Official Store guidance currently requires an icon, small promotional image, and at least one
screenshot.

- [x] Packaged icons: 16×16, 32×32, 48×48, and 128×128 PNG. A compact square crop shortens the long
      input tails so the weave and endpoint rings use substantially more vertical space, including
      almost the full 16px toolbar canvas. The options page uses the full self-contained Lottie
      weave in its heading, as does the bundled privacy page. Both retain the compact 128px asset as
      their reduced-motion and rendering fallback.
- [x] Required small promotional image: `store-listing/promo-small-440x280.png`, brand-led and
      readable when reduced.
- [x] Required real-experience screenshot: `store-listing/screenshot-options-1280x800.png`, full
      bleed at 1280×800.
- [ ] Optional marquee image: 1400×560 for future featuring.

Recommended screenshots:

1. Extension options showing the disclosure, disabled-by-default state, sign-in choices, and no
   secrets.
2. Workbench authentication status plus workspace modes.
3. A completed model/tool turn with sanitized event output.
4. Privacy/support pages and logout/data-deletion control.

Never include a real account ID, email, token, authorization code, private project, extension debug
log, or provider response body in listing media.

## 7. Reviewer test instructions

Draft text for the **Test instructions** tab:

> 1. Install the extension and open Extension options.
> 2. Confirm authentication is disabled and no credential exists.
> 3. Read the disclosure, enable the bridge, and select the supplied test authentication method.
>    Optionally test “Remember sign-in on this Chrome profile” only in the dedicated review profile.
> 4. Open the production Loom workbench URL supplied below.
> 5. Confirm the preconfigured Store extension ID. The page checks it automatically; select
>    Reconnect only if needed.
> 6. Approve the exact production origin in extension options, return, and reload the workbench.
> 7. Open/import the provided non-sensitive fixture project.
> 8. Submit the supplied test prompt and confirm a streamed response and compact workspace list/read
>    activity rows.
> 9. Return to options, select Remove stored authorization, and confirm the website reports that
>    authentication is required.
>
> The extension does not alter unrelated pages. The localhost callback is transformed by a temporary
> exact tab-scoped DNR rule; no localhost server is required.

Before submission, provide a dedicated test account or provider-approved review method that does not
expose a personal credential. Never place secrets in this repository or listing description.

## 8. Build the submitted ZIP

```sh
pnpm chrome:store:release
```

The Store assigned `gdcebopdllcifgleoefgbobdopiaholg`. The public site configuration now defaults to
that ID; `LOOM_CHROME_EXTENSION_ID` remains an override for a different Store item.

The defaults configure the `https://mgravey.com` external origin, `/loom.js/` homepage, public
privacy/support links, `sideproject@mgravey.com`, and submission metadata. Environment variables can
override them for another deployment. `LOOM_CHROME_EXTENSION_ID` is metadata-only; the extension
does not need to know its own assigned ID. The companion website attempts the configured Store
extension automatically when its workbench loads.

The ZIP is written under ignored `store-artifacts/` with `manifest.json` at its root. Inspect its
contents manually:

```sh
unzip -l store-artifacts/loom-js-companion-*.zip
shasum -a 256 -c store-artifacts/loom-js-companion-*.zip.sha256
```

Confirm:

- [ ] only runtime HTML/JS, icons, privacy disclosure, third-party license notices, and manifest are
      present;
- [ ] `externally_connectable.matches` contains only broad HTTPS routing and the two reviewed local
      development host patterns;
- [ ] required localhost/auth/model host permissions are unchanged;
- [ ] no source maps, declarations, `.tsbuildinfo`, test files, credentials, or private keys exist;
- [ ] manifest name, description, version, icons, and minimum Chrome version are correct; and
- [ ] a clean Chrome profile can complete reviewer instructions.

The packager performs the structural checks above, normalizes ZIP timestamps, validates icon
dimensions, rejects reserved/test hostnames, scans for unresolved placeholders and common remote
code signals, checks the final archive inventory, and writes a SHA-256 digest. The separate media
step renders exact-size PNGs and records their provenance and hashes in
`packages/extension-codex-experimental/store-listing/media-manifest.json`.

## 9. Submission sequence

1. Enable 2-Step Verification on the publisher account and verify contact emails.
2. Register/set up the Chrome Web Store developer account.
3. Close every hard blocker in section 1.
4. Deploy the final HTTPS website and legal/support pages.
5. Generate and inspect the first production-origin ZIP.
6. Upload as a new draft to allocate the permanent extension ID.
7. Update the website deployment configuration and Store URL.
8. Rebuild/re-upload if the package or manifest must change; increment the version.
9. Complete Store Listing, Privacy, Distribution, and Test Instructions tabs.
10. Begin with trusted testers or unlisted distribution and deferred publication.
11. Perform a Store-installed production smoke test.
12. Submit for review. Monitor the verified publisher email and answer reviewer questions promptly.
13. After approval, publish within the current staged-publication window and monitor support,
    authentication failures, policy updates, and provider contract changes.

## 10. Pre-submission verification gate

```sh
pnpm check
```

Additionally:

- [ ] Chrome Web Store packager succeeds with final URLs;
- [ ] real sign-in and model streaming succeed in the release profile;
- [ ] logout, disable, token rejection, callback expiry, and uninstall deletion are verified;
- [ ] no secrets appear in page/extension logs or Store media;
- [ ] legal, privacy, dashboard disclosures, listing, and actual code agree;
- [ ] permission set has been re-reviewed for minimum access;
- [ ] remote-code scan and manual bundle inspection pass; and
- [ ] provider authorization remains valid on submission day.

## Official references

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)
- [Fill out privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Supplying images](https://developer.chrome.com/docs/webstore/images)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Manifest key and development IDs](https://developer.chrome.com/docs/apps/manifest/key)

This dossier is an engineering checklist, not legal advice.
